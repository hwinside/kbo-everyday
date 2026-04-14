"use client";

import { useState, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { supabase } from "@/lib/supabase/client";

interface InviteTabProps {
  userId: string;
  inviteCount: number;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export default function InviteTab({ userId: _userId, inviteCount }: InviteTabProps) {
  const [codes, setCodes] = useState<string[]>([]);
  const [friends, setFriends] = useState<{ id: string; nickname: string }[]>([]);
  const [totalInvited, setTotalInvited] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(inviteCount);

  useEffect(() => {
    getAuthHeaders()
      .then(headers => fetch("/api/invite", { headers }))
      .then(r => r.json())
      .then(data => {
        setCodes((data.invitations || []).filter((i: { code: string; used_at: string | null }) => !i.used_at).map((i: { code: string; used_at: string | null }) => i.code));
        setFriends(data.friends || []);
        setTotalInvited(data.totalInvited || 0);
      });
  }, [_userId]);

  async function generateCode() {
    if (remaining <= 0) return;
    setGenerating(true);
    const authHeaders = await getAuthHeaders();
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
    });
    const data = await res.json();
    if (data.code) {
      setCodes(prev => [data.code, ...prev]);
      setRemaining(prev => prev - 1);
    }
    setGenerating(false);
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  }

  function shareCode(code: string) {
    const inviteUrl = `https://keubo.fan/invite/${code}`;
    const text = `크보팬에 초대합니다! 🏟️⚾\n\n초대코드: ${code}\n가입하면 파운더 배지를 받아요 👑\n\n${inviteUrl}`;
    if (navigator.share) {
      navigator.share({ title: "크보팬 초대", text, url: inviteUrl });
    } else {
      navigator.clipboard.writeText(text);
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    }
  }

  return (
    <div className="px-5 space-y-4">
      <GlassCard className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-text-primary">🎟️ 초대코드</h3>
          <span className="text-xs px-2 py-1 rounded-full bg-accent/20 text-accent font-bold">
            남은 초대권: {remaining}장
          </span>
        </div>

        {remaining > 0 && (
          <button
            onClick={generateCode}
            disabled={generating}
            className="w-full mb-3 py-2.5 rounded-xl bg-accent/20 text-accent font-bold text-sm hover:bg-accent/30 transition-all disabled:opacity-50"
          >
            {generating ? "생성 중..." : "✨ 초대코드 생성하기"}
          </button>
        )}

        {codes.length > 0 ? (
          <div className="space-y-2">
            {codes.map(code => (
              <div key={code} className="flex items-center gap-2 bg-bg-tertiary rounded-xl px-4 py-3">
                <code className="flex-1 text-sm font-mono text-accent">{code}</code>
                <button onClick={() => copyCode(code)} className="p-1.5">
                  {copied === code ? <Check size={16} className="text-green-400" /> : <Copy size={16} className="text-text-tertiary" />}
                </button>
                <button onClick={() => shareCode(code)} className="p-1.5 text-text-tertiary text-xs">
                  공유
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-tertiary text-center py-2">
            초대코드를 생성해서 친구에게 공유하세요!
          </p>
        )}
      </GlassCard>

      <GlassCard className="p-4">
        <h3 className="text-sm font-bold text-text-primary mb-2">
          👥 내가 초대한 친구 ({totalInvited}명)
        </h3>
        {friends.length > 0 ? (
          <div className="space-y-2">
            {friends.map(f => (
              <div key={f.id} className="flex items-center gap-2 text-sm">
                <span className="text-base">🤝</span>
                <span className="text-text-primary">{f.nickname}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-tertiary">아직 초대한 친구가 없어요</p>
        )}
      </GlassCard>

      <div className="text-center text-xs text-text-tertiary space-y-1">
        <p>🤝 1명 초대 → 리크루터 Lv.1</p>
        <p>🤝 3명 초대 → 리크루터 Lv.2</p>
        <p>🤝 10명 초대 → 리크루터 Lv.3</p>
        <p>🎪 30명 초대 → <span className="text-amber-400 font-bold">초대왕</span></p>
      </div>

    </div>
  );
}
