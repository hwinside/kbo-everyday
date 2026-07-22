"use client";

import { useCallback } from "react";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import {
  handleNewsArticleAnchorClick,
  openNewsArticle,
} from "@/lib/open-external";
import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

export function useNewsArticleBrowser() {
  const commentsEnabled = useIsAdmin();

  const openArticle = useCallback((article: NewsArticleDiscussion) => {
    openNewsArticle(article, commentsEnabled);
  }, [commentsEnabled]);

  const handleArticleAnchorClick = useCallback((
    event: { preventDefault: () => void },
    article: NewsArticleDiscussion,
  ) => {
    handleNewsArticleAnchorClick(event, article, commentsEnabled);
  }, [commentsEnabled]);

  return { openArticle, handleArticleAnchorClick };
}

