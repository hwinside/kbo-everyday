/**
 * 나무위키 실크롤 fetcher — **수집 스크립트 전용**이다 (R3, 2026-08-01).
 *
 * ⚠️ 위치 계약: 이 모듈은 `scripts/` 아래에 있고 **`src/` 서빙 경로가 절대 import하지 않는다.**
 * Playwright는 Vercel 서버리스 런타임에 올라가지 않으므로, 서빙 코드가 이걸 참조하는 순간
 * 프로덕션 빌드가 깨지거나(번들 실패) 런타임에서 죽는다. 회귀(`qa:baseball-rag-serving`)가
 * "`src/` 전체에 playwright import 0건"과 "pipeline.ts가 이 모듈을 참조하지 않음"을 고정한다.
 *
 * ── 왜 브라우저인가 (2026-08-01 실측) ────────────────────────────────────────────
 * namu.wiki의 Cloudflare 403은 "봇 차단"이 아니라 **같은 브라우저 세션의 연속 요청**이 트리거였다.
 * 아래 조건이면 정직한 접근으로 정상 200이 온다(하린아빠 로컬 실측 + 본 리비전 재현):
 *   - 실제 Chrome 채널(`channel: "chrome"`), headed(`headless: false`)
 *   - 요청마다 브라우저 완전 재기동 (launch → 1페이지 → close)
 *   - 요청 간 최소 10초 간격
 * 실패 케이스(참고): headless 403 / 같은 브라우저 2.5초 연타 시 2번째부터 403 / persistent 프로필 403.
 *
 * ── §12.2(b) 접근제한 우회 금지 — 이 모듈이 하지 않는 것 ──────────────────────────
 * 아래는 **존재하지 않으며 추가해서도 안 된다.** 회귀가 소스 텍스트로 이를 고정한다.
 *   - 브라우저 위장 UA 주입 (`setUserAgent`/`userAgent` 옵션 없음 — 실제 Chrome이 보내는 UA 그대로)
 *   - Cloudflare challenge solver / captcha 우회
 *   - 쿠키·스토리지 재사용 (`storageState` 없음, 요청마다 새 컨텍스트)
 *   - persistent 프로필 (`launchPersistentContext` 없음)
 *   - 로그인·유료 우회
 * 하는 것은 딱 하나다: **요청 빈도를 스스로 낮추는 것**(bounded rate). 이는 §12.2(b)가 요구하는
 * 방향과 같다 — 상대 서버 부하를 줄이는 쪽이다.
 *
 * blocked를 만나면 **즉시 중단한다.** 차단 응답을 재시도로 두들기는 것이 바로 §12.2(b) 위반이다.
 */

import { chromium, type Browser } from "playwright";

import {
  classifyFetchFailure,
  isBlockedDocumentBody,
  RAG_FETCH_TIMEOUT_MS,
  type FetchDocResult,
} from "../../../src/lib/baseball-qa/rag/fetch-namu";
import {
  documentTitleFromUrl,
  normalizeDocumentUrl,
  normalizeTitle,
  verifyCanonicalIdentity,
  verifyCanonicalSubdocumentIdentity,
  type PlayerDocumentIdentity,
} from "../../../src/lib/baseball-qa/rag/canonical";
import {
  extractNamuReferenceDocLinks,
  NAMU_MAX_REFERENCE_DOCS_PER_ENTITY,
  verifyCanonicalReferenceDocumentIdentity,
} from "../../../src/lib/baseball-qa/rag/reference-docs";

/**
 * 요청 간 최소 간격 (bounded rate, §12.2 b).
 * 10초는 실측 하한이다 — 2.5초 연타는 403을 유발했고 10초 간격 8연속은 8/8 200이었다.
 * 호출자가 지키는 것에 의존하지 않고 **이 모듈이 강제한다**(`enforceInterval`).
 */
export const NAMU_BROWSER_MIN_INTERVAL_MS = 10_000;
/** 메인(depth 1)부터 하위문서 depth 3까지만 수집한다. */
export const NAMU_MAX_CRAWL_DEPTH = 3;
/** 최정 실측 고유 문서 20+건에 약 40% 여유를 둔 상한(최대 약 5분/선수). */
export const NAMU_MAX_DOCUMENTS_PER_ENTITY = 30;

