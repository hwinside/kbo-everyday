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

/**
 * 요청 간 최소 간격 (bounded rate, §12.2 b).
 * 10초는 실측 하한이다 — 2.5초 연타는 403을 유발했고 10초 간격 8연속은 8/8 200이었다.
 * 호출자가 지키는 것에 의존하지 않고 **이 모듈이 강제한다**(`enforceInterval`).
 */
export const NAMU_BROWSER_MIN_INTERVAL_MS = 10_000;

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
