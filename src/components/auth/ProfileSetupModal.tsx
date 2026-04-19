"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";

interface Props {
  isOpen: boolean;
}

export default function ProfileSetupModal({ isOpen }: Props) {
  const { user, refreshProfile } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [nickname, setNickname] = useState(user?.user_metadata?.name || user?.user_metadata?.full_name || "");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen || !user) return null;

  const selectedTeamData = KBO_TEAMS.find(t => t.id === selectedTeam);

  async function handleNicknameNext() {
    const trimmed = nickname.trim();
    if (trimmed.length < 2 || trimmed.length > 12) {
      setError("닉네임은 2~12자로 입력해주세요");
      return;
    }
    if (!/^[가-힣a-zA-Z0-9]+$/.test(trimmed)) {
      setError("한글, 영문, 숫자만 사용 가능합니다");
      return;
    }
    // 2026-04-19: case-insensitive 중복 체크 (ktwiz/Ktwiz 사례)
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .ilike("nickname", trimmed)
      .maybeSingle();
    if (data) {
      setError("이미 사용 중인 닉네임입니다");
      return;
    }
    setError("");
    setStep(2);
  }

  async function handleComplete() {
    if (!selectedTeam) return;
    setLoading(true);
    try {
      // 초대코드 사전 검증 (있으면)
      const normalizedInviteCode = inviteCode.trim().toUpperCase();
      if (normalizedInviteCode) {
        const { data: invite } = await supabase
          .from("invitations")
          .select("id, used_at")
          .eq("code", normalizedInviteCode)
          .maybeSingle();
        if (!invite) { setError("유효하지 않은 초대코드입니다"); setLoading(false); return; }
        if (invite.used_at) { setError("이미 사용된 초대코드입니다"); setLoading(false); return; }
      }

      const { error: insertError } = await supabase
        .from("profiles")
        .insert({
          id: user!.id,
          nickname: nickname.trim(),
          team_id: selectedTeam,
          favorite_players: [],
          invited_by: null,
          is_founder: false,
          invite_count: 5,
          joined_at: new Date().toISOString(),
        });
      if (insertError) throw insertError;

      // 초대코드 사용 처리 + 파운더 배지
      if (normalizedInviteCode) {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        const inviteRes = await fetch("/api/invite/use", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({ code: normalizedInviteCode }),
        });

        if (!inviteRes.ok) {
          const inviteJson = await inviteRes.json().catch(() => ({}));
          await supabase.from("profiles").delete().eq("id", user!.id);
          setError(inviteJson.error || "초대코드 등록에 실패했습니다");
          setLoading(false);
          return;
        }
      }

      // localStorage도 동기화 (홈/커뮤니티가 읽는 canonical key와 일치)
      if (typeof window !== "undefined") {
        localStorage.setItem("kbo-my-team", String(selectedTeam));
      }

      // Meta Pixel: Subscribe(팀선택)
      trackEvent(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeam }, { meta: true });

      // 회원가입 완료 — Google Ads 전환 + Meta Pixel 동시 발화 후 router.push
      // event_callback으로 beacon 전송 확정 후 이동 (navigation race 방지)
      //
      // ⚠️ loading=true 고정 유지 (finally에서 setLoading(false) 하지 않음)
      // 이유: event_callback 대기 중 버튼 재클릭/중복 submit 방지
      //
      // ⚠️ 2026-04-18: ONBOARDING_COMPLETE는 profiles.insert 성공 직후에만 발화되어야
      // DB 가입수와 1:1 일치. 이 경로는 insertError throw 시 이미 catch로 빠지므로
      // 이 라인에 도달 = 실제 가입 완료. source 구분자 추가로 /setup 경로와 교차검증 가능.
      trackEvent(
        OnboardingEvents.ONBOARDING_COMPLETE,
        { nickname: nickname.trim(), team_id: selectedTeam, source: "profile_setup_modal" },
        {
          meta: true,
          gads: true,
          onGadsComplete: async () => {
            await refreshProfile();
            router.push("/welcome");
          },
        }
      );
      return; // loading 고정 좌략
    } catch (e: unknown) {
      setError((e as Error).message || "프로필 생성에 실패했습니다");
      setLoading(false); // 에러 시에만 재활성화
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
                maxLength={10}
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

          {/* Step 4: Done */}
          {step === 4 && selectedTeamData && (
            <div className="p-6 text-center">
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
