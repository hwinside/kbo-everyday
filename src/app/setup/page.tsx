"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { trackEvent, OnboardingEvents, flushNativeMetaForSignup } from "@/lib/analytics";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { NICKNAME_INPUT_PLACEHOLDER, NICKNAME_MAX_LENGTH, validateNickname } from "@/lib/validation/nickname";

export default function SetupPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [nickname, setNickname] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  const [hashToken, setHashToken] = useState<string | null>(null);

  // 닉네임 실시간 가용성 체크 (debounced 400ms)
  // status: idle | checking | available | unavailable | format-error
  const [nickStatus, setNickStatus] = useState<"idle" | "checking" | "available" | "unavailable" | "format-error">("idle");
  const [nickHint, setNickHint] = useState<string>("");

  // URL hash에서 access_token 추출 (Supabase 클라이언트 사용 안 함 — hang 방지)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (hash && hash.includes("access_token")) {
      const params = new URLSearchParams(hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken) {
        setHashToken(accessToken);
        // sessionStorage에 저장 — 홈 페이지에서 세션 복원용
        sessionStorage.setItem("kbo-pending-session", JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken || "",
        }));
      }
      // hash 정리
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // user hydrate 대기 — hash token이 있으면 user 없이도 진행 허용
  useEffect(() => {
    const timer = setTimeout(() => setAuthLoading(false), 2000);
    if (user || hashToken) {
      setAuthLoading(false);
      if (user) {
        setNickname(user.user_metadata?.name || user.user_metadata?.full_name || "");
      }
      clearTimeout(timer);
    }
    return () => clearTimeout(timer);
  }, [user, hashToken]);

  // 닉네임 입력 변경 시 debounce 후 /api/check-nickname 호출
  useEffect(() => {
    const trimmed = nickname.trim();
    if (!trimmed) {
      setNickStatus("idle");
      setNickHint("");
      return;
    }
    // 형식 검증 먼저 — 형식 위반이면 네트워크 호출하지 않음
    const validationError = validateNickname(trimmed);
    if (validationError) {
      setNickStatus("format-error");
      setNickHint(validationError);
      return;
    }

    setNickStatus("checking");
    setNickHint("확인 중…");
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/check-nickname?nickname=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) return;
        // 서버 일시 오류(5xx)는 비차단—최종 submit 시 서버 검증 안전망이 잡음 (삼순이 P1 메모 반영)
        if (!res.ok && res.status >= 500) {
          setNickStatus("idle");
          setNickHint("");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data?.available === true) {
          setNickStatus("available");
          setNickHint("사용 가능한 닉네임입니다");
        } else {
          setNickStatus("unavailable");
          setNickHint(data?.reason || "이미 사용 중인 닉네임입니다");
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        // 네트워크 실패도 차단하지 않음 — 최종 submit 시 서버 검증 안전망이 잡음
        setNickStatus("idle");
        setNickHint("");
      }
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [nickname]);

  // 이미 프로필 있으면 홈으로
  const { profile } = useAuth();
  useEffect(() => {
    if (profile?.nickname && profile?.team_id) {
      router.replace("/");
    }
  }, [profile, router]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user && !hashToken) {
    return (
      <div className="min-h-screen bg-bg-primary flex flex-col items-center justify-center px-6">
        <p className="text-text-secondary mb-4">로그인이 필요합니다</p>
        <button
          onClick={() => router.replace("/")}
          className="px-6 py-3 bg-accent text-white rounded-xl font-semibold"
        >
          홈으로 가기
        </button>
      </div>
    );
  }

  const selectedTeamData = KBO_TEAMS.find(t => t.id === selectedTeam);

  function handleNicknameNext() {
    const trimmed = nickname.trim();
    const validationError = validateNickname(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    // 실시간 체크에서 중복 확인된 경우 차단
    if (nickStatus === "unavailable") {
      setError(nickHint || "이미 사용 중인 닉네임입니다");
      return;
    }
    // checking 중이면 사용자에게 잠시 대기 안내
    if (nickStatus === "checking") {
      setError("닉네임 확인 중입니다. 잠시 후 다시 시도해주세요");
      return;
    }
    // available / idle (네트워크 실패 fallback) 둘 다 통과 — 최종 submit 시 unique 제약이 안전망
    setError("");
    setStep(2);
  }

  async function handleComplete(opts?: { skipInvite?: boolean }) {
    if (!selectedTeam) return;
    setLoading(true);
    setError("");
    try {
      // hash에서 추출한 토큰 우선, 없으면 쿠키 fallback (API route에서 처리)
      const accessToken = hashToken || undefined;
      const effectiveInviteCode = opts?.skipInvite ? undefined : (inviteCode.trim() || undefined);

      // 서버 API로 프로필 생성 (클라이언트 Supabase 직접 쓰지 않음 — 세션 hang 방지)
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          nickname: nickname.trim(),
          team_id: selectedTeam,
          invite_code: effectiveInviteCode,
          favorite_players: getFavoritePlayers(),
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.error || "프로필 생성에 실패했습니다");
        setLoading(false);
        return;
      }

      if (typeof window !== "undefined") {
        localStorage.setItem("kbo-my-team", String(selectedTeam));
      }

      // Meta Pixel: Subscribe(팀선택) — CompleteRegistration은 ONBOARDING_COMPLETE 호출에 포함됨
      // skipNative: 네이티브 발화는 아래 flushNativeMetaForSignup으로 await 처리(hard nav 레이스 방지)
      const completePayload = { nickname: nickname.trim(), team_id: selectedTeam, source: "setup_page" };
      trackEvent(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam }, { meta: true, skipNative: true });

      // 회원가입 완료 — GA4 + Meta Pixel 발화
      // Google Ads conversion은 /welcome 페이지에서 직접 gtag 호출로 단순화 (2026-04-27)
      // /setup에서 gads 발화 시 event_callback race + beacon 유실 이슈가 있었음
      trackEvent(OnboardingEvents.ONBOARDING_COMPLETE, completePayload, { meta: true, skipNative: true });

      // 네이티브 Meta App Event(Subscribe/CompleteRegistration)는 hard nav 전에 await로 전송 완료.
      // Capacitor 웹 원격 로드에서 화면 전환이 비동기 브릿지 호출을 끊던 유실 버그 방지.
      await flushNativeMetaForSignup(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam });
      await flushNativeMetaForSignup(OnboardingEvents.ONBOARDING_COMPLETE, completePayload);

      // /welcome에서 Google Ads conversion 발화할 수 있도록 플래그 세팅
      try { sessionStorage.setItem("kbo-signup-just-completed", "1"); } catch { /* ignore */ }
      window.location.href = "/welcome";
      return; // ← finally로 내려가지 않게 명시 종료, loading 상태 고정
    } catch (e: unknown) {
      setError((e as Error).message || "프로필 생성에 실패했습니다");
      setLoading(false); // 에러 시에만 버튼 재활성화
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-5">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-bg-secondary rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden"
      >
        {/* Step 1: Nickname */}
        {step === 1 && (
          <div className="p-6">
            <h2 className="text-xl font-bold text-text-primary mb-2">환영합니다! 🎉</h2>
            <p className="text-sm text-text-secondary mb-6">크보팬에서 사용할 닉네임을 정해주세요</p>
            
            <div className="relative">
              <input
                type="text"
                value={nickname}
                onChange={(e) => { setNickname(e.target.value); setError(""); }}
                placeholder={NICKNAME_INPUT_PLACEHOLDER}
                maxLength={NICKNAME_MAX_LENGTH}
                className={`w-full bg-bg-tertiary border rounded-xl px-4 py-3 pr-10 text-text-primary placeholder:text-text-tertiary focus:outline-none transition-colors ${
                  nickStatus === "available"
                    ? "border-emerald-500 focus:border-emerald-500"
                    : nickStatus === "unavailable" || nickStatus === "format-error"
                      ? "border-red-500 focus:border-red-500"
                      : "border-black/10 dark:border-white/10 focus:border-accent"
                }`}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" aria-live="polite">
                {nickStatus === "checking" && (
                  <span className="inline-block w-4 h-4 border-2 border-text-tertiary border-t-transparent rounded-full animate-spin" />
                )}
                {nickStatus === "available" && <span className="text-emerald-500">✓</span>}
                {(nickStatus === "unavailable" || nickStatus === "format-error") && <span className="text-red-500">✕</span>}
              </span>
            </div>
            {/* 우선순위: submit 시 setError가 채운 값 → 실시간 hint */}
            {error ? (
              <p className="text-red-400 text-xs mt-2">{error}</p>
            ) : nickHint ? (
              <p
                className={`text-xs mt-2 ${
                  nickStatus === "available"
                    ? "text-emerald-500"
                    : nickStatus === "unavailable" || nickStatus === "format-error"
                      ? "text-red-400"
                      : "text-text-tertiary"
                }`}
              >
                {nickHint}
              </p>
            ) : (
              <p className="text-xs text-text-tertiary mt-2">한글, 영문, 숫자만 사용 가능</p>
            )}

            <button
              onClick={handleNicknameNext}
              disabled={
                nickname.trim().length < 2 ||
                nickStatus === "checking" ||
                nickStatus === "unavailable" ||
                nickStatus === "format-error"
              }
              className="w-full mt-6 bg-accent text-white font-semibold py-3 rounded-xl disabled:opacity-40 transition-all"
            >
              다음
            </button>
          </div>
        )}

        {/* Step 2: Team Selection */}
        {step === 2 && (
          <div className="p-6">
            <h2 className="text-xl font-bold text-text-primary mb-2">응원 구단 선택 ⚾</h2>
            <p className="text-sm text-text-secondary mb-4">어떤 팀을 응원하시나요?</p>

            <div className="grid grid-cols-2 gap-3 max-h-[50vh] overflow-y-auto">
              {KBO_TEAMS.map((team) => (
                <button
                  key={team.id}
                  onClick={() => setSelectedTeam(team.id)}
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                    selectedTeam === team.id
                      ? "border-current bg-black/5 dark:bg-white/5"
                      : "border-transparent bg-bg-tertiary/50 hover:bg-bg-tertiary"
                  }`}
                  style={selectedTeam === team.id ? { borderColor: team.colorLight } : {}}
                >
                  <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center flex-shrink-0">
                    <Image src={team.logoPath} alt="" width={28} height={28} unoptimized className="object-contain" />
                  </div>
                  <span className="text-sm font-bold whitespace-nowrap" style={{ color: selectedTeam === team.id ? team.colorLight : undefined }}>
                    {team.name}
                  </span>
                </button>
              ))}
            </div>

            {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

            <div className="flex gap-3 mt-4">
              <button onClick={() => setStep(1)} className="flex-1 py-3 rounded-xl bg-bg-tertiary text-text-secondary font-semibold">
                이전
              </button>
              <button
                onClick={() => { setError(""); setStep(3); }}
                disabled={!selectedTeam}
                className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold disabled:opacity-40"
              >
                다음
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Invite Code (optional) */}
        {step === 3 && (
          <div className="p-6">
            <h2 className="text-xl font-bold text-text-primary mb-2">초대코드가 있나요? 🎟️</h2>
            <p className="text-sm text-text-secondary mb-6">친구에게 받은 초대코드가 있다면 입력해주세요 (선택)</p>

            <input
              type="text"
              value={inviteCode}
              onChange={(e) => { setInviteCode(e.target.value.toUpperCase()); setError(""); }}
              placeholder="KEUBO-XXXXXX"
              maxLength={12}
              className="w-full bg-bg-tertiary border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-tertiary font-mono tracking-wider focus:outline-none focus:border-accent"
            />
            {error && <p className="text-red-400 text-xs mt-2">{error}</p>}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setStep(2)} className="flex-1 py-3 rounded-xl bg-bg-tertiary text-text-secondary font-semibold">
                이전
              </button>
              <button
                onClick={() => handleComplete()}
                disabled={loading || !inviteCode.trim()}
                className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold disabled:opacity-40"
              >
                {loading ? "생성 중..." : "등록하고 완료"}
              </button>
            </div>

            {/* 허위 선택지 방지: '건너뛰기' 항상 노출 (2026-04-21 lotteworry P1)
                삼순이 리뷰 코멘트: 넓은 터치 영역(p-3) + 대비 강화로 시인성 확보 */}
            <button
              onClick={() => handleComplete({ skipInvite: true })}
              disabled={loading}
              className="w-full mt-3 py-3 rounded-xl bg-bg-tertiary/60 hover:bg-bg-tertiary text-text-secondary text-sm font-medium disabled:opacity-40 border border-black/5 dark:border-white/10"
            >
              초대코드 없이 건너뛰기 →
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
