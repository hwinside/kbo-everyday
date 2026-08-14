"use client";

import { useCallback } from "react";
import {
  handleNewsArticleAnchorClick,
  openNewsArticle,
} from "@/lib/open-external";
import { useAuth } from "@/lib/supabase/AuthContext";
import { trackNewsView } from "@/lib/content-views/tracker";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

// 댓글은 로그인 유저에게 열린다(admin-only 해제 = 전체 로그인 유저, PR #818 선례
// 동일 계약). 미로그인은 인앱 브라우저 댓글바를 배선하지 않고(commentsEnabled=false),
// 인피드 CTA는 댓글 버튼이 LoginSheet로 유도한다. 대글 작성은 CommentSheet가 다시 막는다.
export function useNewsArticleBrowser() {
  const { user } = useAuth();
  const commentsEnabled = Boolean(user);

  const openArticle = useCallback((article: NewsArticleDiscussion) => {
    // 조회수 +1 (best-effort, 관리자 전용 표시) — 모든 뉴스 원문 열기의 SSOT 초크포인트.
    trackNewsView(article.url, article.canonicalUrl);
    openNewsArticle(article, commentsEnabled);
  }, [commentsEnabled]);

  const handleArticleAnchorClick = useCallback((
    event: { preventDefault: () => void },
    article: NewsArticleDiscussion,
  ) => {
    trackNewsView(article.url, article.canonicalUrl);
    handleNewsArticleAnchorClick(event, article, commentsEnabled);
  }, [commentsEnabled]);

  return { openArticle, handleArticleAnchorClick };
}

