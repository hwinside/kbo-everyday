"use client";

import { useCallback, useState } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import CommentSheet from "@/components/community/CommentSheet";
import LoginSheet from "@/components/auth/LoginSheet";
import { useAuth } from "@/lib/supabase/AuthContext";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

export type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

interface NewsCommentButtonProps {
  article: NewsArticleDiscussion;
  initialCount?: number;
  showCount?: boolean;
  className?: string;
  onCountChange?: (count: number) => void;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export default function NewsCommentButton({
  article,
  initialCount,
  showCount = false,
  className = "",
  onCountChange,
}: NewsCommentButtonProps) {
  const { user } = useAuth();
  const [postId, setPostId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const displayedCount = count ?? initialCount ?? null;

  const resolveDiscussion = useCallback(async () => {
    const response = await fetch("/api/news/discussion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(article),
    });
    if (!response.ok) throw new Error("discussion unavailable");
    const result = (await response.json()) as { postId: number; commentCount: number };
    setPostId(result.postId);
    setCount(result.commentCount);
    onCountChange?.(result.commentCount);
    return result;
  }, [article, onCountChange]);

  const openComments = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // 미로그인은 ensure(로그인 게이트) 호출 전에 LoginSheet를 선노출한다.
  // 이렇게 해야 401→generic 실패로 끝나지 않고 로그인 후 댓글로 이어진다.
    if (!user) {
      setShowLogin(true);
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      await resolveDiscussion();
      setIsOpen(true);
    } catch {
      alert("댓글을 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  };

  const syncAfterMutation = useCallback((delta: number) => {
    const next = Math.max(0, (displayedCount ?? 0) + delta);
    setCount(next);
    onCountChange?.(next);
    void resolveDiscussion().catch(() => {});
  }, [displayedCount, onCountChange, resolveDiscussion]);

  if (!isHttpUrl(article.url)) return null;

  return (
    <>
      <button
        type="button"
        onClick={openComments}
        disabled={loading}
        className={`inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${className}`}
        aria-label={showCount ? `댓글 ${displayedCount ?? 0}개` : "댓글 열기"}
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
        {/* 미로그인은 count 미조회(삼순: UI 익명 호출 불필요)라 숫자 대신 "댓글" 표기—오표기 방지. */}
        <span>{!user ? "댓글" : showCount ? displayedCount ?? 0 : displayedCount === null ? "댓글" : displayedCount}</span>
      </button>
      {isOpen && postId !== null && (
        <CommentSheet
          isOpen
          onClose={() => setIsOpen(false)}
          postId={postId}
          teamId={article.teamId}
          onCommentAdded={() => syncAfterMutation(1)}
          onCommentDeleted={(_postId, removedCount = 1) => syncAfterMutation(-removedCount)}
        />
      )}
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
    </>
  );
}
