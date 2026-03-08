"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Send } from "lucide-react";
import { GRADES } from "@/lib/constants/grades";
import { usePostDetail, createComment } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  postId: number | null;
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

export default function CommentSheet({ isOpen, onClose, postId }: CommentSheetProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();

  // Only fetch when we have a postId and the sheet is open
  const { comments, loading, setComments } = usePostDetail(postId ?? 0);
  const shouldRender = isOpen && postId !== null;

  // Focus input when opened
  useEffect(() => {
    if (shouldRender) {
      setTimeout(() => inputRef.current?.focus(), 300);
    } else {
      setInput("");
    }
  }, [shouldRender]);

  const handleSubmit = async () => {
    if (!input.trim() || !postId || submitting) return;
    setSubmitting(true);
    try {
      await createComment(postId, input.trim());
      // Optimistic add
      setComments((prev) => [
        ...prev,
        {
          id: Date.now(),
          post_id: postId,
          author_id: user?.id ?? "",
          content: input.trim(),
          created_at: new Date().toISOString(),
          nickname: undefined,
          grade: undefined,
        },
      ]);
      setInput("");
    } catch {
      // silently fail (e.g. not logged in)
    } finally {
      setSubmitting(false);
    }
  };

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {shouldRender && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50 bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col bg-bg-secondary rounded-t-2xl"
            style={{ maxHeight: "85vh", minHeight: "50vh" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-10 h-1 rounded-full bg-text-tertiary/40" />
            </div>

            {/* Header */}
            <div className="px-4 pb-3 border-b border-border">
              <h3 className="text-base font-semibold text-text-primary text-center">댓글</h3>
            </div>

            {/* Comment list */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
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
                  return (
                    <div key={comment.id} className="flex gap-2.5">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                        style={{ backgroundColor: grade.bgColor }}
                      >
                        {grade.emoji}
                      </div>
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

            {/* Input area */}
            <div className="border-t border-border px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="flex items-center gap-2">
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
                  placeholder={user ? "댓글 달기..." : "로그인 후 댓글을 남겨보세요"}
                  disabled={!user}
                  className="flex-1 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50"
                />
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim() || submitting || !user}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-accent text-white disabled:opacity-30 transition-opacity"
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
  );
}
