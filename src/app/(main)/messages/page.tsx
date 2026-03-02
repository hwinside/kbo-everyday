"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { useDMList } from "@/lib/supabase/useDM";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { useState } from "react";

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

export default function MessagesPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { conversations, loading } = useDMList();
  const [showLogin, setShowLogin] = useState(false);

  if (!user) {
    return (
      <div className="min-h-screen bg-bg-primary pb-24">
        <div className="px-4 pt-safe pb-3 flex items-center gap-3">
          <button onClick={() => router.back()} className="p-1">
            <ArrowLeft size={24} className="text-text-primary" />
          </button>
          <h1 className="text-lg font-bold text-text-primary">쪽지</h1>
        </div>
        <div className="text-center py-20">
          <MessageCircle size={40} className="mx-auto mb-3 text-text-tertiary opacity-50" />
          <p className="text-sm text-text-tertiary mb-4">로그인 후 이용할 수 있어요</p>
          <button onClick={() => setShowLogin(true)} className="px-5 py-2.5 rounded-full bg-accent text-white text-sm font-semibold">
            로그인
          </button>
        </div>
        <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <div className="px-4 pt-safe pb-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="p-1">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <h1 className="text-lg font-bold text-text-primary">쪽지</h1>
      </div>

      {loading ? (
        <div className="text-center py-20 text-text-tertiary text-sm">불러오는 중...</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-20">
          <MessageCircle size={40} className="mx-auto mb-3 text-text-tertiary opacity-50" />
          <p className="text-sm text-text-tertiary">아직 쪽지가 없어요</p>
          <p className="text-xs text-text-tertiary mt-1">게시글이나 양도 글에서 쪽지를 보내보세요!</p>
        </div>
      ) : (
        <div className="px-4 space-y-2">
          {conversations.map((conv) => (
            <GlassCard
              key={conv.id}
              pressable
              className="p-4"
              onClick={() => router.push(`/messages/${conv.id}`)}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-bg-tertiary flex items-center justify-center flex-shrink-0">
                  {conv.other_team_id ? (
                    <TeamBadge teamId={conv.other_team_id} size="sm" />
                  ) : (
                    <span className="text-lg">👤</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-text-primary">{conv.other_nickname}</span>
                    <span className="text-[10px] text-text-tertiary">{timeAgo(conv.last_message_at)}</span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-text-secondary truncate">{conv.last_message || "대화를 시작해보세요"}</p>
                    {conv.unread_count > 0 && (
                      <span className="ml-2 flex-shrink-0 w-5 h-5 rounded-full bg-accent flex items-center justify-center text-[10px] font-bold text-white">
                        {conv.unread_count > 9 ? "9+" : conv.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
