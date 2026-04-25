"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X, MoreHorizontal, Check } from "lucide-react";
import { getAvatarPath } from "@/lib/constants/avatars";
import { createComment, updateComment, deleteComment } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import type { Comment } from "@/lib/supabase/usePosts";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  postId: number | null;
  /** 팀 컬러 적용용 */
  teamId?: number | null;
  /** 댓글 작성 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentAdded?: (postId: number) => void;
  /** 댓글 삭제 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentDeleted?: (postId: number) => void;
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

export default function CommentSheet({ isOpen, onClose, postId, teamId, onCommentAdded, onCommentDeleted }: CommentSheetProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLogin, setShowLogin] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editInput, setEditInput] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  // iOS Safari: `position:fixed; bottom:0` is anchored to the *layout* viewport
  // and the browser also tries to scroll focused inputs into view on its own,
  // which produces visible jumps. To defeat both behaviours we pin the sheet
  // to the *visual* viewport by computing top/bottom offsets explicitly.
  const [vvTop, setVvTop] = useState(0);
  const [vvBottom, setVvBottom] = useState(0);
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

  // Reset input when sheet closes. Focus is handled after open animation completes
  // (see onAnimationComplete on the motion.div below) to avoid iOS keyboard/animation race.
  useEffect(() => {
    if (!shouldRender) {
      setInput("");
    }
  }, [shouldRender]);

  // Track visualViewport for iOS keyboard-aware sheet height
  useEffect(() => {
    if (!shouldRender) return;
    if (typeof window === "undefined" || !window.visualViewport) {
      setViewportHeight(window.innerHeight);
      return;
    }
    const vv = window.visualViewport;
    // Track the visual viewport box so the sheet can sit exactly inside it.
    let layoutHeight = window.innerHeight;
    const update = () => {
      if (vv.height + vv.offsetTop > layoutHeight) {
        layoutHeight = vv.height + vv.offsetTop;
      }
      setViewportHeight(vv.height);
      setVvTop(vv.offsetTop);
      // space below the visual viewport inside the layout viewport (= keyboard + accessory bar)
      setVvBottom(Math.max(0, layoutHeight - vv.offsetTop - vv.height));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [shouldRender]);

  // When keyboard opens (viewport shrinks) or list updates, keep the latest
  // comment visible — but ONLY if user was already near the bottom. This avoids
  // yanking a user who was scrolled up reading older comments (삼순이 리뷰 피드백).
  useEffect(() => {
    if (!shouldRender) return;
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [shouldRender, viewportHeight, comments.length]);

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

  // 댓글 수정 시작
  const startEdit = useCallback((comment: Comment) => {
    setMenuOpenId(null);
    setEditingId(comment.id);
    setEditInput(comment.content);
    setTimeout(() => editInputRef.current?.focus(), 50);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditInput("");
  }, []);

  const saveEdit = useCallback(async () => {
    if (editingId === null || savingEdit) return;
    const trimmed = editInput.trim();
    if (!trimmed) return;

    setSavingEdit(true);
    try {
      await updateComment(editingId, trimmed);
      // optimistic
      setComments((prev) =>
        prev.map((c) =>
          c.id === editingId
            ? { ...c, content: trimmed, updated_at: new Date().toISOString() }
            : c
        )
      );
      setEditingId(null);
      setEditInput("");
      if (postId) refetchComments(postId);
    } catch {
      alert("댓글 수정에 실패했어요");
    } finally {
      setSavingEdit(false);
    }
  }, [editingId, editInput, savingEdit, postId, refetchComments]);

  const handleDelete = useCallback(async (commentId: number) => {
    setMenuOpenId(null);
    if (!confirm("이 댓글을 삭제할까요?")) return;

    try {
      await deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      if (postId) onCommentDeleted?.(postId);
    } catch {
      alert("댓글 삭제에 실패했어요");
    }
  }, [postId, onCommentDeleted]);

  // 외부 클릭 시 메뉴 닫기
  useEffect(() => {
    if (menuOpenId === null) return;
    const handler = () => setMenuOpenId(null);
    const t = setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", handler);
    };
  }, [menuOpenId]);

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

          {/* Sheet — pinned to the visual viewport (defeats iOS focus-into-view jumps). */}
          <motion.div
            ref={sheetRef}
            className="fixed inset-x-0 flex flex-col bg-bg-secondary rounded-t-2xl overflow-hidden"
            style={{
              zIndex: 9999,
              // Top edge of the sheet inside the visual viewport (~8% from the top so you still see backdrop).
              top: viewportHeight
                ? `${vvTop + Math.max(24, viewportHeight * 0.08)}px`
                : "8vh",
              bottom: vvBottom,
              transition: "bottom 120ms ease-out, top 120ms ease-out",
            }}
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
            <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
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
                  const avatarPath = getAvatarPath((comment as Comment & { avatar_url?: string }).avatar_url ?? null);
                  const commentTeam = comment.team_id ? getTeamById(comment.team_id) : undefined;
                  const isMine = !!user && comment.author_id === user.id;
                  const isEditing = editingId === comment.id;
                  const isEdited = !!comment.updated_at;
                  return (
                    <div key={comment.id} className="flex gap-2.5">
                      {avatarPath ? (
                        <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-bg-tertiary">
                          <img src={avatarPath} alt="" className="w-full h-full" />
                        </div>
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                          style={{ backgroundColor: commentTeam ? getTeamBgColor(commentTeam) : '#6B7280' }}
                        >
                          {(comment.nickname || "익")[0]}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-text-primary">
                            {comment.nickname || "익명"}
                          </span>
                          {commentTeam && (
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-md text-white"
                              style={{ backgroundColor: getTeamBgColor(commentTeam) }}
                            >
                              {commentTeam.shortName}
                            </span>
                          )}
                          <span className="text-[11px] text-text-tertiary ml-auto flex-shrink-0">
                            {timeAgo(comment.created_at)}{isEdited ? " · 수정됨" : ""}
                          </span>
                          {isMine && !isEditing && (
                            <div className="relative flex-shrink-0">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMenuOpenId((prev) => (prev === comment.id ? null : comment.id));
                                }}
                                className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                                aria-label="댓글 메뉴"
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {menuOpenId === comment.id && (
                                <div
                                  className="absolute right-0 top-6 z-10 min-w-[96px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    onClick={() => startEdit(comment)}
                                    className="block w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary"
                                  >
                                    수정
                                  </button>
                                  <button
                                    onClick={() => handleDelete(comment.id)}
                                    className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary"
                                  >
                                    삭제
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {isEditing ? (
                          <div className="mt-1 flex items-center gap-1.5">
                            <input
                              ref={editInputRef}
                              type="text"
                              value={editInput}
                              onChange={(e) => setEditInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                  e.preventDefault();
                                  saveEdit();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelEdit();
                                }
                              }}
                              className="flex-1 bg-bg-tertiary rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none border border-border"
                            />
                            <button
                              onClick={saveEdit}
                              disabled={!editInput.trim() || savingEdit}
                              className="flex items-center justify-center w-7 h-7 rounded-full text-white disabled:opacity-50 transition-opacity"
                              style={{ backgroundColor: teamId ? (() => { const t = getTeamById(teamId); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
                              aria-label="저장"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="text-[11px] text-text-tertiary px-1"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <p className="readable-body mt-0.5 break-words">
                            {comment.content}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Input area — flex-none so list (flex-1) absorbs keyboard resize. */}
            <div className="flex-none border-t border-border px-4 py-3" style={{ paddingBottom: vvBottom > 0 ? "0.75rem" : "calc(0.75rem + env(safe-area-inset-bottom))" }}>
              <div className="flex items-center gap-2">
                {user ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onFocus={() => {
                      // When keyboard opens, force-scroll to the latest comment so
                      // the composer never hides already-posted comments.
                      // Multiple passes cover iOS keyboard animation timing
                      // (vv.resize may fire 100-500ms after focusin).
                      const scrollToBottom = () => {
                        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                      };
                      requestAnimationFrame(scrollToBottom);
                      [120, 300, 600].forEach((ms) => setTimeout(scrollToBottom, ms));
                    }}
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
                  className="flex items-center justify-center w-9 h-9 rounded-full text-white disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: teamId ? (() => { const t = getTeamById(teamId); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
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
