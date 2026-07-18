"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { isNative } from "@/lib/capacitor/platform";
import { requestNativePushPermission, checkNativePushPermission } from "@/lib/native-push";
import { endLiveActivity, setLiveActivityEnabledCache } from "@/lib/native-live-activity";
import { getLiveUpdateState, setLiveUpdateOptIn, syncAndroidLockCardGate, type LiveUpdateState } from "@/lib/capacitor/game-notification";
import { retriggerLockScreenCard } from "@/lib/notifications/lock-card-retrigger";
import { PREF_LABELS, DEFAULT_PREFS, type NotificationPrefs, type PrefKey } from "@/lib/notifications/prefs";

/**
 * 알림 종류별 on/off 설정 카드 (push-notifications-v1 S2).
 * 네이티브 앱(iOS/Android)에서만 노출 — 웹 푸시 토글은 기존 NotificationCard(별도 게이팅).
 * 디폴트 전부 on(이닝 요약만 off)이라 row 없이도 토글 상태가 의미를 가짐.
 */
export default function NotificationPrefsCard() {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  // prefs 서버 조회 성공 여부 — loaded는 "시도 종료"라 401/5xx/예외에도 true가 된다.
  // 재노출 버튼은 서버 값 확인 성공 시에만 노출(fail-closed, 삼순 #680 재리뷰 blocker).
  const [prefsLoadedOk, setPrefsLoadedOk] = useState(false);
  // OS 푸시 권한 미허용 여부 — 기존 회원/재설치 유저 커버용 안내 배너 게이트.
  const [permissionDenied, setPermissionDenied] = useState(false);
  // 잠금화면 라이브 카드(Android 16+) — 디바이스 로컬 opt-in. supported:false면 행 자체를 숨김.
  const [liveUpdate, setLiveUpdate] = useState<LiveUpdateState>({ supported: false, enabled: false });
  const savingRef = useRef(false);

  const authHeader = useCallback(async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // 마운트 시 OS 권한 상태 확인 → 미허용이면 안내 배너 노출.
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    void (async () => {
      const granted = await checkNativePushPermission();
      if (!cancelled) setPermissionDenied(!granted);
    })();
    return () => { cancelled = true; };
  }, []);

  const enablePush = useCallback(async () => {
    const ok = await requestNativePushPermission();
    if (ok) setPermissionDenied(false);
  }, []);

  // 펼칠 때 잠금화면 라이브 카드 지원 여부 조회(네이티브 안드 16+만 supported:true).
  useEffect(() => {
    if (!expanded || !isNative) return;
    let cancelled = false;
    void (async () => {
      const state = await getLiveUpdateState();
      if (!cancelled) setLiveUpdate(state);
    })();
    return () => { cancelled = true; };
  }, [expanded]);

  // simple=true → Live Update(시스템 승격, 상단 우선 표시) opt-in / simple=false → 기존 디자인 카드(opt-out).
  const setLiveCardStyle = useCallback(async (simple: boolean) => {
    if (simple === liveUpdate.enabled) return;
    setLiveUpdate((s) => ({ ...s, enabled: simple }));
    await setLiveUpdateOptIn(simple);
  }, [liveUpdate.enabled]);

  // 잠금화면 카드 수동 재표시 (건의함 feedback:4369ee5a — 실수로 카드를 지운 유저 복구).
  // idle → working → done(요청 접수)/none(대상 경기 없음)/failed(설정·권한·네트워크 실패,
  // 삼순 #680 blocker②) — 4초 후 idle 복귀.
  const [retrigger, setRetrigger] = useState<"idle" | "working" | "done" | "none" | "failed">("idle");
  const retriggerCard = useCallback(async () => {
    if (retrigger === "working") return;
    setRetrigger("working");
    const result = await retriggerLockScreenCard();
    setRetrigger(result === "started" ? "done" : result === "none" ? "none" : "failed");
    setTimeout(() => setRetrigger("idle"), 4000);
  }, [retrigger]);

  useEffect(() => {
    if (!expanded || loaded) return;
    (async () => {
      try {
        const res = await fetch("/api/push/prefs", { headers: await authHeader() });
        if (res.ok) {
          const { prefs: saved } = await res.json();
          const merged = { ...DEFAULT_PREFS, ...saved };
          setPrefs(merged);
          // 클라 게이트 캐시를 서버 SSOT로 동기화 (start/update가 이 캐시로 판단).
          setLiveActivityEnabledCache(merged.live_activity !== false);
          // 안드 네이티브 잠금카드 게이트도 서버 SSOT로 미러(타 기기 변경/재설치 복원).
          void syncAndroidLockCardGate(merged.live_activity !== false);
          setPrefsLoadedOk(true);
        }
      } catch {
        // 디폴트 유지
      } finally {
        setLoaded(true);
      }
    })();
  }, [expanded, loaded, authHeader]);

  const toggle = useCallback(async (key: PrefKey) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const next = !prefs[key];
    setPrefs((p) => ({ ...p, [key]: next }));
    // W3c: "잠금화면 실시간 중계" 토글은 클라 게이트 캐시도 즉시 갱신 + off면 현재 활성 카드 종료.
    if (key === "live_activity") {
      setLiveActivityEnabledCache(next);
      // 안드: 네이티브 게이트 미러 — off면 네이티브가 현재 카드 제거 + 이후 FCM 카드 미게시.
      void syncAndroidLockCardGate(next);
      if (!next) void endLiveActivity();
    }
    try {
      const res = await fetch("/api/push/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) {
        setPrefs((p) => ({ ...p, [key]: !next })); // 실패 시 롤백
        if (key === "live_activity") {
          setLiveActivityEnabledCache(!next);
          void syncAndroidLockCardGate(!next);
        }
      }
    } catch {
      setPrefs((p) => ({ ...p, [key]: !next }));
      if (key === "live_activity") {
        setLiveActivityEnabledCache(!next);
        void syncAndroidLockCardGate(!next);
      }
    } finally {
      savingRef.current = false;
    }
  }, [prefs, authHeader]);

  // 로그인 유저에게만 — 비로그인에게 계정 설정 카드/권한 요청 노출 금지 (PR #206 리뷰 blocker 1)
  // 비네이티브(웹/PWA)는 뉴스클리핑 토글만 노출 — 이 토글은 푸시가 아니라 쪽지 생성 자체를
  // 제어하므로 전체 유저가 끌 수 있어야 함(PR #619 리뷰 blocker 1). 나머지 푸시 토글과
  // OS 권한 배너는 네이티브 전용 유지.
  if (!user) return null;
  const visibleLabels = isNative ? PREF_LABELS : PREF_LABELS.filter(({ key }) => key === "news_clipping");

  return (
    <GlassCard className="p-5">
      {isNative && permissionDenied && (
        <button
          onClick={() => void enablePush()}
          className="w-full mb-4 flex items-center justify-between rounded-xl bg-accent/15 border border-accent/30 px-4 py-3"
        >
          <span className="text-sm text-text-primary">🔔 알림이 꺼져 있어요</span>
          <span className="text-sm font-semibold text-accent">켜기</span>
        </button>
      )}
      <button className="w-full flex items-center justify-between" onClick={async () => {
        if (!expanded && isNative) void requestNativePushPermission(); // 미허용 상태로 진입 시 권한 요청 기회
        setExpanded(!expanded);
      }}>
        <div className="flex items-center gap-4">
          <Bell size={22} className="text-text-secondary" />
          <div className="text-left">
            <span className="text-base text-text-primary">알림 설정</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              {isNative ? "경기·최애선수·댓글·쪽지 알림을 종류별로 켜고 끄세요" : "팀 뉴스클리핑 쪽지 수신을 켜고 끄세요"}
            </p>
          </div>
        </div>
        {expanded ? <ChevronUp size={20} className="text-text-tertiary" /> : <ChevronDown size={20} className="text-text-tertiary" />}
      </button>

      {expanded && (
        <div className="mt-4 flex flex-col divide-y divide-white/10">
          {visibleLabels.map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between py-3">
              <div>
                <span className="text-sm text-text-primary">{label}</span>
                {desc && <p className="text-xs text-text-tertiary mt-0.5">{desc}</p>}
              </div>
              <button
                onClick={() => void toggle(key)}
                className={`relative w-12 h-7 rounded-full transition-colors ${prefs[key] ? "bg-accent" : "bg-bg-tertiary"}`}
                aria-label={`${label} 알림 ${prefs[key] ? "끄기" : "켜기"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${prefs[key] ? "translate-x-5" : "translate-x-0"}`} />
              </button>
            </div>
          ))}
          {/* 마스터 토글(live_activity) off면 스타일 선택도 숨김 — 꺼진 기능의 옵션 노출 방지. */}
          {liveUpdate.supported && prefs.live_activity !== false && (
            <div className="py-3">
              <span className="text-sm text-text-primary">잠금화면 카드 스타일</span>
              <p className="text-xs text-text-tertiary mt-0.5">경기 진행중 잠금화면에 표시할 카드 스타일을 선택하세요 (이 기기)</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={() => void setLiveCardStyle(false)}
                  aria-pressed={!liveUpdate.enabled}
                  className={`rounded-xl border px-3 py-3 text-left transition-colors ${!liveUpdate.enabled ? "border-accent bg-accent/10" : "border-white/10 bg-bg-tertiary"}`}
                >
                  <span className={`text-sm font-medium ${!liveUpdate.enabled ? "text-accent" : "text-text-primary"}`}>디자인 카드</span>
                  <p className="text-xs text-text-tertiary mt-0.5">팀컬러·그래픽 크보팬 디자인</p>
                </button>
                <button
                  onClick={() => void setLiveCardStyle(true)}
                  aria-pressed={liveUpdate.enabled}
                  className={`rounded-xl border px-3 py-3 text-left transition-colors ${liveUpdate.enabled ? "border-accent bg-accent/10" : "border-white/10 bg-bg-tertiary"}`}
                >
                  <span className={`text-sm font-medium ${liveUpdate.enabled ? "text-accent" : "text-text-primary"}`}>심플 카드</span>
                  <p className="text-xs text-text-tertiary mt-0.5">잠금화면 상단 우선 표시 (안드 기본)</p>
                </button>
              </div>
            </div>
          )}
          {isNative && prefsLoadedOk && prefs.live_activity !== false && (
            <div className="py-3">
              <button
                onClick={() => void retriggerCard()}
                disabled={retrigger === "working"}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-bg-tertiary px-4 py-2.5 text-sm text-text-primary disabled:opacity-60"
              >
                <RefreshCw size={15} className={retrigger === "working" ? "animate-spin" : ""} />
                잠금화면 카드 다시 표시
              </button>
              <p className="text-xs text-text-tertiary mt-1.5 text-center">
                {retrigger === "done"
                  ? "✅ 카드 표시를 요청했어요 — 잠금화면을 확인해주세요"
                  : retrigger === "none"
                    ? "지금은 표시할 경기가 없어요 (라이브 경기 또는 시작 30분 전부터 가능)"
                    : retrigger === "failed"
                      ? "다시 표시하지 못했어요 — 알림 설정·권한 확인 후 재시도해주세요"
                      : "실수로 카드를 지웠을 때 눌러주세요"}
              </p>
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}
