"use client";

import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Gift, Share2, Check, UserPlus, Ticket } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

interface Invitation {
  code: string;
  used_at: string | null;
  invitee_id: string | null;
  activated_at: string | null;
  flagged: boolean;
  created_at: string;
}

interface Friend {
  id: string;
  nickname: string;
}

interface InviteData {
  invitations: Invitation[];
  friends: Friend[];
  totalInvited: number;
  activatedCount: number;
  remainingCodes: number;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export default function InviteSection() {
  const { user, profile } = useAuth();
  const [data, setData] = useState<InviteData | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [registerCode, setRegisterCode] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState("");
  const [registerSuccess, setRegisterSuccess] = useState(false);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/invite", { headers });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!user || !profile) return null;

  const PIONEER_GOAL = 20;

  async function handleGenerate() {
    setGenerating(true);
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
      });
      if (res.ok) await fetchData();
    } finally {
      setGenerating(false);
    }
  }

  async function handleShare(code: string) {
    const inviteUrl = `https://keubo.fan/invite/${code}`;
    const text = `크보팬에서 같이 야구 봐! ⚾\n초대코드: ${code}\n${inviteUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ text, url: inviteUrl });
        return;
      } catch { /* user cancelled */ }
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRegister() {
    const code = registerCode.trim().toUpperCase();
    if (!code) return;
    setRegisterLoading(true);
    setRegisterError("");
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/invite/use", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        setRegisterSuccess(true);
        setShowRegister(false);
        await fetchData();
      } else {
        const json = await res.json();
        setRegisterError(json.error || "등록에 실패했습니다");
      }
    } finally {
      setRegisterLoading(false);
    }
  }

  const friendMap = new Map((data?.friends || []).map(f => [f.id, f.nickname]));
  const latestCode = data?.invitations.find(i => !i.used_at);
  const activatedCount = data?.activatedCount ?? 0;
  const progressPct = Math.min((activatedCount / PIONEER_GOAL) * 100, 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.09 }}
      className="mt-5"
    >
      <GlassCard className="p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Gift size={20} className="text-accent" />
          <h3 className="text-base font-bold text-text-primary">친구 초대</h3>
        </div>

        {loading && !data ? (
          <div className="h-20 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* 잔여 초대권 + 생성 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Ticket size={16} className="text-text-tertiary" />
                <span className="text-sm text-text-secondary">
                  잔여 초대권 <span className="font-bold text-text-primary">{data?.remainingCodes ?? 0}장</span>
                </span>
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating || (data?.remainingCodes ?? 0) <= 0}
                className="text-sm font-semibold text-accent disabled:opacity-40 transition-opacity"
              >
                {generating ? "생성 중..." : "초대코드 생성"}
              </button>
            </div>

            {/* 최근 생성된 미사용 코드 */}
            {latestCode && (
              <div className="flex items-center justify-between bg-bg-tertiary/50 rounded-xl px-4 py-3">
                <code className="text-sm font-mono font-bold text-text-primary tracking-wider">
                  {latestCode.code}
                </code>
                <button
                  onClick={() => handleShare(latestCode.code)}
                  className="flex items-center gap-1.5 text-sm font-semibold text-accent"
                >
                  {copied ? <Check size={16} /> : <Share2 size={16} />}
                  {copied ? "복사됨!" : "공유하기"}
                </button>
              </div>
            )}

            {/* 초대코드 등록 (invited_by가 없는 경우) */}
            {!profile.invited_by && !registerSuccess && (
              <div>
                {!showRegister ? (
                  <button
                    onClick={() => setShowRegister(true)}
                    className="w-full flex items-center justify-center gap-2 text-sm text-text-secondary hover:text-text-primary py-2 transition-colors"
                  >
                    <UserPlus size={16} />
                    초대코드가 있다면 등록하기
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={registerCode}
                        onChange={e => { setRegisterCode(e.target.value); setRegisterError(""); }}
                        placeholder="KEUBO-XXXXXX"
                        className="flex-1 bg-bg-tertiary border border-white/10 rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary font-mono uppercase focus:outline-none focus:border-accent"
                      />
                      <button
                        onClick={handleRegister}
                        disabled={registerLoading || !registerCode.trim()}
                        className="px-4 py-2 bg-accent text-white text-sm font-semibold rounded-lg disabled:opacity-40"
                      >
                        {registerLoading ? "..." : "등록"}
                      </button>
                    </div>
                    {registerError && <p className="text-xs text-red-400">{registerError}</p>}
                  </div>
                )}
              </div>
            )}
            {registerSuccess && (
              <p className="text-xs text-green-400 text-center">초대코드가 등록되었습니다!</p>
            )}

            {/* 초대 현황 */}
            {data && data.invitations.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-text-tertiary font-semibold">초대 현황</p>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {data.invitations.map(inv => {
                    const friendName = inv.invitee_id ? friendMap.get(inv.invitee_id) : null;
                    const isActivated = !!inv.activated_at && !inv.flagged;
                    const isUsed = !!inv.used_at;
                    return (
                      <div key={inv.code} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span>{isActivated ? "✅" : isUsed ? "⏳" : "📩"}</span>
                          <span className="text-text-secondary font-mono text-xs">{inv.code}</span>
                        </div>
                        <span className="text-xs text-text-tertiary">
                          {friendName || (isUsed ? "가입 대기" : "미사용")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 개척자 뱃지 진행률 */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">🏅 개척자 뱃지</span>
                <span className="text-text-secondary font-semibold">{activatedCount} / {PIONEER_GOAL}</span>
              </div>
              <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-orange-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                />
              </div>
              {activatedCount >= PIONEER_GOAL && (
                <p className="text-xs text-center text-accent font-semibold">개척자 뱃지 획득! 🎉</p>
              )}
            </div>
          </>
        )}
      </GlassCard>
    </motion.div>
  );
}