let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 직전 요청으로부터 최소 간격이 지날 때까지 대기한다. 호출자가 잊어도 간격이 지켜진다. */
export async function enforceInterval(minIntervalMs = NAMU_BROWSER_MIN_INTERVAL_MS): Promise<number> {
  const waited = Math.max(0, minIntervalMs - (Date.now() - lastRequestAt));
  if (waited > 0) await sleep(waited);
  lastRequestAt = Date.now();
  return waited;
}

/** 테스트/스크립트 재시작용 — 간격 타이머 초기화. */
export function resetIntervalClock(): void {
  lastRequestAt = 0;
}

export interface BrowserFetchOptions {
  /** 요청 간 최소 간격(ms). 기본 10초. */
  minIntervalMs?: number;
  /** 페이지 로드 타임아웃(ms). */
  timeoutMs?: number;
}

export interface NamuEntityCrawlOptions extends BrowserFetchOptions {
  maxDepth?: number;
  maxDocuments?: number;
  /** 회귀/실측 주입점. 기본값은 요청마다 Chrome을 재기동하는 실 fetcher다. */
  fetchDocument?: (url: string) => Promise<FetchDocResult>;
}

export interface NamuCrawledDocument {
  /**
   * `entity` = 메인/하위문서(root prefix 계약). `reference` = entity 본문의 닫힌 참조
   * 표기(`<a>X</a> 문서 참고`)에서 발견돼 양방향 결속 게이트를 통과한 standalone 문서
   * (2026-08-19 맛자욱 P0 — `reference-docs.ts` 계약 참조).
   */
  kind: "entity" | "reference";
  depth: number;
  requestedUrl: string;
  canonicalUrl: string;
  pageTitle: string;
  /** decoded 나무위키 계층 경로. chunk provenance에 그대로 저장한다. */
  sectionPath: string;
  html: string;
  revision: string;
  crawledAt: string;
}

export type NamuEntityCrawlResult =
  | {
      ok: true;
      entityRootTitle: string;
      documents: NamuCrawledDocument[];
      /** prefix 후보였지만 missing/canonical 불일치라 적재하지 않은 문서 추적. */
      rejected: { url: string; reason: string }[];
    }
  | { ok: false; status: "blocked" | "invalid"; reason: string };

/** HTML attribute에서 필요한 최소 entity decode. URL parser가 percent decode는 별도로 처리한다. */
function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/**
 * 같은 선수의 **고유 하위문서 URL**만 정규화한다.
 * fragment/query는 `normalizeDocumentUrl`이 버리므로 `#s-2.1` 앵커는 같은 문서 1건으로 dedupe된다.
 */
export function normalizeNamuEntitySubdocumentUrl(
  href: string,
  baseUrl: string,
  entityRootTitle: string,
): string | null {
  const normalized = normalizeDocumentUrl(decodeHtmlAttribute(href), baseUrl);
  if (!normalized) return null;
  const title = documentTitleFromUrl(normalized);
  const root = normalizeTitle(entityRootTitle);
  if (!title || !title.startsWith(`${root}/`)) return null;
  return normalized;
}

/** anchor 중복·외부 prefix를 제거한, 문서 순서 기준 고유 하위문서 목록. */
export function extractNamuEntitySubdocumentUrls(
  html: string,
  baseUrl: string,
  entityRootTitle: string,
): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const normalized = normalizeNamuEntitySubdocumentUrl(match[1], baseUrl, entityRootTitle);
    if (normalized && !found.includes(normalized)) found.push(normalized);
  }
  return found;
}

/**
 * 메인(depth 1) → 하위(depth 2) → 손자(depth 3)를 BFS로 수집한다.
 *
 * - 발견·요청 URL 모두 메인 canonical title prefix 안으로 제한한다.
 * - depth 4로 이어지는 링크가 발견되거나 unique 문서가 상한을 넘으면 **일부만 적재하지 않고
 *   entity 전체를 fail-close**한다. 폭주를 조용히 truncate하면 수집 완전성 상태가 거짓이 된다.
 * - 각 요청은 기본 fetcher를 통하므로 문서마다 10초 간격 + 브라우저 완전 재기동이 강제된다.
 */
