import type { NewsArticleDiscussion } from "@/lib/news/article-discussion";

/**
 * 유튜브 숏츠 영상을 뉴스 댓글 인프라가 쓰는 NewsArticleDiscussion으로 매핑한다.
 * watch URL은 normalizeArticleUrl에서 v 파라미터가 보존돼 안정적인 articleKey가 된다.
 */
export function youtubeShortsDiscussion(input: {
  videoId: string;
  title: string;
  thumbnailUrl?: string | null;
  teamId?: number | null;
}): NewsArticleDiscussion {
  return {
    url: `https://www.youtube.com/watch?v=${input.videoId}`,
    title: input.title,
    thumbnailUrl: input.thumbnailUrl ?? null,
    teamId: input.teamId ?? null,
  };
}
