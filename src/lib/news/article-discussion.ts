export interface NewsArticleDiscussion {
  url: string;
  canonicalUrl?: string | null;
  title: string;
  source?: string | null;
  thumbnailUrl?: string | null;
  teamId?: number | null;
  /** 조회수 서명(/api/news 발급) — 없으면 조회수 미집계(best-effort). */
  viewToken?: string | null;
}

