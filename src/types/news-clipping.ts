// 뉴스클리핑 쪽지 payload — 서버(cron)와 클라(쪽지 카드 렌더)가 공유하는 타입.

export interface NewsClippingArticle {
  title: string;
  /** 클릭 이동 URL (네이버 뉴스) */
  link: string;
  /** OG 이미지 — 없으면 제목형 카드 */
  thumbnail_url: string | null;
  /** LLM 3줄 요약 (무슨 일 / 구체 내용 / 팀 팬 관점 의미) */
  summary: string[];
}

export interface NewsClippingPayload {
  type: "news_clipping";
  team_id: number;
  /** 팀 풀네임 (예: "LG 트윈스") — 푸시 문구/카드 헤더 공용 */
  team_name: string;
  /** 기사 기준일 (어제, YYYY-MM-DD) */
  date: string;
  /** 데일리 총평 한 줄 */
  overview: string;
  /** 유저별 최초 수신 클리핑에만 포함되는 서비스 소개 인트로 (닉네임/팀명 치환, 하린아빠 지정 문구) */
  intro?: string;
  articles: NewsClippingArticle[];
}

export function isNewsClippingPayload(p: unknown): p is NewsClippingPayload {
  if (!p || typeof p !== "object") return false;
  const obj = p as { type?: unknown; articles?: unknown };
  return obj.type === "news_clipping" && Array.isArray(obj.articles) && obj.articles.length > 0;
}
