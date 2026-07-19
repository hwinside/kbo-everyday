"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Lock, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { isNative } from "@/lib/capacitor/platform";
import { isAndroid } from "@/lib/capacitor/platform";
import { endLiveActivity, setLiveActivityEnabledCache } from "@/lib/native-live-activity";
import {
  getLiveUpdateState,
  setLiveUpdateOptIn,
  syncAndroidLockCardGate,
  captureLockCardGateGeneration,
  applyAndroidLockCardGateFromLoad,
  getAndroidLockCardGateState,
  type LiveUpdateState,
} from "@/lib/capacitor/game-notification";
import { decideLockCardMasterControl, type LockCardMasterControl } from "@/lib/capacitor/lock-card-gate-fence";
import { retriggerLockScreenCard } from "@/lib/notifications/lock-card-retrigger";
import { PREF_LABELS } from "@/lib/notifications/prefs";

/**
 * 마이페이지 > 잠금화면 — 잠금화면 관련 설정 전용 카드 (2026-07-18 하린아빠 지시:
 * 잠금화면 설정이 iOS/안드 각 2가지 이상이라 알림 설정에서 한 레벨 승격).
 * 구성 = 실시간 중계 마스터 토글(서버 pref live_activity, 크로스플랫폼) +
 * 카드 스타일 2택(안드 16+, 이 기기) + 카드 다시 표시(#680).
 * 네이티브 전용 — 웹/PWA엔 잠금화면 카드 자체가 없다. 토글 라벨/설명은 PREF_LABELS SSOT 재사용.
 */

const LIVE_ACTIVITY_LABEL = PREF_LABELS.find(({ key }) => key === "live_activity");

