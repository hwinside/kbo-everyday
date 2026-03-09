"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X } from "lucide-react";
import { GRADES } from "@/lib/constants/grades";
import { getAvatarPath } from "@/lib/constants/avatars";
import { createComment } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import type { Comment } from "@/lib/supabase/usePosts";
import { getTeamById } from "@/lib/constants/teams";

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  postId: number | null;
  /** 팀 컬러 적용용 */
  teamId?: number | null;
  /** 댓글 작성 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentAdded?: (postId: number) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(dateStr).toLocaleDateString("ko-KR");
}

function getGradeInfo(gradeId?: string) {
  return GRADES.find((g) => g.id === gradeId) ?? GRADES[0];
}

export default function CommentSheet({ isOpen, onClose, postId, teamId, onCommentAdded }: CommentSheetProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLogin, setShowLogin] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const { user, profile } = useAuth();
  const shouldRender = isOpen && postId !== null;

  // Fetch comments directly (lightweight, no post/like fetch)
  useEffect(() => {
    if (!postId) return;
    setLoading(true);
    setComments([]);

    (async () => {
      const { data } = await supabase
        .from("comments")
        .select("*, profiles(nickname, team_id, grade, avatar_url)")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });

      if (data) {
        setComments(
          data.map((cm: Comment & { profiles?: { nickname?: string; team_id?: number; grade?: string; avatar_url?: string } }) => ({
            ...cm,
            nickname: cm.profiles?.nickname,
            team_id: cm.profiles?.team_id,
            grade: cm.profiles?.grade,
            avatar_url: cm.profiles?.avatar_url,
          }))
        );
      }
      setLoading(false);
    })();
  }, [postId]);

  // Lock body scroll when sheet is open
  useEffect(() => {
    if (shouldRender) {
      const scrollY = window.scrollY;
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.overflow = "hidden";

      return () => {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.overflow = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [shouldRender]);

  // Focus input when opened
  useEffect(() => {
    if (shouldRender) {
      setTimeout(() => inputRef.current?.focus(), 300);
    } else {
      setInput("");
    }
  }, [shouldRender]);

  // 댓글 목록 DB 재조회 (optimistic → 실제 데이터 교체)
  const refetchComments = useCallback(async (pid: number) => {
    const { data } = await supabase
      .from("comments")
      .select("*, profiles(nickname, team_id, grade, avatar_url)")
      .eq("post_id", pid)
      .order("created_at", { ascending: true });
    if (data) {
      setComments(
        data.map((cm: Comment & { profiles?: { nickname?: string; team_id?: number; grade?: string; avatar_url?: string } }) => ({
          ...cm,
          nickname: cm.profiles?.nickname,
          team_id: cm.profiles?.team_id,
          grade: cm.profiles?.grade,
          avatar_url: cm.profiles?.avatar_url,
        }))
      );
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || !postId || submitting) return;
    setSubmitting(true);
    try {
      await createComment(postId, input.trim());
      // optimistic update (즉시 반영)
      setComments((prev) => [
        ...prev,
        {
          id: Date.now(),
          post_id: postId,
          author_id: user?.id ?? "",
          content: input.trim(),
          created_at: new Date().toISOString(),
          nickname: profile?.nickname ?? user?.user_metadata?.name ?? "나",
          team_id: profile?.team_id,
          grade: profile?.grade,
          avatar_url: profile?.avatar_url ?? undefined,
        },
      ]);
      setInput("");
      if (postId) onCommentAdded?.(postId);
      // DB 재조회로 정확한 프로필(아바타 등) 반영
      refetchComments(postId);
    } catch {
      // silently fail
    } finally {
      setSubmitting(false);
    }
  }, [input, postId, submitting, user, onCommentAdded, profile, refetchComments]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  return (<>
    {createPortal(
    <AnimatePresence>
      {shouldRender && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/60"
            style={{ zIndex: 9998 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            className="fixed inset-x-0 bottom-0 flex flex-col bg-bg-secondary rounded-t-2xl"
            style={{ zIndex: 9999, maxHeight: "85vh", minHeight: "50vh" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
          >
            {/* Drag handle — drag down to dismiss */}
            <div
              className="flex justify-center pt-3 pb-2 cursor-grab"
              onTouchStart={(e) => { dragStartY.current = e.touches[0].clientY; }}
              onTouchEnd={(e) => {
                const delta = e.changedTouches[0].clientY - dragStartY.current;
                if (delta > 80) onClose();
              }}
            >
              <div className="w-10 h-1 rounded-full bg-text-tertiary/40" />
            </div>

            {/* Header */}
            <div className="relative px-4 pb-3 border-b border-border">
              <h3 className="text-base font-semibold text-text-primary text-center">댓글</h3>
              <button
                onClick={onClose}
                className="absolute right-4 top-0 p-1 text-text-tertiary hover:text-text-primary transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Comment list */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
              {loading ? (
                <div className="space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-2.5 animate-pulse">
                      <div className="w-8 h-8 rounded-full bg-bg-tertiary flex-shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 bg-bg-tertiary rounded w-20" />
                        <div className="h-3.5 bg-bg-tertiary rounded w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : comments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
                  <p className="text-base">첫 댓글을 남겨보세요 💬</p>
                </div>
              ) : (
                comments.map((comment) => {
                  const grade = getGradeInfo(comment.grade);
                  const avatarPath = getAvatarPath((comment as Comment & { avatar_url?: string }).avatar_url ?? null);
                  return (
                    <div key={comment.id} className="flex gap-2.5">
                      {avatarPath ? (
                        <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-bg-tertiary">
                          <img src={avatarPath} alt="" className="w-full h-full" />
                        </div>
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                          style={{ backgroundColor: grade.bgColor }}
                        >
                          {grade.emoji}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-text-primary">
                            {comment.nickname || "익명"}
                          </span>
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                            style={{ color: grade.color, backgroundColor: grade.bgColor }}
                          >
                            {grade.name}
                          </span>
                          <span className="text-[11px] text-text-tertiary ml-auto flex-shrink-0">
                            {timeAgo(comment.created_at)}
                          </span>
                        </div>
                        <p className="text-sm text-text-secondary mt-0.5 break-words">
                          {comment.content}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Input area — snug above safe area (sheet covers tab bar) */}
            <div className="border-t border-border px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="flex items-center gap-2">
                {user ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    placeholder="댓글을 입력하세요"
                    className="flex-1 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary outline-none border"
                    style={{ borderColor: teamId ? `${getTeamById(teamId)?.colorPrimary}80` : 'rgba(255,255,255,0.15)' }}
                  />
                ) : (
                  <button
                    onClick={() => setShowLogin(true)}
                    className="flex-1 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-tertiary text-left"
                  >
                    로그인하고 댓글 달기
                  </button>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim() || submitting || !user}
                  className="flex items-center justify-center w-9 h-9 rounded-full text-white disabled:opacity-30 transition-opacity bg-accent"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  )}
  {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
  </>);
}
