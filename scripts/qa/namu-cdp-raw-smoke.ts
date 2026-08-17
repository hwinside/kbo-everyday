/**
 * raw-CDP fetcher 행동 게이트 (2026-08-16 삼순 P1 지적 반영, PR #1217).
 *
 * mock CDP 서버(실제 ws 서버)를 띄워 `fetchNamuDocumentViaCdp`의 **실행 경로**를 태운다 —
 * 정적 grep이 아니라 실제 WebSocket 왕복으로 판정한다. 검증 축:
 *
 *   1. happy path — 노이즈 이벤트(다른 frame의 frameStoppedLoading·iframe Document 500·
 *      무관 method·비JSON 프레임)가 먼저 와도 **navigate frameId/loaderId에 결속된**
 *      Document(200)·frameStoppedLoading(F1)만 판정에 쓰인다. 조기 완료·오염이면 RED.
 *   2. navigate errorText — net::ERR_* 를 조용히 넘기면 RED.
 *   3. non-200 Document — 403이 missing/ok로 새면 RED (blocked + httpStatus).
 *   4. challenge 본문 — 200이어도 차단 페이지면 blocked. 아니면 RED.
 *   5. cleanup fail-close — fetch가 성공해도 Target.closeTarget 실패(success=false)면
 *      결과가 blocked(cdp_cleanup_failed)여야 한다. 삼키면 488회 탭 누적 — RED.
 *   6. 응답 없는 소켓 — navigate 무응답이 timeout으로 드러나야 한다(hang이면 RED).
 *   7. 연속 3회 후 target 수 원복 — mock의 열린 탭 카운트가 0으로 돌아와야 한다.
 */