export default function LockScreenCard() {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  // live_activity 서버 pref — row 없음/미조회 디폴트 on (prefs.ts DEFAULT_PREFS와 동일).
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // 서버 조회 "성공" 여부 — 재노출 버튼은 서버 값 확인 성공 시에만 노출(fail-closed,
  // 삼순 #680 재리뷰 blocker와 동일 계약).
  const [prefsLoadedOk, setPrefsLoadedOk] = useState(false);
  // 잠금화면 라이브 카드 스타일(Android 16+) — 디바이스 로컬 opt-in. supported:false면 숨김.
  const [liveUpdate, setLiveUpdate] = useState<LiveUpdateState>({ supported: false, enabled: false });
  // 마스터 토글 컨트롤 가능 여부 — 안드 구빌드(vc13↓)는 setLockCardEnabled가 silent no-op이라
  // OFF해도 카드가 계속 뜨는 거짓 토글이 됨(삼순 #686 blocker②) → capability 프로브로 판정해
  // 비활성+업데이트 안내. "unknown"(프로브 전)도 fail-closed 비활성. iOS는 빌드 무관 enabled.
  const [masterControl, setMasterControl] = useState<LockCardMasterControl | "unknown">("unknown");
  const savingRef = useRef(false);

  const authHeader = useCallback(async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  // 펼칠 때 카드 스타일 지원 여부 + 마스터 컨트롤 capability 프로브(안드만 — iOS는 즉시 enabled).
  useEffect(() => {
    if (!expanded || !isNative) return;
    let cancelled = false;
    void (async () => {
      const state = await getLiveUpdateState();
      if (!cancelled) setLiveUpdate(state);
    })();
    void (async () => {
      const gate = isAndroid ? await getAndroidLockCardGateState() : null;
      if (cancelled) return;
      setMasterControl(decideLockCardMasterControl({
        isAndroidNative: isAndroid,
        nativeGateSupported: gate ? gate.supported : null,
      }));
    })();
    return () => { cancelled = true; };
  }, [expanded]);

  // 펼칠 때 서버 pref 조회 — 성공 시 클라 게이트 캐시(iOS)+안드 네이티브 게이트를
  // 서버 SSOT로 동기화(타 기기 변경/재설치 복원).
  // fence(삼순 blocker①): GET 시작 전 generation 칐처 → 그 사이 명시 토글이 있었으면
  // 과거 서버값을 UI/캐시/네이티브 어디에도 쓰지 않고 폐기(토글 후승 금지).
  useEffect(() => {
    if (!expanded || loaded) return;
    (async () => {
      try {
        const gen = captureLockCardGateGeneration();
        const res = await fetch("/api/push/prefs", { headers: await authHeader() });
        if (res.ok) {
          const { prefs: saved } = await res.json();
          const on = saved?.live_activity !== false;
          const applied = await applyAndroidLockCardGateFromLoad(on, gen);
          if (applied) {
            setEnabled(on);
            setLiveActivityEnabledCache(on);
            setPrefsLoadedOk(true);
          }
          // applied=false — 칐처 이후 명시 토글 발생(stale GET) → 사용자 최신 상태 유지.
        }
      } catch {
        // 디폴트 유지
      } finally {
        setLoaded(true);
      }
    })();
  }, [expanded, loaded, authHeader]);

  // W3c: 마스터 토글 — 클라 게이트 캐시(iOS)+안드 네이티브 게이트 즉시 갱신,
  // off면 현재 활성 카드 종료(iOS endLiveActivity / 안드는 네이티브 게이트가 clear).
  const toggle = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const next = !enabled;
    setEnabled(next);
    setLiveActivityEnabledCache(next);
    void syncAndroidLockCardGate(next);
    if (!next) void endLiveActivity();
    try {
      const res = await fetch("/api/push/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ live_activity: next }),
      });
      if (!res.ok) {
        setEnabled(!next); // 실패 시 롤백
        setLiveActivityEnabledCache(!next);
        void syncAndroidLockCardGate(!next);
      }
    } catch {
      setEnabled(!next);
      setLiveActivityEnabledCache(!next);
      void syncAndroidLockCardGate(!next);
    } finally {
      savingRef.current = false;
    }
  }, [enabled, authHeader]);

  // simple=true → Live Update(시스템 승격, 상단 우선 표시) opt-in / simple=false → 디자인 카드(opt-out).
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

  // 네이티브 로그인 유저 전용 — 웹/PWA엔 잠금화면 카드가 없고, 비로그인에겐 계정 설정 노출 금지.
  if (!user || !isNative) return null;

  return (
    <GlassCard className="p-5">
      <button className="w-full flex items-center justify-between" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-4">
          <Lock size={22} className="text-text-secondary" />
          <div className="text-left">
            <span className="text-base text-text-primary">잠금화면</span>
            <p className="text-xs text-text-tertiary mt-0.5">경기 실시간 카드 표시를 설정하세요</p>
          </div>
        </div>
        {expanded ? <ChevronUp size={20} className="text-text-tertiary" /> : <ChevronDown size={20} className="text-text-tertiary" />}
      </button>

      {expanded && (
        <div className="mt-4 flex flex-col divide-y divide-white/10">
          <div className="flex items-center justify-between py-3">
            <div>
              <span className="text-sm text-text-primary">{LIVE_ACTIVITY_LABEL?.label ?? "잠금화면 실시간 중계"}</span>
              <p className="text-xs text-text-tertiary mt-0.5">{LIVE_ACTIVITY_LABEL?.desc ?? "최애팀 경기 득점·이닝을 잠금화면 카드로 실시간 표시"}</p>
            </div>
            <button
              onClick={() => void toggle()}
              disabled={!prefsLoadedOk || masterControl !== "enabled"}
              className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-40 ${enabled ? "bg-accent" : "bg-bg-tertiary"}`}
              aria-label={`잠금화면 실시간 중계 ${enabled ? "끄기" : "켜기"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
          {/* 구빌드 안드(vc13↓) — 네이티브 게이트 미탑재라 마스터 OFF가 실제로 동작하지 않음 →
              비활성+업데이트 안내(삼순 blocker②). 카드 스타일·다시 표시는 구빌드에서도 동작하므로
              이 안내/게이트에 묶지 않는다(분리 게이트). */}
          {masterControl === "needs-update" && (
            <p className="text-xs text-text-tertiary py-2">
              ℹ️ 켜기/끄기는 앱 최신 버전부터 지원돼요 — 스토어에서 앱을 업데이트해주세요
            </p>
          )}
          {/* 마스터 토글 off면 스타일 선택도 숨김 — 꺼진 기능의 옵션 노출 방지. */}
          {liveUpdate.supported && enabled && (
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
          {prefsLoadedOk && enabled && (
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
