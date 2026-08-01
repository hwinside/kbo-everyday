/**
 * 나무위키 수집 게이트 (spec rev0.7 §12.2) — **순수/네트워크 판정 계약만** 담는다.
 *
 * 계약:
 *  (a) robots.txt 확인기록이 없는 source는 수집하지 않는다. `assertRobotsAllowed`가 실제 robots.txt를
 *      받아 `Allow: /w/`를 확인하고, 그 확인기록을 provenance에 남긴다.
 *  (b) 로그인·유료·봇차단 우회를 하지 않는다. **Cloudflare 403은 우회 대상이 아니라 `blocked` 사유다.**
 *      브라우저 위장 UA·쿠키 주입·challenge solver는 이 모듈에 존재하지 않으며 추가해서도 안 된다.
 *  (c) 원문 전문을 저장하지 않는다. 이 모듈은 응답 본문을 반환만 하고, 저장 단위는 chunk + provenance다.
 *
 * 2026-08-01 (R3 정정): plain `fetch` 경로는 여전히 Cloudflare 403이지만, **실제 Chrome을
 * 요청마다 새로 띄우고 10초 간격을 두면 정상 200**임이 실측됐다(8/8 200). 그 실크롤 구현은
 * Playwright 의존 때문에 서버 런타임에 올릴 수 없으므로 **수집 스크립트 쪽**에 둔다:
 *   `scripts/baseball-qa/rag/fetch-namu-browser.ts`
 * 이 모듈(=서버 번들에 들어갈 수 있는 `src/`)은 판정 계약(robots/blocked 분류/본문 추출)만 갖고,
 * Playwright를 import하지 않는다. 회귀가 이 경계를 고정한다.
 */

/** 정직한 자기식별 UA. 브라우저 위장 금지 — 위장은 §12.2 (b) 위반이다. */
export const RAG_USER_AGENT = "keubofan-rag/1.0 (+https://keubo.fan; contact: ops@keubo.fan)";
export const NAMU_ROBOTS_URL = "https://namu.wiki/robots.txt";
/**
 * bounded rate: 연속 요청 사이 최소 간격 (§12.2 b).
 * 실크롤(브라우저) 경로의 실측 하한이다 — 2.5초 연타는 403을 유발했고 10초 간격 8연속은 8/8 200이었다.
 * 이 값은 수집 스크립트가 **반드시** 지켜야 하며, 브라우저 fetcher는 호출자에 의존하지 않고 스스로 강제한다.
 */
export const RAG_FETCH_INTERVAL_MS = 10_000;
export const RAG_FETCH_TIMEOUT_MS = 15_000;

export type RobotsVerdict =
  | { ok: true; allowRule: string; checkedAt: string }
  | { ok: false; reason: string };

/** robots.txt에서 `/w/` 접두 경로가 명시 허용되는지 확인한다. */
export function evaluateNamuRobots(robotsTxt: string): RobotsVerdict {
  const lines = robotsTxt.split(/\r?\n/).map((line) => line.trim());
  const allow = lines.find((line) => /^Allow:\s*\/w\/\s*$/i.test(line));
  if (!allow) return { ok: false, reason: "allow_w_rule_absent" };
  return { ok: true, allowRule: allow, checkedAt: new Date().toISOString() };
}

export async function assertRobotsAllowed(fetchImpl: typeof fetch = fetch): Promise<RobotsVerdict> {
  try {
    const response = await fetchImpl(NAMU_ROBOTS_URL, {
      headers: { "User-Agent": RAG_USER_AGENT },
      signal: AbortSignal.timeout(RAG_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `robots_http_${response.status}` };
    return evaluateNamuRobots(await response.text());
  } catch {
    return { ok: false, reason: "robots_fetch_failed" };
  }
}

export type FetchDocResult =
  | {
      ok: true;
      /** 요청한 후보 URL. canonical 확정은 이 값이 아니라 `url`(최종 도달 URL) 기준이다(§12.2 d). */
      requestedUrl: string;
      /** redirect를 따라간 뒤의 최종 URL. */
      url: string;
      html: string;
      revision: string;
      crawledAt: string;
    }
  | { ok: false; status: "missing" | "blocked"; reason: string; httpStatus?: number };

/**
 * 봇차단(403/429/503)은 `blocked`, 문서 부재(404/410)는 `missing`으로 나눈다.
 * 재시도는 하지 않는다 — 차단 응답을 반복 요청하는 것은 bounded rate 계약(§12.2 b) 위반이다.
 */
export function classifyFetchFailure(httpStatus: number): { status: "missing" | "blocked"; reason: string } {
  if (httpStatus === 404 || httpStatus === 410) {
    return { status: "missing", reason: `document_absent_http_${httpStatus}` };
  }
  if (httpStatus === 403 || httpStatus === 429 || httpStatus === 503) {
    return { status: "blocked", reason: `bot_protection_http_${httpStatus}` };
  }
  return { status: "blocked", reason: `unexpected_http_${httpStatus}` };
}

/** ETag/Last-Modified를 revision으로 쓴다. 둘 다 없으면 크롤 시각을 revision으로 삼는다. */
export function deriveRevision(headers: Headers, crawledAt: string): string {
  const etag = headers.get("etag")?.trim();
  if (etag) return `etag:${etag.replace(/^W\//, "").replace(/"/g, "")}`;
  const lastModified = headers.get("last-modified")?.trim();
  if (lastModified) return `lastmod:${lastModified}`;
  return `crawled:${crawledAt}`;
}

/**
 * 차단 페이지 본문 시그니처.
 * Cloudflare challenge는 200으로 오기도 하고, namu 자체 차단 안내는 `been blocked` 문구를 쓴다.
 * 이 판정은 plain fetch 경로와 브라우저 경로가 **같은 함수**를 쓴다 — 경로마다 기준이 갈리면
 * 한쪽에서 차단 페이지가 문서로 저장된다.
 */
export function isBlockedDocumentBody(html: string): boolean {
  return /Attention Required!|cf-browser-verification|Just a moment\.\.\.|been blocked|Verifying you are human/i.test(html);
}

export async function fetchNamuDocument(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchDocResult> {
  const crawledAt = new Date().toISOString();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": RAG_USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(RAG_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: "blocked", reason: "fetch_failed" };
  }
  if (!response.ok) {
    const failure = classifyFetchFailure(response.status);
    return { ok: false, ...failure, httpStatus: response.status };
  }
  const html = await response.text();
  // 200으로 오는 challenge/차단 페이지도 blocked다 — 본문으로 판별한다.
  if (isBlockedDocumentBody(html)) {
    return { ok: false, status: "blocked", reason: "bot_protection_challenge_body" };
  }
  return {
    ok: true,
    requestedUrl: url,
    url: response.url || url,
    html,
    revision: deriveRevision(response.headers, crawledAt),
    crawledAt,
  };
}

/** 나무위키 HTML에서 본문 텍스트만 뽑는다(스크립트/스타일 제거). 원문 전문 저장은 하지 않는다. */
export function extractDocumentText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
