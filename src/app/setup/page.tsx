"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";

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
    if (trimmed.length < 2 || trimmed.length > 12) {
      setError("닉네임은 2~12자로 입력해주세요");
      return;
    }
    if (!/^[가-힣a-zA-Z0-9]+$/.test(trimmed)) {
      setError("한글, 영문, 숫자만 사용 가능합니다");
      return;
    }
    // 중복 체크는 프로필 insert 시 unique constraint에서 잡힘
    // 여기서는 동기 검증만 (async Supabase 쿼리는 세션 없을 때 hang 발생)
    setError("");
    setStep(2);
  }

  async function handleComplete() {
    if (!selectedTeam) return;
    setLoading(true);
    setError("");
    try {
      // hash에서 추출한 토큰 우선, 없으면 쿠키 fallback (API route에서 처리)
      const accessToken = hashToken || undefined;

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
          invite_code: inviteCode.trim() || undefined,
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
      trackEvent(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam }, { meta: true });

      // 회원가입 완료 — Google Ads 전환 + Meta Pixel 동시 발화 후 event_callback으로 redirect
      // 기존 /welcome 페이지를 전환 포인트로 쓰던 구조는 AuthContext hydrate race로 33명 중 0명 발화
      // → /setup POST 성공 직후(회원가입 실제 확정 시점)로 옮겨 beacon 유실 방지
      //
      // ⚠️ loading=true 를 고정 유지 (finally에서 setLoading(false) 하지 않음)
      // 이유: event_callback 대기 중 버튼 재클릭/중복 submit 방지 (삼순이 리뷰 지적)
      trackEvent(
        OnboardingEvents.ONBOARDING_COMPLETE,
        { nickname: nickname.trim(), team_id: selectedTeam, source: "setup_page" },
        {
          meta: true,
          gads: true,
          onGadsComplete: () => {
            window.location.href = "/welcome";
          },
        }
      );
      // 최종 안전장치: event_callback + timeout이 어떤 이유로돓 실패해도 redirect 보장
      // (analytics.ts 내부 fireCallbackOnce로 중복 redirect는 방지됨)
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
            
            <input
              type="text"
              value={nickname}
              onChange={(e) => { setNickname(e.target.value); setError(""); }}
              placeholder="닉네임 (2~12자)"
              maxLength={12}
              className="w-full bg-bg-tertiary border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            />
            {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
            <p className="text-xs text-text-tertiary mt-2">한글, 영문, 숫자만 사용 가능</p>

            <button
              onClick={handleNicknameNext}
              disabled={nickname.trim().length < 2}
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
                onClick={handleComplete}
                disabled={loading}
                className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold disabled:opacity-40"
              >
                {loading ? "생성 중..." : inviteCode.trim() ? "등록하고 완료" : "건너뛰기"}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
