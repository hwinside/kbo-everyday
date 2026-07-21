"use client";

import { useCallback, useState } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";
import CommentSheet from "@/components/community/CommentSheet";

export interface NewsArticleDiscussion {
  url: string;
  canonicalUrl?: string | null;
  title: string;
  source?: string | null;
  thumbnailUrl?: string | null;
  teamId?: number | null;
}

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
  const [postId, setPostId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
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
    <AdminOnly>
      <>
        <button
          type="button"
          onClick={openComments}
          disabled={loading}
          className={`inline-flex min-h-7 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${className}`}
          aria-label={showCount ? `댓글 ${displayedCount ?? 0}개` : "댓글 열기"}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
          <span>{showCount ? displayedCount ?? 0 : displayedCount === null ? "댓글" : displayedCount}</span>
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
      </>
    </AdminOnly>
  );
}