export async function crawlNamuEntityDocuments(
  rootUrl: string,
  identity: PlayerDocumentIdentity,
  options: NamuEntityCrawlOptions = {},
): Promise<NamuEntityCrawlResult> {
  const maxDepth = options.maxDepth ?? NAMU_MAX_CRAWL_DEPTH;
  const maxDocuments = options.maxDocuments ?? NAMU_MAX_DOCUMENTS_PER_ENTITY;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > NAMU_MAX_CRAWL_DEPTH) {
    return { ok: false, status: "invalid", reason: "invalid_crawl_depth_bound" };
  }
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > NAMU_MAX_DOCUMENTS_PER_ENTITY) {
    return { ok: false, status: "invalid", reason: "invalid_document_limit_bound" };
  }

  const normalizedRoot = normalizeDocumentUrl(rootUrl);
  if (!normalizedRoot) return { ok: false, status: "invalid", reason: "root_url_out_of_contract" };
  const fetchDocument = options.fetchDocument ?? ((url: string) => fetchNamuDocumentViaBrowser(url, options));
  interface QueueEntry {
    url: string;
    depth: number;
    kind: "entity" | "reference";
    /** reference 전용 — 발견 시점 앵커 제목(canonical 대조 대상). */
    anchorTitle?: string;
  }
  const queue: QueueEntry[] = [{ url: normalizedRoot, depth: 1, kind: "entity" }];
  const seen = new Set<string>([normalizedRoot]);
  const documents: NamuCrawledDocument[] = [];
  const rejected: { url: string; reason: string }[] = [];
  let entityRootTitle: string | null = null;
  let referenceCount = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    // 참조문서는 leaf(자식 확장 없음)라 depth 상한 계약의 대상이 아니다 — 개수 상한이 방어선이다.
    if (current.kind === "entity" && current.depth > maxDepth) {
      return { ok: false, status: "invalid", reason: "crawl_depth_limit_exceeded" };
    }
    const fetched = await fetchDocument(current.url);
    if (!fetched.ok) {
      // 메인 문서 부재는 source 전체 실패. 하위문서·참조문서의 stale/missing 링크는 적재하지 않고 추적만 남긴다.
      if (current.depth > 1 && fetched.status === "missing") {
        rejected.push({ url: current.url, reason: `${fetched.status}:${fetched.reason}` });
        continue;
      }
      return {
        ok: false,
        status: fetched.status === "blocked" ? "blocked" : "invalid",
        reason: `${fetched.status}:${fetched.reason}`,
      };
    }

    if (current.kind === "reference") {
      // standalone 참조문서 — canonical + 양방향 결속 게이트. 실패는 entity 전체를 죽이지 않고
      // 해당 문서만 rejected 로 남긴다(하위문서 canonical 실패와 같은 계약).
      if (!entityRootTitle) return { ok: false, status: "invalid", reason: "root_identity_absent" };
      const refVerdict = verifyCanonicalReferenceDocumentIdentity({
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.url,
        html: fetched.html,
        entityRootTitle,
        anchorTitle: current.anchorTitle ?? "",
        entityName: identity.name,
      });
      if (!refVerdict.ok) {
        rejected.push({ url: current.url, reason: `reference:${refVerdict.reason}` });
        continue;
      }
      documents.push({
        kind: "reference",
        depth: current.depth,
        requestedUrl: fetched.requestedUrl,
        canonicalUrl: refVerdict.canonicalUrl,
        pageTitle: refVerdict.pageTitle,
        sectionPath: refVerdict.sectionPath,
        html: fetched.html,
        revision: fetched.revision,
        crawledAt: fetched.crawledAt,
      });
      continue;
    }

    if (current.depth === 1) {
      const rootVerdict = verifyCanonicalIdentity({
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.url,
        html: fetched.html,
        playerIdentity: identity,
      });
      if (!rootVerdict.ok) {
        return { ok: false, status: "invalid", reason: `canonical:${rootVerdict.reason}` };
      }
      entityRootTitle = rootVerdict.pageTitle;
      documents.push({
        kind: "entity",
        depth: 1,
        requestedUrl: fetched.requestedUrl,
        canonicalUrl: rootVerdict.canonicalUrl,
        pageTitle: rootVerdict.pageTitle,
        sectionPath: rootVerdict.pageTitle,
        html: fetched.html,
        revision: fetched.revision,
        crawledAt: fetched.crawledAt,
      });
    } else {
      if (!entityRootTitle) return { ok: false, status: "invalid", reason: "root_identity_absent" };
      const subVerdict = verifyCanonicalSubdocumentIdentity({
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.url,
        html: fetched.html,
        entityRootTitle,
      });
      if (!subVerdict.ok) {
        // prefix 후보라도 canonical/title이 계약과 다르면 해당 문서는 저장하지 않는다.
        rejected.push({ url: current.url, reason: `canonical:${subVerdict.reason}` });
        continue;
      }
      documents.push({
        kind: "entity",
        depth: current.depth,
        requestedUrl: fetched.requestedUrl,
        canonicalUrl: subVerdict.canonicalUrl,
        pageTitle: subVerdict.pageTitle,
        sectionPath: subVerdict.sectionPath,
        html: fetched.html,
        revision: fetched.revision,
        crawledAt: fetched.crawledAt,
      });
    }

    const children = extractNamuEntitySubdocumentUrls(
      fetched.html,
      fetched.url,
      entityRootTitle ?? identity.name,
    ).filter((url) => !seen.has(url));
    if (children.length > 0 && current.depth >= maxDepth) {
      return { ok: false, status: "invalid", reason: "crawl_depth_limit_exceeded" };
    }
    for (const child of children) {
      if (seen.size >= maxDocuments) {
        return { ok: false, status: "invalid", reason: "document_limit_exceeded" };
      }
      seen.add(child);
      queue.push({ url: child, depth: current.depth + 1, kind: "entity" });
    }

    // 닫힌 참조 표기(`<a>X</a> 문서 참고`)에서 발견한 standalone 참조문서 (맛자욱 P0).
    // entity 문서에서만 발견을 허용하고, 참조문서 자신은 자식을 확장하지 않는다(leaf).
    const references = extractNamuReferenceDocLinks(
      fetched.html,
      fetched.url,
      entityRootTitle ?? identity.name,
    ).filter((link) => !seen.has(link.url));
    for (const reference of references) {
      referenceCount += 1;
      // 폭주는 truncate 하지 않고 entity 전체 fail-close 한다(하위문서 상한과 같은 계약).
      if (referenceCount > NAMU_MAX_REFERENCE_DOCS_PER_ENTITY) {
        return { ok: false, status: "invalid", reason: "reference_document_limit_exceeded" };
      }
      if (seen.size >= maxDocuments) {
        return { ok: false, status: "invalid", reason: "document_limit_exceeded" };
      }
      seen.add(reference.url);
      queue.push({ url: reference.url, depth: current.depth + 1, kind: "reference", anchorTitle: reference.title });
    }
  }

  if (!entityRootTitle) return { ok: false, status: "invalid", reason: "root_identity_absent" };
  return { ok: true, entityRootTitle, documents, rejected };
}

