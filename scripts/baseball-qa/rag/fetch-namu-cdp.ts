/**
 * 나무위키 A17 CDP fetcher — **수집 스크립트 전용** (fetch-namu-browser와 같은 위치 계약).
 *
 * ── 왜 CDP인가 (2026-08-02 실측, 2026-08-15 삼순 지적 반영) ─────────────────────────
 * 나무위키 Cloudflare 차단의 실제 변수는 브라우저 지문이 아니라 **출발 IP 대역**이었다
 * (클라우드/데이터센터 전부 403, 모바일 통신망 통과 — 2026-08-02 교차 실측).
 * 그래서 GitHub Actions 직접 수집은 부적합하고, 8/1~8/3 수집 4,336건을 완주한 경로는
 * A17 폰(SM-A175N)의 **자기 Chrome을 CDP로 조종**하는 것이었다(`a17_self_cdp`).
 *
 * ── 왜 raw CDP인가 (2026-08-16 00:08 실기기 실측 — Playwright 폐기) ─────────────────
 * 첫 구현은 Playwright `connectOverCDP`였으나 **Android Chrome의 browser-level CDP와
 * 비호환**임이 2단계 첫 실측에서 드러났다: HTTP CDP(`/json/version`)와 raw WebSocket
 * (`Browser.getVersion` 0.0초 즉답)은 정상인데, Playwright만 ws 연결 후 초기화 단계에서
 * timeout(15초, ws:// 직결로도 동일 재현). HTTP `PUT /json/new`도 Android Chrome이
 * 500 "Could not create new page"를 낸다(00:14 실측). 그래서 전송층을 **raw CDP**로
 * 교체했다. 판정(canonical/identity)은 여전히 이 모듈 밖 — 호출자가
 * `verifyCanonicalIdentity` 공용 게이트로 한다(fetch 경로가 바뀌어도 판정은 같다).
 *
 * ── §12.2(b) 우회 금지 — fetch-namu-browser와 동일 계약 ──────────────────────────
 *   - UA 위장 없음 (폰 Chrome이 보내는 UA 그대로), challenge solver 없음, 쿠키 재사용 주입 없음.
 *   - blocked(403/429/503/차단 본문)를 만나면 재시도하지 않는다. 호출자는 **전역 중단**한다.
 *   - bounded rate: `enforceInterval` 공유 — 간격은 호출자가 명시한다.
 *
 * ── 전송 결속 계약 (2026-08-16 삼순 P0 반영) ─────────────────────────────────────
 *   - `Page.navigate` 응답의 `errorText`는 즉시 실패다(net::ERR_* 등) — 조용히 넘기지 않는다.
 *   - 문서 status·로드 완료는 navigate가 돌려준 **frameId/loaderId에 exact 결속**한다:
 *     `Network.responseReceived`(type=Document)와 `Page.frameStoppedLoading`을 frameId로
 *     필터해, about:blank·iframe·다른 탭의 이벤트가 조기 완료시키는 경로를 차단한다.
 *   - cleanup(`Target.closeTarget`) 실패는 **fail-close**다: fetch가 성공했어도 결과를
 *     blocked(`cdp_cleanup_failed`)로 바꿔 전역 중단시킨다 — 488회 탭 누적 방지.
 *
 * 전송 절차 (요청 1건):
 *   1. browser WebSocket `Target.createTarget` — 새 탭 생성
 *   2. `/devtools/page/<targetId>` page WebSocket 접속 → `Page.enable` + `Network.enable`
 *   3. `Page.navigate` → `{frameId, loaderId, errorText}` — errorText면 실패
 *   4. frameId 결속 `Page.frameStoppedLoading` 대기, frameId/loaderId 결속
 *      `Network.responseReceived`(type=Document)로 HTTP status 포착
 *   5. `Runtime.evaluate`로 outerHTML·location.href 수확
 *   6. `Target.closeTarget` — 실패 시 fail-close. 폰 Chrome 프로세스는 건드리지 않는다.
 */

import WebSocket from "ws";

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

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

type EventListener = (event: CdpEvent) => void;

/**
 * page/browser WebSocket 위의 최소 CDP 세션. 명령은 id로 응답을 짝짓고, 이벤트는 리스너로
 * 흘린다. 소켓 error/close는 대기 중인 모든 명령·이벤트 대기를 즉시 실패시킨다(hang 방지).
 * 오류·타임아웃은 던진다 — 호출자가 blocked(`cdp_fetch_failed:*`)로 분류한다(조용한 skip 금지).
 */
