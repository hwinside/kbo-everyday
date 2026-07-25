"use client";

import { useCallback } from "react";
import {
  handleNewsArticleAnchorClick,
  openNewsArticle,
} from "@/lib/open-external";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

// 댓글은 모든 유저에게 열린다. 작성은 CommentSheet(user 필수)가, 그 이전 단계인
// discussion ensure는 서버 로그인 게이트가 다시 막는다.
const commentsEnabled = true;

export function useNewsArticleBrowser() {
  const openArticle = useCallback((article: NewsArticleDiscussion) => {
    openNewsArticle(article, commentsEnabled);
  }, []);

  const handleArticleAnchorClick = useCallback((
    event: { preventDefault: () => void },
    article: NewsArticleDiscussion,
  ) => {
    handleNewsArticleAnchorClick(event, article, commentsEnabled);
  }, []);

  return { openArticle, handleArticleAnchorClick };
}

