"use client";

import { useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ArrowLeft, MessageCircle, Settings, X, ShieldBan } from "lucide-react";
import { useDMList } from "@/lib/supabase/useDM";
import { useBlockList } from "@/lib/supabase/useBlock";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";
import { stripProvenanceForPreview } from "@/lib/baseball-qa/genius-reply-provenance";

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
  const goBack = useSafeBack("/");
  const { user } = useAuth();
  const { conversations, loading } = useDMList();
  const { blockedUsers, loading: blocksLoading, refresh: refreshBlocks } = useBlockList();
  const [showLogin, setShowLogin] = useState(false);
  const [showBlockList, setShowBlockList] = useState(false);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  const handleUnblock = async (blockedId: string) => {
    if (!user) return;
    setUnblocking(blockedId);
    await supabase
      .from("user_blocks")
      .delete()
      .eq("blocker_id", user.id)
      .eq("blocked_id", blockedId);
    await refreshBlocks();
    setUnblocking(null);
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-bg-primary pb-24">
        <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="px-5 min-h-[44px] flex items-center gap-3">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2">
            <ArrowLeft size={24} className="text-text-primary" />
          </button>
          <h1 className="text-lg font-semibold leading-[26px] text-text-primary">쪽지</h1>
        </div>
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
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <div className="px-5 min-h-[44px] flex items-center gap-3">
        <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <h1 className="text-lg font-bold text-text-primary flex-1">쪽지</h1>
      </div>
      </div>

      {/* 차단 관리 — 헤더에서 바디로 이동 */}
      <div className="px-5 pt-3 flex justify-end">
        <button onClick={() => setShowBlockList(true)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium bg-bg-tertiary text-text-secondary hover:bg-bg-secondary transition-colors">
          <Settings size={14} />
          차단 관리
        </button>
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
        <div className="px-5 space-y-2">
          {conversations.map((conv) => (
            <GlassCard
              key={conv.id}
              pressable
              className="p-4"
              onClick={() => router.push(`/messages/${conv.id}`)}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-bg-tertiary flex items-center justify-center flex-shrink-0 overflow-visible">
                  {conv.other_user_id === BASEBALL_GENIUS_USER_ID ? (
                    // 야잘알봇 판정은 닉네임이 아니라 **계정 ID** 로 한다 (삼순 NO-GO).
                    // 닉네임 비교는 같은 이름을 쓰는 일반 유저에게도 마스코트가 붙는다(위조 가능).
                    // 야잘알봇만 원형 프로필이 아니라 캐릭터 전신을 쓴다(삼순 확정 규격).
                    // 컨테이너 w-10 은 전 행 공용이라 폭을 바꾸면 닉네임 시작 x 가 밀려
                    // 다른 행과 정렬이 어긋난다. 그래서 폭은 그대로 두고, 캐릭터만
                    // 64px 슬롯으로 넘치게 그린다(overflow-visible + absolute).
                    // 세로로 긴 종횡비(0.667)라 64px 슬롯에서 가시 높이가 곧 64px 이다.
                    <span className="relative block w-10 h-10">
                      <img src="/mascot/yajalal-avatar.png" alt="야잘알봇"
                           className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-16 w-auto max-w-none" />
                    </span>
                  ) : conv.other_nickname === "크보팬 운영팀" ? (
                    // 컨테이너가 `overflow-visible`(야잘알봇 캐릭터가 슬롯 밖으로 넘쳐야 해서)이라
                    // 컨테이너의 `rounded-full` 이 자식을 잘라주지 않는다. 그런데 이 아이콘 PNG 는
                    // 알파가 없고 모서리에 **흰색이 구워져** 있어서, 클립이 없으면 흰 테두리가 그대로 보인다.
                    // 따라서 자기 자신이 원형으로 클립해야 한다 — 컨테이너 overflow 에 의존하지 않는다.
                    <img src="/apple-touch-icon.png" alt="크보팬" className="w-full h-full rounded-full object-cover" />
                  ) : conv.other_team_id ? (
                    <TeamBadge teamId={conv.other_team_id} size="sm" />
                  ) : (
                    <span className="text-lg">👤</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-text-primary">{conv.other_nickname}</span>
                    {!conv.id.startsWith("new-") && (
                      <span className="text-[10px] text-text-tertiary">{timeAgo(conv.last_message_at)}</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-text-secondary truncate" data-testid="dm-preview">
                      {/* 목록 미리보기도 출처 줄을 떼어낸다 — 상세만 정규화하면 여기 `rev crawled:…` 가
                          그대로 남는다(삼순 P0-1). 앵커를 그릴 자리가 없으므로 본문만 보여준다.
                          ⚠️ **야잘알봇 대화에만** 적용한다(삼순 P1) — 일반 DM 은 유저가 쓴 문장이
                          우연히 출처 suffix 모양이면 잘려나간다. */}
                      {stripProvenanceForPreview(
                        conv.last_message,
                        conv.other_user_id === BASEBALL_GENIUS_USER_ID,
                      ) || "대화를 시작해보세요"}
                    </p>
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

      {/* Block List Bottom Sheet */}
      <AnimatePresence>
        {showBlockList && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowBlockList(false)}
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-0 left-0 right-0 rounded-t-2xl bg-bg-secondary border-t border-border p-5 pb-safe max-h-[70vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ShieldBan size={18} className="text-text-secondary" />
                  <h3 className="text-base font-bold text-text-primary">차단 관리</h3>
                </div>
                <button onClick={() => setShowBlockList(false)} className="p-1">
                  <X size={20} className="text-text-tertiary" />
                </button>
              </div>

              {blocksLoading ? (
                <div className="text-center py-8 text-sm text-text-tertiary">불러오는 중...</div>
              ) : blockedUsers.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-text-tertiary">차단한 유저가 없습니다</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {blockedUsers.map((bu) => (
                    <div key={bu.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-bg-tertiary">
                      <div className="w-8 h-8 rounded-full bg-bg-primary flex items-center justify-center flex-shrink-0">
                        {bu.team_id ? (
                          <TeamBadge teamId={bu.team_id} size="xs" />
                        ) : (
                          <span className="text-sm">👤</span>
                        )}
                      </div>
                      <span className="flex-1 text-sm font-semibold text-text-primary">{bu.nickname}</span>
                      <button
                        onClick={() => handleUnblock(bu.blocked_id)}
                        disabled={unblocking === bu.blocked_id}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors disabled:opacity-50"
                      >
                        {unblocking === bu.blocked_id ? "..." : "해제"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
