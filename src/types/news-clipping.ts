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
  /**
   * payload 스키마 버전. **신규 발송분에만 붙는다.**
   *
   * ⚠️ 삼순 blocker 2 (2026-08-20, 3차): `push_preview` 유무로 신구를 구분하면 "신규인데
   *    총평이 비어 preview 가 undefined" 인 경우와 "구형 ref" 가 원리적으로 구분되지 않는다.
   *    그러면 dispatch 가 per-DM digest SELECT 로 떨어지고(하루 27,208회) 그 사실이 조용하다.
   *    → 버전을 명시 필드로 갖고, **v1 이상이면 preview 는 반드시 비어있지 않다**를 계약으로 건다.
   *    조회 폴백은 버전이 없는 구형 ref 에만 허용한다.
   */
  v?: number;
  /**
   * 푸시 본문용 짧은 미리보기(총평 앞부분).
   *
   * ⚠️ 삼순 blocker 2 (2026-08-20): 참조형은 overview 가 없어서 푸시 디스패쳐가 매번 digest 를
   *    다시 SELECT 해야 했다 — 하루 27,208건 발송이면 **DB 조회 27,208회가 추가**된다.
   *    디스크 줄이려다 읽기 부하를 만드는 교환은 손해다.
   *    → 푸시에 필요한 만큼만(수십 바이트) 쪽지 payload 에 남긴다. 전체 articles(3.5KB)는 여전히 digest 에만.
   */
  push_preview?: string;
  /** 참조형에는 없다. 카드용 총평은 digest 에서 읽는다. */
  overview?: undefined;
  articles?: undefined;
}

/** 푸시 미리보기 최대 길이 — 푸시 본문은 어차피 잘리므로 길게 가질 이유가 없다. */
export const NEWS_CLIPPING_PUSH_PREVIEW_MAX = 120;

/** 신규 참조형 payload 스키마 버전. 이 값이 붙어 있으면 push_preview 는 비어있지 않다. */
export const NEWS_CLIPPING_REF_VERSION = 1;

/**
 * 총평이 비었을 때 쓰는 기본 푸시 문구.
 *
 * ⚠️ 이 상수의 존재 이유: 총평이 빈 날에도 preview 를 **반드시 채워** dispatch 가
 *    digest 를 재조회하지 않게 한다. dispatch 의 `truncate(... || "어제의 주요 뉴스를
 *    확인해보세요")` 와 같은 문구라 유저가 보는 결과는 종전과 동일하다.
 */
export const NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK = "어제의 주요 뉴스를 확인해보세요";

/**
 * 총평에서 푸시용 미리보기를 만든다. **절대 빈 값을 돌려주지 않는다.**
 *
 * 빈 값을 허용하면 신규 발송에서도 push_preview 가 사라져 per-DM digest 조회가 부활한다
 * (삼순 blocker 2, 3차). 총평이 비면 기본 문구로 채운다.
 */
export function toPushPreview(overview: string | null | undefined): string {
  const text = (overview ?? "").trim();
  if (!text) return NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK;
  return text.length <= NEWS_CLIPPING_PUSH_PREVIEW_MAX
    ? text
    : `${text.slice(0, NEWS_CLIPPING_PUSH_PREVIEW_MAX - 1)}…`;
}

/**
 * 이 참조형 payload 가 **자기 힘으로 푸시 본문을 만들 수 있는가**(digest 조회 불필요).
 *
 * dispatch 는 이 술어가 false 일 때만 digest 를 SELECT 한다. 신규 발송분(v>=1)은 항상
 * true 여야 하며, 그 불변식은 게이트가 고정한다.
 */
export function hasSelfContainedPushBody(p: NewsClippingRefPayload): boolean {
  return typeof p.push_preview === "string" && p.push_preview.trim().length > 0;
}

/** 구형 참조형(버전 필드 없음) — dispatch 의 digest 조회 폴백이 허용되는 유일한 경우. */
export function isLegacyRefPayload(p: NewsClippingRefPayload): boolean {
  return typeof p.v !== "number";
}

/** 푸시 디스패쳐가 보는 쪽지 payload 의 최소 형태(패스스루 검증 전이라 전부 optional). */
export interface PushDispatchClipping {
  overview?: string;
  push_preview?: string;
  digest_id?: number;
  v?: number;
}

/**
 * 푸시 발송 시 **digest 를 추가 SELECT 해야 하는가**.
 *
 * 이 술어가 이 PR 의 비용 계약이다 — 하루 27,208건 발송이므로 true 가 되는 경우가 늘어나면
 * 디스크를 줄이고 읽기 부하를 사는 교환이 된다. 그래서 dispatch 안에 묻지 않고 꺼내
 * 게이트가 직접 대조한다.
 *
 * 계약:
 *  - 사용 가능한 본문(overview | push_preview)이 있으면 조회 안 함.
 *  - **신규 참조형(v>=1)은 어떤 입력에서도 조회 안 함** — 총평이 비어 preview 가 비더라도.
 *    (preview 유무로 신·구를 가르면 이 경우가 구형과 구분되지 않아 조회가 조용히 부활한다.)
 *  - 구형 ref(버전 없음) + 본문 없음 + digest_id 있음 → 그때만 true.
 */
export function shouldFetchDigestForPush(p: PushDispatchClipping): boolean {
  const body = p.overview ?? p.push_preview;
  if (typeof body === "string" && body.trim().length > 0) return false;
  if (typeof p.v === "number" && p.v >= 1) return false;
  return typeof p.digest_id === "number" && Number.isFinite(p.digest_id) && p.digest_id > 0;
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