/**
 * 문서 1건을 실제 Chrome으로 가져온다. **요청마다 브라우저를 새로 띄우고 반드시 닫는다.**
 * 같은 브라우저를 재사용하면 실측상 두 번째 요청부터 403이 난다 — 그래서 재사용하지 않는다.
 */
export async function fetchNamuDocumentViaBrowser(
  url: string,
  options: BrowserFetchOptions = {},
): Promise<FetchDocResult> {
  await enforceInterval(options.minIntervalMs ?? NAMU_BROWSER_MIN_INTERVAL_MS);
  const crawledAt = new Date().toISOString();
  let browser: Browser | null = null;
  try {
    // channel:"chrome" + headless:false 는 위장이 아니라 **실제 브라우저를 실제 모드로 쓰는 것**이다.
    browser = await chromium.launch({ channel: "chrome", headless: false });
    const page = await browser.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? RAG_FETCH_TIMEOUT_MS * 3,
    });
    const status = response?.status();
    if (typeof status !== "number") {
      return { ok: false, status: "blocked", reason: "no_response" };
    }
    const html = await page.content();
    if (status !== 200) {
      const failure = classifyFetchFailure(status);
      return { ok: false, ...failure, httpStatus: status };
    }
    // 200이어도 본문이 차단 페이지면 blocked다 — 재시도하지 않는다.
    if (isBlockedDocumentBody(html)) {
      return { ok: false, status: "blocked", reason: "bot_protection_challenge_body" };
    }
    return {
      ok: true,
      requestedUrl: url,
      url: page.url(),
      html,
      // 브라우저 경로에는 ETag/Last-Modified 헤더 접근이 보장되지 않으므로 크롤 시각을 revision으로 쓴다.
      revision: `crawled:${crawledAt}`,
      crawledAt,
    };
  } catch (error) {
    return { ok: false, status: "blocked", reason: `browser_fetch_failed:${(error as Error).name}` };
  } finally {
    await browser?.close();
  }
}
