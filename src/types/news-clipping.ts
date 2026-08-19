// 뉴스클리핑 쪽지 payload — 서버(cron)와 클라(쪽지 카드 렌더)가 공유하는 타입.
//
// 2026-08-20 정규화: 기사 묶음(articles/overview)은 news_clipping_digests 로 옮기고 쪽지
// payload 는 digest_id 참조 + 유저 고유 필드(intro)만 갖는다. 같은 기사 묶음을 수신자
// 수만큼 복제하던 구조(8/18 KIA 6,102행 / distinct 120, 약 55MB/일)를 끊기 위함.
//
// 과거 쪽지 수백만 건은 그대로 남는다(대량 재작성 금지). 따라서 아래 두 형태가 공존하며
// 클라이언트는 **둘 다** 렌더해야 한다:
//   - Legacy: { type, team_id, team_name, date, overview, articles, intro? }
//   - Ref:    { type, team_id, team_name, date, digest_id, intro? }

export interface NewsClippingArticle {
  title: string;
  /** 클릭 이동 URL (네이버 뉴스) */
  link: string;
  /** 동일 기사 댓글방 식별용 언론사 원문 URL (과거 payload에는 없을 수 있음) */
  original_link?: string;
  /** OG 이미지 — 없으면 제목형 카드 */
  thumbnail_url: string | null;
  /** LLM 3줄 요약 (무슨 일 / 구체 내용 / 팀 팬 관점 의미) */
  summary: string[];
}

/** 쪽지 payload 공통 필드 (legacy/ref 양쪽) */
interface NewsClippingBase {
  type: "news_clipping";
  team_id: number;
  /** 팀 풀네임 (예: "LG 트윈스") — 푸시 문구/카드 헤더 공용 */
  team_name: string;
  /** 기사 기준일 (어제, YYYY-MM-DD) */
  date: string;
  /** 유저별 최초 수신 클리핑에만 포함되는 서비스 소개 인트로 (닉네임/팀명 치환, 하린아빠 지정 문구) */
  intro?: string;
}

/** 2026-08-20 이전 발송분 — 기사 묶음을 payload 안에 통째로 들고 있다. */
export interface NewsClippingLegacyPayload extends NewsClippingBase {
  /** 데일리 총평 한 줄 */
  overview: string;
  articles: NewsClippingArticle[];
  digest_id?: undefined;
}

/** 2026-08-20 이후 발송분 — 기사 묶음은 news_clipping_digests 에 1행으로 존재한다. */
export interface NewsClippingRefPayload extends NewsClippingBase {
  digest_id: number;
  /** 참조형에는 없다. 총평은 digest 에서 읽는다. */
  overview?: undefined;
  articles?: undefined;
}

export type NewsClippingPayload = NewsClippingLegacyPayload | NewsClippingRefPayload;

/** digest 테이블 1행 (클라가 참조형 payload 를 렌더할 때 조회) */
export interface NewsClippingDigest {
  id: number;
  clip_date: string;
  team_id: number;
  team_name: string;
  overview: string;
  articles: NewsClippingArticle[];
}

/** 카드 렌더에 필요한 최종 형태 — legacy 든 ref 든 이 모양으로 정규화해서 넘긴다. */
export interface NewsClippingView {
  team_name: string;
  date: string;
  overview: string;
  intro?: string;
  team_id: number;
  articles: NewsClippingArticle[];
}

function isBase(p: unknown): p is NewsClippingBase & Record<string, unknown> {
  if (!p || typeof p !== "object") return false;
  return (p as { type?: unknown }).type === "news_clipping";
}

/** 기사 묶음을 payload 안에 들고 있는 과거 형태인가. */
export function isLegacyNewsClippingPayload(p: unknown): p is NewsClippingLegacyPayload {
  if (!isBase(p)) return false;
  const articles = (p as { articles?: unknown }).articles;
  return Array.isArray(articles) && articles.length > 0;
}

/** digest 를 참조하는 신규 형태인가. */
export function isRefNewsClippingPayload(p: unknown): p is NewsClippingRefPayload {
  if (!isBase(p)) return false;
  const id = (p as { digest_id?: unknown }).digest_id;
  return typeof id === "number" && Number.isFinite(id) && id > 0;
}

/**
 * 클리핑 쪽지인가 (legacy | ref).
 *
 * ⚠️ 기존 isNewsClippingPayload 는 `articles.length > 0` 을 요구했다. 참조형은 articles 가
 * 없으므로 그 술어를 그대로 두면 **신규 쪽지가 전부 일반 텍스트로 렌더**된다. 술어를 바꾸면
 * 이 술어를 쓰는 모든 호출부가 영향을 받으므로 이름을 유지하되 의미를 확장한다(호출부 grep 완료).
 */
export function isNewsClippingPayload(p: unknown): p is NewsClippingPayload {
  return isLegacyNewsClippingPayload(p) || isRefNewsClippingPayload(p);
}

/**
 * 렌더용 정규화. 참조형이면 digest 가 필요하다.
 *
 * digest 가 아직 안 왔거나(로딩) 조회에 실패하면 **null 을 반환해 fail-close** 한다 —
 * 빈 카드를 그리면 "오늘 기사가 없다"는 거짓 정보가 되기 때문이다. 호출부는 null 일 때
 * 카드 대신 텍스트 본문(content)을 렌더한다.
 */
export function toNewsClippingView(
  payload: NewsClippingPayload,
  digest: NewsClippingDigest | null | undefined,
): NewsClippingView | null {
  if (isLegacyNewsClippingPayload(payload)) {
    return {
      team_id: payload.team_id,
      team_name: payload.team_name,
      date: payload.date,
      overview: payload.overview ?? "",
      intro: payload.intro,
      articles: payload.articles,
    };
  }
  if (!digest || !Array.isArray(digest.articles) || digest.articles.length === 0) return null;
  return {
    // 쪽지 payload 의 team/date 를 우선한다(발송 당시 사실). digest 는 기사만 제공.
    team_id: payload.team_id,
    team_name: payload.team_name || digest.team_name,
    date: payload.date || digest.clip_date,
    overview: digest.overview ?? "",
    intro: payload.intro,
    articles: digest.articles,
  };
}
