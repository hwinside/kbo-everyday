"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import CommentSheet from "@/components/community/CommentSheet";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

type NativeMessage =
  | { type: "close" }
  | { type: "ready"; count: number }
  | { type: "count"; count: number };

interface NativeCommentsWindow extends Window {
  webkit?: {
    messageHandlers?: {
      NewsCommentsBridge?: { postMessage: (message: NativeMessage) => void };
    };
  };
  NewsCommentsBridge?: { postMessage: (message: string) => void };
}

function postNativeMessage(message: NativeMessage): boolean {
  const nativeWindow = window as NativeCommentsWindow;
  let delivered = false;
  try {
    nativeWindow.webkit?.messageHandlers?.NewsCommentsBridge?.postMessage(message);
    delivered = Boolean(nativeWindow.webkit?.messageHandlers?.NewsCommentsBridge);
  } catch {
    // Android bridge may still be available.
  }
  try {
    nativeWindow.NewsCommentsBridge?.postMessage(JSON.stringify(message));
    delivered = delivered || Boolean(nativeWindow.NewsCommentsBridge);
  } catch {
    // Browser preview has no native bridge.
  }
  return delivered;
}

function parseTeamId(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}

export default function NativeNewsCommentsClient() {
  const searchParams = useSearchParams();
  const article = useMemo<NewsArticleDiscussion>(() => ({
    url: searchParams.get("url") ?? "",
    canonicalUrl: searchParams.get("canonicalUrl"),
    title: searchParams.get("title") ?? "",
    source: searchParams.get("source"),
    thumbnailUrl: searchParams.get("thumbnailUrl"),
    teamId: parseTeamId(searchParams.get("teamId")),
  }), [searchParams]);
  const [postId, setPostId] = useState<number | null>(null);
  const [, setCount] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/news/discussion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(article),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("discussion unavailable");
        return response.json() as Promise<{ postId: number; commentCount: number }>;
      })
      .then((result) => {
        if (cancelled) return;
        setPostId(result.postId);
        setCount(result.commentCount);
        postNativeMessage({ type: "ready", count: result.commentCount });
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [article]);

  const close = useCallback(() => {
    if (postNativeMessage({ type: "close" })) {
      // CommentSheet의 닫힘 상태를 초기화해 다음 오픈도 입장 애니메이션부터 시작한다.
      window.setTimeout(() => window.location.reload(), 150);
    } else {
      window.history.back();
    }
  }, []);

  const changeCount = useCallback((delta: number) => {
    setCount((previous) => {
      const next = Math.max(0, previous + delta);
      postNativeMessage({ type: "count", count: next });
      return next;
    });
  }, []);

  if (error) {
    return (
      <main className="fixed inset-0 flex items-end bg-black/45">
        <div className="w-full rounded-t-3xl bg-bg-secondary px-5 pb-[calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom))+20px)] pt-5 text-center">
          <p className="text-sm text-text-secondary">댓글을 불러오지 못했어요</p>
          <button type="button" onClick={close} className="mt-4 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white">
            닫기
          </button>
        </div>
      </main>
    );
  }

  if (postId === null) {
    return (
      <main className="fixed inset-0 flex items-end bg-black/25">
        <div className="w-full rounded-t-3xl bg-bg-secondary px-5 pb-[calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom))+24px)] pt-6 text-center text-sm text-text-secondary">
          댓글을 불러오는 중...
        </div>
      </main>
    );
  }

  return (
    <CommentSheet
      isOpen
      onClose={close}
      postId={postId}
      teamId={article.teamId}
      onCommentAdded={() => changeCount(1)}
      onCommentDeleted={(_deletedPostId, removedCount = 1) => changeCount(-removedCount)}
    />
  );
}