import assert from "node:assert";
import { createServer, type Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import { fetchNamuDocumentViaCdp } from "../baseball-qa/rag/fetch-namu-cdp";

type Scenario =
  | "happy"
  | "navigate_error"
  | "http_403"
  | "challenge_body"
  | "close_fail"
  | "no_reply"
  | "stop_before_response"
  | "close_during_wait"
  | "stale_stop_before_navigate";

const HAPPY_HTML = "<html><head><title>강현우(야구선수)</title></head><body>2001년 출생 야구선수 문서 본문</body></html>";
const CHALLENGE_HTML = "<html><body>Just a moment...</body></html>";
const FINAL_URL = "https://namu.wiki/w/%EA%B0%95%ED%98%84%EC%9A%B0(%EC%95%BC%EA%B5%AC%EC%84%A0%EC%88%98)";

class MockChrome {
  readonly server: Server;
  readonly openTargets = new Set<string>();
  scenario: Scenario = "happy";
  private nextTarget = 1;
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this.server.on("upgrade", (request, socket, head) => {
      const path = request.url ?? "";
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        if (path === "/devtools/browser") this.serveBrowser(ws);
        else if (path.startsWith("/devtools/page/")) this.servePage(ws);
        else ws.close();
      });
    });
  }

  private serveBrowser(ws: WebSocket): void {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id: number; method: string; params?: { targetId?: string; url?: string } };
      if (message.method === "Target.createTarget") {
        const targetId = `T${this.nextTarget++}`;
        this.openTargets.add(targetId);
        ws.send(JSON.stringify({ id: message.id, result: { targetId } }));
      } else if (message.method === "Target.closeTarget") {
        if (this.scenario === "close_fail") {
          ws.send(JSON.stringify({ id: message.id, result: { success: false } }));
        } else {
          if (message.params?.targetId) this.openTargets.delete(message.params.targetId);
          ws.send(JSON.stringify({ id: message.id, result: { success: true } }));
        }
      } else {
        ws.send(JSON.stringify({ id: message.id, result: {} }));
      }
    });
  }

  evaluateCalls = 0;

  private servePage(ws: WebSocket): void {
    const emit = (method: string, params: Record<string, unknown>, delayMs: number) => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }));
      }, delayMs);
    };
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id: number; method: string; params?: { expression?: string } };
      if (message.method === "Page.enable" || message.method === "Network.enable") {
        ws.send(JSON.stringify({ id: message.id, result: {} }));
        return;
      }
      if (message.method === "Page.setLifecycleEventsEnabled") {
        ws.send(JSON.stringify({ id: message.id, result: {} }));
        if (this.scenario === "stale_stop_before_navigate") {
          // 삼순 7차 P0 RED: navigate 이전 세대(about:blank, 같은 main frame F1·다른
          // loader L0)의 stale 완료 이벤트. frameId만으로 결속하면 이걸 소비해 현재
          // load(L1) 완료 전에 stale/partial DOM을 수확한다.
          ws.send(JSON.stringify({ method: "Page.lifecycleEvent", params: { frameId: "F1", loaderId: "L0-stale", name: "DOMContentLoaded" } }));
          ws.send(JSON.stringify({ method: "Page.frameStoppedLoading", params: { frameId: "F1" } }));
        }
        return;
      }
      if (message.method === "Page.navigate") {
        if (this.scenario === "no_reply") return; // 무응답 — timeout 경로 검증
        if (this.scenario === "navigate_error") {
          ws.send(JSON.stringify({ id: message.id, result: { errorText: "net::ERR_NAME_NOT_RESOLVED" } }));
          return;
        }
        if (this.scenario === "stop_before_response") {
          // 삼순 6차 P0 RED: 현재 세대(F1+L1)의 완료·Document가 navigate command response보다
          // 먼저 도착. 버퍼링 없이 응답 후 listener만 붙이면 유실 → false-timeout이다.
          ws.send(JSON.stringify({ method: "Network.responseReceived", params: { type: "Document", frameId: "F1", loaderId: "L1", response: { status: 200 } } }));
          ws.send(JSON.stringify({ method: "Page.lifecycleEvent", params: { frameId: "F1", loaderId: "L1", name: "DOMContentLoaded" } }));
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, result: { frameId: "F1", loaderId: "L1" } }));
          }, 60);
          return;
        }
        if (this.scenario === "stale_stop_before_navigate") {
          // 응답은 현재 세대(L1)로 주되, 현재 세대의 완료 이벤트는 주지 않는다 —
          // stale(L0)을 소비하면 ok가 나오고(RED), 결속이 올바르면 timeout 실패가 맞다.
          ws.send(JSON.stringify({ id: message.id, result: { frameId: "F1", loaderId: "L1" } }));
          return;
        }
        if (this.scenario === "close_during_wait") {
          // 삼순 P1 RED: 응답은 주되 완료 이벤트 없이 소켓을 끊는다 — event waiter가
          // 즉시 깨어지지 않고 timeout까지 대기하면 계약 위반이다.
          ws.send(JSON.stringify({ id: message.id, result: { frameId: "F1", loaderId: "L1" } }));
          setTimeout(() => ws.close(), 40);
          return;
        }
        ws.send(JSON.stringify({ id: message.id, result: { frameId: "F1", loaderId: "L1" } }));
        // 노이즈 먼저: 비JSON 프레임·무관 method·다른 frame 완료·같은 frame의 stale loader
        // 완료·iframe Document(500) — 전부 무시되어야 한다.
        setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send("this-is-not-json"); }, 3);
        emit("Inspector.detachedNoise", { reason: "unrelated" }, 5);
        emit("Page.lifecycleEvent", { frameId: "F9-unrelated", loaderId: "L1", name: "load" }, 7);
        emit("Page.lifecycleEvent", { frameId: "F1", loaderId: "L0-stale", name: "DOMContentLoaded" }, 8);
        emit("Network.responseReceived", { type: "Document", frameId: "F2-iframe", loaderId: "L9", response: { status: 500 } }, 10);
        emit("Network.responseReceived", { type: "Document", frameId: "F1", loaderId: "L0-stale", response: { status: 500 } }, 12);
        // 결속 대상: 현재 세대(F1+L1)의 Document + lifecycle 완료.
        const status = this.scenario === "http_403" ? 403 : 200;
        emit("Network.responseReceived", { type: "Document", frameId: "F1", loaderId: "L1", response: { status } }, 14);
        emit("Page.lifecycleEvent", { frameId: "F1", loaderId: "L1", name: "DOMContentLoaded" }, 18);
        return;
      }
      if (message.method === "Runtime.evaluate") {
        this.evaluateCalls += 1;
        const expression = message.params?.expression ?? "";
        const value = expression.includes("outerHTML")
          ? (this.scenario === "challenge_body" ? CHALLENGE_HTML : HAPPY_HTML)
          : FINAL_URL;
        ws.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
        return;
      }
      ws.send(JSON.stringify({ id: message.id, result: {} }));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("mock 서버 주소 확인 실패");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  const mock = new MockChrome();
  const cdpUrl = await mock.listen();
  const fetchOnce = () => fetchNamuDocumentViaCdp("https://namu.wiki/w/%EA%B0%95%ED%98%84%EC%9A%B0", {
    cdpUrl,
    minIntervalMs: 0,
    timeoutMs: 1_500,
  });

  try {
    // 1) happy — 노이즈 무시 + 결속된 200만 판정에 사용.
    mock.scenario = "happy";
    const happy = await fetchOnce();
    assert.ok(happy.ok === true, `happy는 ok여야 한다: ${JSON.stringify(happy)}`);
    assert.equal(happy.ok && happy.html, HAPPY_HTML, "html은 렌더 문서 수확값이어야 한다");
    assert.equal(happy.ok && happy.url, FINAL_URL, "최종 URL은 location.href여야 한다(redirect 반영)");

    // 2) navigate errorText — 조용히 넘기면 RED.
    mock.scenario = "navigate_error";
    const navigateError = await fetchOnce();
    assert.ok(!navigateError.ok && navigateError.status === "blocked", "navigate errorText는 blocked여야 한다");
    assert.ok(!navigateError.ok && navigateError.reason.includes("ERR_NAME_NOT_RESOLVED"), "errorText가 reason에 드러나야 한다");

    // 3) non-200 — 결속된 Document status로 분류.
    mock.scenario = "http_403";
    const forbidden = await fetchOnce();
    assert.ok(!forbidden.ok && forbidden.status === "blocked" && forbidden.httpStatus === 403,
      `403은 blocked+httpStatus=403이어야 한다: ${JSON.stringify(forbidden)}`);

    // 4) challenge 본문 — 200이어도 blocked.
    mock.scenario = "challenge_body";
    const challenge = await fetchOnce();
    assert.ok(!challenge.ok && challenge.status === "blocked" && challenge.reason === "bot_protection_challenge_body",
      "challenge 본문은 bot_protection_challenge_body여야 한다");

    // 5) cleanup fail-close — fetch 성공이어도 closeTarget 실패면 blocked(cdp_cleanup_failed).
    mock.scenario = "close_fail";
    const cleanupFail = await fetchOnce();
    assert.ok(!cleanupFail.ok && cleanupFail.status === "blocked" && cleanupFail.reason.startsWith("cdp_cleanup_failed"),
      `closeTarget 실패는 fail-close여야 한다: ${JSON.stringify(cleanupFail)}`);
    mock.openTargets.clear(); // close_fail이 남긴 mock 상태 정리

    // 6) 무응답 소켓 — hang이 아니라 timeout으로 드러나야 한다.
    mock.scenario = "no_reply";
    const started = Date.now();
    const noReply = await fetchOnce();
    assert.ok(!noReply.ok && noReply.status === "blocked" && noReply.reason.startsWith("cdp_fetch_failed"),
      "navigate 무응답은 cdp_fetch_failed여야 한다");
    assert.ok(Date.now() - started < 10_000, "무응답은 timeout 내에 드러나야 한다(hang 금지)");
    mock.openTargets.clear();

    // 7) stop-before-navigate-response — matching stop·Document가 command response보다
    // 먼저 와도 버퍼 소비로 성공해야 한다(유실이면 false-timeout RED — 삼순 P0).
    mock.scenario = "stop_before_response";
    const preStop = Date.now();
    const stopFirst = await fetchOnce();
    assert.ok(stopFirst.ok === true, `stop-before-response는 버퍼 소비로 ok여야 한다: ${JSON.stringify(stopFirst)}`);
    assert.ok(Date.now() - preStop < 1_200, "버퍼 소비는 대기 없이 즉시 완료돼야 한다(false-timeout 금지)");

    // 8) close-during-event-wait — 이벤트 대기 중 소켓 close가 즉시 실패로 드러나야
    // 한다(timeout까지 대기하면 RED — 삼순 P1).
    mock.scenario = "close_during_wait";
    const preClose = Date.now();
    const closedMid = await fetchOnce();
    assert.ok(!closedMid.ok && closedMid.status === "blocked" && closedMid.reason.startsWith("cdp_fetch_failed"),
      `대기 중 close는 cdp_fetch_failed여야 한다: ${JSON.stringify(closedMid)}`);
    assert.ok(Date.now() - preClose < 1_000, `close는 즉시 실패로 드러나야 한다(timeout 대기 금지, 실측 ${Date.now() - preClose}ms)`);
    mock.openTargets.clear();

    // 9) stale-stop-before-navigate — navigate 이전 세대(같은 frame·다른 loader)의 stale
    // 완료를 소비해 현재 loader 완료 전에 수확하면 RED(삼순 7차 P0). 결속이 올바르면
    // 현재 세대 완료가 안 오므로 timeout 실패 + Runtime.evaluate 호출 0이 맞다.
    mock.scenario = "stale_stop_before_navigate";
    mock.evaluateCalls = 0;
    const staleResult = await fetchOnce();
    assert.ok(!staleResult.ok && staleResult.status === "blocked" && staleResult.reason.startsWith("cdp_fetch_failed"),
      `stale 세대 소비는 금지 — 현재 세대 미완료는 실패여야 한다: ${JSON.stringify(staleResult)}`);
    assert.equal(mock.evaluateCalls, 0, `현재 loader 완료 전 Runtime.evaluate 수확은 금지다(실측 ${mock.evaluateCalls}회)`);
    mock.openTargets.clear();

    // 10) 연속 3회 후 target 수 원복 — 탭 누적이면 RED.
    mock.scenario = "happy";
    for (let index = 0; index < 3; index += 1) {
      const repeat = await fetchOnce();
      assert.ok(repeat.ok, `연속 ${index + 1}회차 happy는 ok여야 한다`);
    }
    assert.equal(mock.openTargets.size, 0, `연속 3회 후 열린 target이 0이어야 한다(실측 ${mock.openTargets.size})`);

    console.log("namu-cdp-raw-smoke PASS (결속 happy(stale 노이즈 포함) / navigate errorText / 403 / challenge / cleanup fail-close / 무응답 timeout / stop-before-response 버퍼소비 / close-during-wait 즉시실패 / stale-세대 불채택(evaluate 0) / 연속3회 target 원복)");
  } finally {
    await mock.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
