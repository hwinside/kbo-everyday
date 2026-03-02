"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS as KBO_TEAMS } from "@/lib/constants/teams";
import Image from "next/image";

interface Props {
  isOpen: boolean;
}

export default function ProfileSetupModal({ isOpen }: Props) {
  const { user, refreshProfile } = useAuth();
  const [step, setStep] = useState(1);
  const [nickname, setNickname] = useState(user?.user_metadata?.name || user?.user_metadata?.full_name || "");
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);
  const [error, setError] = useState("");
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
    // 중복 확인
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .eq("nickname", trimmed)
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
      const { error: insertError } = await supabase
        .from("profiles")
        .insert({
          id: user!.id,
          nickname: nickname.trim(),
          team_id: selectedTeam,
          favorite_players: [],
        });
      if (insertError) throw insertError;

      // localStorage도 동기화
      if (typeof window !== "undefined") {
        localStorage.setItem("myTeamId", String(selectedTeam));
      }

      await refreshProfile();
      setStep(3);
    } catch (e: any) {
      setError(e.message || "프로필 생성에 실패했습니다");
    } finally {
      setLoading(false);
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
          className="w-full max-w-md bg-bg-secondary rounded-2xl border border-white/10 overflow-hidden"
        >
          {/* Step 1: Nickname */}
          {step === 1 && (
            <div className="p-6">
              <h2 className="text-xl font-bold text-text-primary mb-2">환영합니다! 🎉</h2>
              <p className="text-sm text-text-secondary mb-6">크보 에브리데이에서 사용할 닉네임을 정해주세요</p>
              
              <input
                type="text"
                value={nickname}
                onChange={(e) => { setNickname(e.target.value); setError(""); }}
                placeholder="닉네임 (2~12자)"
                maxLength={12}
                className="w-full bg-bg-tertiary border border-white/10 rounded-xl px-4 py-3 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
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
                        ? "border-current bg-white/5"
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
                  onClick={handleComplete}
                  disabled={!selectedTeam || loading}
                  className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold disabled:opacity-40"
                >
                  {loading ? "생성 중..." : "완료"}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Done */}
          {step === 3 && selectedTeamData && (
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
