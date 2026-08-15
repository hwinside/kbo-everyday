/**
 * 나무위키 A17 CDP fetcher — **수집 스크립트 전용** (fetch-namu-browser와 같은 위치 계약).
 *
 * ── 왜 CDP인가 (2026-08-02 실측, 2026-08-15 삼순 지적 반영) ─────────────────────────
 * 나무위키 Cloudflare 차단의 실제 변수는 브라우저 지문이 아니라 **출발 IP 대역**이었다
 * (클라우드/데이터센터 전부 403, 모바일 통신망 통과 — 2026-08-02 교차 실측).
 * 그래서 GitHub Actions 직접 수집은 부적합하고, 8/1~8/3 수집 4,336건을 완주한 경로는
 * A17 폰(SM-A175N)의 **자기 Chrome을 CDP로 조종**하는 것이었다(`a17_self_cdp`).
 *
 * 이 모듈은 그 경로를 repo 안으로 들여온다: 이미 떠 있는 Chrome의 CDP endpoint에 붙어
 * (`chromium.connectOverCDP`) 탭 하나로 문서를 가져온다. 실행 위치는 CDP가 forward된 곳
 * 어디든 된다 (예: `adb forward tcp:9222 localabstract:chrome_devtools_remote`).
 *
 * ── §12.2(b) 우회 금지 — fetch-namu-browser와 동일 계약 ──────────────────────────
 *   - UA 위장 없음 (폰 Chrome이 보내는 UA 그대로), challenge solver 없음, 쿠키 재사용 주입 없음.
 *   - blocked(403/429/503/차단 본문)를 만나면 재시도하지 않는다. 호출자는 **전역 중단**한다.
 *   - bounded rate: `enforceInterval` 공유 — 간격은 호출자가 명시한다.
 *     (기본 10초였으나 2026-08-15 하린아빠 지시로 10초 미만 시도를 허용한다. 대신
 *      첫 blocked에서 run 전체를 즉시 멈추는 전역 중단 계약이 안전선이다.)
 *
 * 판정은 이 모듈이 하지 않는다 — html/최종 URL만 돌려주고 canonical/identity 대조는
 * 호출자가 `verifyCanonicalIdentity`(공용 게이트)로 한다. fetch 경로가 달라져도
 * 판정이 갈라지지 않게 하기 위함이다(삼순: "동일 canonical 판정 결속").
 */

import { chromium, type Browser } from "playwright";

import {
  classifyFetchFailure,
  isBlockedDocumentBody,
  RAG_FETCH_TIMEOUT_MS,
  type FetchDocResult,
} from "../../../src/lib/baseball-qa/rag/fetch-namu";
import { enforceInterval } from "./fetch-namu-browser";

/** CDP endpoint 기본값 — adb forward 표준 포트. 환경변수/옵션으로 덮어쓴다. */
export const DEFAULT_NAMU_CDP_URL = "http://127.0.0.1:9222";

export interface CdpFetchOptions {
  /** CDP endpoint. 기본은 `NAMU_CDP_URL` env → 없으면 127.0.0.1:9222. */
  cdpUrl?: string;
  /** 요청 간 최소 간격(ms). 호출자(resolver)가 강제 — 기본값을 여기서 정하지 않는다. */
  minIntervalMs: number;
  /** 페이지 로드 타임아웃(ms). 모바일망은 느릴 수 있어 기본 45초. */
  timeoutMs?: number;
}

/**
 * 문서 1건을 A17 Chrome(CDP)으로 가져온다.
 *
 * 요청마다 connect → 새 탭 → 닫기 → disconnect. 브라우저 프로세스는 폰에 살아 있는 것을
 * 그대로 쓴다(재기동 권한이 없다). 2026-08-01 "같은 브라우저 연타 403" 실측은 데스크톱
 * Chrome+데이터센터망 조건이었고, A17 모바일망 경로는 8/1~8/3 4,336건 연속 수집으로
 * 세션 유지가 검증돼 있다 — 그래도 blocked가 오면 즉시 전역 중단이 계약이다.
 */
export async function fetchNamuDocumentViaCdp(
  url: string,
  options: CdpFetchOptions,
): Promise<FetchDocResult> {
  await enforceInterval(options.minIntervalMs);
  const cdpUrl = options.cdpUrl ?? process.env.NAMU_CDP_URL ?? DEFAULT_NAMU_CDP_URL;
  const crawledAt = new Date().toISOString();
  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    try {
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
        revision: `crawled:${crawledAt}`,
        crawledAt,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (error) {
    // CDP 연결 실패(폰 미연결·forward 끊김)는 차단과 구분해 즉시 드러낸다 — 조용한 skip 금지.
    return { ok: false, status: "blocked", reason: `cdp_fetch_failed:${(error as Error).name}` };
  } finally {
    // disconnect만 한다 — 폰 Chrome을 죽이지 않는다.
    await browser?.close().catch(() => undefined);
  }
}
