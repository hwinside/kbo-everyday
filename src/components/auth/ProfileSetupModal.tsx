"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import Image from "next/image";
import { trackEvent, OnboardingEvents, flushNativeMetaForSignup } from "@/lib/analytics";
import { NICKNAME_INPUT_PLACEHOLDER, NICKNAME_MAX_LENGTH, validateNickname } from "@/lib/validation/nickname";

interface Props {
  isOpen: boolean;
}

export default function ProfileSetupModal({ isOpen }: Props) {
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [nickname, setNickname] = useState(user?.user_metadata?.name || user?.user_metadata?.full_name || "");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen || !user) return null;

  const selectedTeamData = KBO_TEAMS.find(t => t.id === selectedTeam);

  async function handleNicknameNext() {
    if (loading) return;
    const trimmed = nickname.trim();
    const validationError = validateNickname(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      // 2026-05-02: 네이티브 OAuth 직후 client DB query가 조용히 지연되면
      // 버튼이 무반응처럼 보이므로 API 경로로 중복 확인 + 명시적 에러 처리.
      const res = await fetch(`/api/check-nickname?nickname=${encodeURIComponent(trimmed)}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.available === false) {
        setError(json.reason || "닉네임 확인 중 오류가 발생했습니다");
        return;
      }
      setError("");
      setStep(2);
    } catch {
      setError("닉네임 확인 중 오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  }

  async function handleComplete(opts?: { skipInvite?: boolean }) {
    if (!selectedTeam || loading) return;
    setLoading(true);
    setError("");
    try {
      const effectiveInviteCode = opts?.skipInvite
        ? undefined
        : (inviteCode.trim().toUpperCase() || undefined);

      // 서버 /api/setup으로 프로필 생성 — 클라이언트 supabase 직접 호출 일절 금지.
      // 세션은 @supabase/ssr 쿠키에 저장돼 same-origin fetch에 자동 동봉되므로 getSession() 불필요.
      // getSession은 네이티브 가입 직후 auth 락 경합으로 hang할 수 있어(#209) 호출 자체를 제거 →
      // "생성 중…" 영구 스턱 원천 차단. (/setup 페이지와 동일하게 서버에서 인증·닉네임·초대코드 처리)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let res: Response;
      try {
        // Promise.race 안전망 — 일부 네이티브 WebView에서 AbortController가 fetch를 못 끊어도
        // 15초 후 reject되어 loading이 반드시 해제됨(무한 스피너 불가능).
        res = await Promise.race([
          fetch("/api/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              nickname: nickname.trim(),
              team_id: selectedTeam,
              invite_code: effectiveInviteCode,
              favorite_players: [],
            }),
            signal: controller.signal,
          }),
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new DOMException("timeout", "AbortError")), 15000)
          ),
        ]);
      } finally {
        clearTimeout(timer);
      }

      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(result.error || "프로필 생성에 실패했습니다");
        setLoading(false);
        return;
      }

      // localStorage도 동기화 (홈/커뮤니티가 읽는 canonical key와 일치)
      if (typeof window !== "undefined") {
        localStorage.setItem("kbo-my-team", String(selectedTeam));
      }

      // Meta Pixel: Subscribe(팀선택)
      // skipNative: 네이티브 발화는 아래 flushNativeMetaForSignup으로 await 처리(hard nav 레이스 방지)
      const completePayload = { nickname: nickname.trim(), team_id: selectedTeam, source: "profile_setup_modal" };
      trackEvent(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam }, { meta: true, skipNative: true });

      // 회원가입 완료 — GA4 + Meta Pixel 발화
      // Google Ads conversion은 /welcome 페이지에서 직접 gtag 호출로 단순화 (2026-04-27)
      trackEvent(OnboardingEvents.ONBOARDING_COMPLETE, completePayload, { meta: true, skipNative: true });

      // 네이티브 Meta App Event는 hard nav 전에 await로 전송 완료 (Capacitor 웹 원격 로드 레이스 방지)
      await flushNativeMetaForSignup(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam });
      await flushNativeMetaForSignup(OnboardingEvents.ONBOARDING_COMPLETE, completePayload);

      // /welcome에서 Google Ads conversion 발화할 수 있도록 플래그 세팅
      try { sessionStorage.setItem("kbo-signup-just-completed", "1"); } catch { /* ignore */ }
      // 하드 내비게이션 — AuthContext를 새로 부트스트랩(신규 프로필 로드)해 SPA refreshProfile의
      // 네이티브 클라이언트 의존 제거. /setup 페이지와 동일.
      window.location.href = "/welcome";
      return; // loading 고정 유지
    } catch (e: unknown) {
      const aborted = (e as Error)?.name === "AbortError";
      setError(aborted ? "네트워크가 지연되고 있어요. 잠시 후 다시 시도해주세요" : ((e as Error).message || "프로필 생성에 실패했습니다"));
      setLoading(false); // 에러 시에만 재활성화 (타임아웃 포함 — 무한 스피너 방지)
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-5"
      >
        <motion.div
          initial={{ scale: 0.9, y: 20 }}
          animate={{ scale: 1, y: 0 }}
          className="w-full max-w-md bg-bg-secondary rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden"
        >
          {/* Step 1: Nickname */}
          {step === 1 && (
            <div className="p-5">
              <h2 className="text-xl font-bold text-text-primary mb-2">환영합니다! 🎉</h2>
              <p className="text-sm text-text-secondary mb-6">크보팬에서 사용할 닉네임을 정해주세요</p>
              
              <input
                type="text"
                value={nickname}
                onChange={(e) => { setNickname(e.target.value); setError(""); }}
                placeholder={NICKNAME_INPUT_PLACEHOLDER}
                maxLength={NICKNAME_MAX_LENGTH}
                className="w-full bg-bg-tertiary border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
              />
              {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
              <p className="text-xs text-text-tertiary mt-2">한글, 영문, 숫자만 사용 가능</p>

              <button
                onClick={handleNicknameNext}
                disabled={loading || nickname.trim().length < 2}
                className="w-full mt-6 bg-accent text-white font-semibold py-3 rounded-xl disabled:opacity-40 transition-all"
              >
                {loading ? "확인 중..." : "다음"}
              </button>
            </div>
          )}

          {/* Step 2: Team Selection */}
          {step === 2 && (
            <div className="p-5">
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
            <div className="p-5">
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

              {/* 허위 선택지 방지: '건너뛰기' 항상 노출 (2026-04-21 lotteworry P1) */}
              <button
                onClick={() => handleComplete({ skipInvite: true })}
                disabled={loading}
                className="w-full mt-3 py-3 rounded-xl bg-bg-tertiary/60 hover:bg-bg-tertiary text-text-secondary text-sm font-medium disabled:opacity-40 border border-black/5 dark:border-white/10"
              >
                초대코드 없이 건너뛰기 →
              </button>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 4 && selectedTeamData && (
            <div className="p-5 text-center">
              <div className="w-20 h-20 rounded-full bg-white p-2 flex items-center justify-center mx-auto mb-4">
                <Image src={selectedTeamData.logoPath} alt="" width={56} height={56} unoptimized className="object-contain" />
              </div>
              <h2 className="text-xl font-bold text-text-primary mb-2">
                <span style={{ color: selectedTeamData.colorLight }}>{nickname}</span>님, 환영합니다!
              </h2>
              <p className="text-sm text-text-secondary mb-6">
                {selectedTeamData.name} 팬으로 등록되었습니다 🎉
              </p>
              <button
                onClick={() => window.location.reload()}
                className="w-full py-3 rounded-xl font-semibold text-white"
                style={{ backgroundColor: selectedTeamData.colorPrimary }}
              >
                시작하기
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