export class RawCdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<EventListener>();
  private closedError: Error | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      let message: {
        id?: number; result?: Record<string, unknown>; error?: { message?: string };
        method?: string; params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(String(data));
      } catch {
        return; // CDP 프레임이 아닌 페이로드는 무시 — 판정에 쓰지 않는다.
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`CDP error: ${message.error.message ?? "unknown"}`));
        else waiter.resolve(message.result ?? {});
      } else if (typeof message.method === "string") {
        for (const listener of [...this.eventListeners]) listener({ method: message.method, params: message.params ?? {} });
      }
    });
    const fail = (error: Error) => {
      this.closedError = error;
      for (const [, waiter] of this.pending) waiter.reject(error);
      this.pending.clear();
    };
    ws.on("error", (error) => fail(new Error(`CDP 소켓 오류: ${(error as Error).message}`)));
    ws.on("close", () => fail(new Error("CDP 소켓이 닫혔다")));
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 응답 없음 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** predicate가 참인 첫 이벤트를 기다린다 — method만이 아니라 params(frameId 등)로 결속한다. */
  waitFor(predicate: (event: CdpEvent) => boolean, timeoutMs: number, label: string): Promise<CdpEvent> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<CdpEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`CDP 이벤트 ${label} 없음 (${timeoutMs}ms)`));
      }, timeoutMs);
      const remove = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        remove();
        resolve(event);
      });
    });
  }
}

function connectWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`CDP WebSocket 연결 timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error as Error); });
  });
}

/** cdpUrl이 ws:// 로 와도 /json HTTP 엔드포인트 베이스로 정규화한다. */
function httpBaseOf(cdpUrl: string): string {
  return cdpUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/devtools\/.*$/, "").replace(/\/$/, "");
}

/** /json 베이스에서 ws 베이스로. */
function wsBaseOf(httpBase: string): string {
  return httpBase.replace(/^http(s?):\/\//, "ws$1://");
}

/**
 * 문서 1건을 A17 Chrome(CDP)으로 가져온다.
 *
 * 요청마다 새 탭 → page ws → navigate(frame/loader 결속) → 수확 → 탭 닫기(fail-close).
 * 브라우저 프로세스는 폰에 살아 있는 것을 그대로 쓴다(재기동 권한이 없다).
 * blocked가 오면 즉시 전역 중단이 계약이다.
 */
export async function fetchNamuDocumentViaCdp(
  url: string,
  options: CdpFetchOptions,
): Promise<FetchDocResult> {
  await enforceInterval(options.minIntervalMs);
  const cdpUrl = options.cdpUrl ?? process.env.NAMU_CDP_URL ?? DEFAULT_NAMU_CDP_URL;
  const httpBase = httpBaseOf(cdpUrl);
  const timeoutMs = options.timeoutMs ?? RAG_FETCH_TIMEOUT_MS * 3;
  const crawledAt = new Date().toISOString();
  let ws: WebSocket | null = null;
  let browserWs: WebSocket | null = null;
  let targetId: string | null = null;
  let browserSession: RawCdpSession | null = null;
  let result: FetchDocResult;
  try {
    // 1) 새 탭 — browser ws의 Target.createTarget. (HTTP /json/new는 Android Chrome에서
    // 500 "Could not create new page" — 2026-08-16 00:14 실측. browser-level 명령은 즉답.)
    browserWs = await connectWebSocket(`${wsBaseOf(httpBase)}/devtools/browser`, 10_000);
    browserSession = new RawCdpSession(browserWs);
    const created = await browserSession.send("Target.createTarget", { url: "about:blank" }, 10_000) as { targetId?: string };
    if (!created.targetId) throw new Error("Target.createTarget 응답에 targetId 없음");
    targetId = created.targetId;

    // 2) page WebSocket — 이 탭의 session에 직접 붙는다.
    ws = await connectWebSocket(`${wsBaseOf(httpBase)}/devtools/page/${targetId}`, 10_000);
    const session = new RawCdpSession(ws);
    await session.send("Page.enable", {}, 10_000);
    await session.send("Network.enable", {}, 10_000);

    // 3) Document 응답 후보를 버퍼링 — navigate 응답(frameId/loaderId)이 오기 전에 이벤트가
    // 먼저 도착해도 놓치지 않도록 전부 쌓아두고, 결속 키가 확정된 뒤 필터한다.
    const documentResponses: Array<{ frameId?: string; loaderId?: string; status?: number }> = [];
    session.onEvent((event) => {
      if (event.method !== "Network.responseReceived") return;
      const params = event.params as { type?: string; frameId?: string; loaderId?: string; response?: { status?: number } };
      if (params.type === "Document") {
        documentResponses.push({ frameId: params.frameId, loaderId: params.loaderId, status: params.response?.status });
      }
    });

    // 4) navigate — errorText는 즉시 실패(net::ERR_* 등). frameId/loaderId가 결속 키다.
    const navigated = await session.send("Page.navigate", { url }, timeoutMs) as {
      frameId?: string; loaderId?: string; errorText?: string;
    };
    if (navigated.errorText) throw new Error(`Page.navigate 실패: ${navigated.errorText}`);
    if (!navigated.frameId) throw new Error("Page.navigate 응답에 frameId 없음");
    const frameId = navigated.frameId;
    const loaderId = navigated.loaderId;

    // 5) 로드 완료 — 반드시 navigate한 frame의 frameStoppedLoading에만 결속한다.
    // (domContentEventFired는 frame 무결속이라 about:blank/iframe이 조기 완료시킬 수 있다.)
    await session.waitFor(
      (event) => event.method === "Page.frameStoppedLoading"
        && (event.params as { frameId?: string }).frameId === frameId,
      timeoutMs,
      `Page.frameStoppedLoading(frameId=${frameId})`,
    );

    // 6) main Document status — frameId exact + (loaderId 있으면 exact) 결속.
    const documentResponse = documentResponses.find(
      (candidate) => candidate.frameId === frameId && (loaderId === undefined || candidate.loaderId === loaderId),
    );

    // 7) 수확 — HTML·최종 URL은 렌더된 문서에서 직접 읽는다(redirect 반영).
    const htmlResult = await session.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    }, timeoutMs) as { result?: { value?: unknown } };
    const urlResult = await session.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
    }, 10_000) as { result?: { value?: unknown } };
    const html = htmlResult.result?.value;
    const finalUrl = urlResult.result?.value;
    if (typeof html !== "string" || typeof finalUrl !== "string" || finalUrl.length === 0) {
      throw new Error("Runtime.evaluate 수확 실패(html/finalUrl)");
    }

    if (typeof documentResponse?.status !== "number") {
      result = { ok: false, status: "blocked", reason: "no_response" };
    } else if (documentResponse.status !== 200) {
      const failure = classifyFetchFailure(documentResponse.status);
      result = { ok: false, ...failure, httpStatus: documentResponse.status };
    } else if (isBlockedDocumentBody(html)) {
      // 200이어도 본문이 차단 페이지면 blocked다 — 재시도하지 않는다.
      result = { ok: false, status: "blocked", reason: "bot_protection_challenge_body" };
    } else {
      result = {
        ok: true,
        requestedUrl: url,
        url: finalUrl,
        html,
        revision: `crawled:${crawledAt}`,
        crawledAt,
      };
    }
  } catch (error) {
    // CDP 연결 실패(폰 미연결·forward 끊김)는 차단과 구분해 즉시 드러낸다 — 조용한 skip 금지.
    result = { ok: false, status: "blocked", reason: `cdp_fetch_failed:${(error as Error).name}:${(error as Error).message.slice(0, 120)}` };
  }

  // cleanup은 fail-close다 — closeTarget 실패를 삼키면 488회 탭이 누적된다(삼순 P0).
  try { ws?.close(); } catch { /* 이미 닫힘 */ }
  if (targetId && browserSession) {
    try {
      const closed = await browserSession.send("Target.closeTarget", { targetId }, 10_000) as { success?: boolean };
      if (closed.success !== true) throw new Error(`Target.closeTarget success=${String(closed.success)}`);
    } catch (error) {
      // 성공한 fetch라도 cleanup이 실패하면 blocked로 바꿔 전역 중단시킨다 — 탭만 닫고
      // 폰 Chrome은 죽이지 않는다는 계약은 그대로다(closeTarget은 탭 단위).
      result = { ok: false, status: "blocked", reason: `cdp_cleanup_failed:${(error as Error).message.slice(0, 120)}` };
    }
  }
  try { browserWs?.close(); } catch { /* 이미 닫힘 */ }
  return result;
}
