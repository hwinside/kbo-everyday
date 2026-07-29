// 직관 스토리 view route 실호출 회귀 (삼순 post-merge 정정 리뷰 #962 blocker 계약 ③).
// POST /api/venue-stories/[id]/view 핸들러를 실제로 호출해:
//   1) RPC 성공 → 204
//   2) RPC 실패 → 500 (성공 위장 금지 — 클라가 실패를 감지해 재시도할 수 있어야 함)
//   3) 클라 헬퍼(sendVenueStoryViewPing)가 route 의 500 응답을 보고 false → 호출부 mark
//      해제 → 재전송 시 서버가 다시 RPC 를 받는 end-to-end 재시도 경로
// 를 고정한다. 실행: tsx --test scripts/qa/venue-story-view-route-smoke.ts
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://venue-view-route-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const GUEST = "3f2b1a90-1234-4abc-8def-0123456789ab";

type RpcResult = { data: null; error: { message: string } | null };

async function withMockedRpc(
  results: Array<{ message: string } | null>,
  run: (calls: Array<{ name: string; args: unknown }>) => Promise<void>,
) {
  const admin = await import("../../src/lib/supabase/admin");
  const client = admin.supabaseAdmin as unknown as {
    rpc: (name: string, args?: unknown) => Promise<RpcResult>;
  };
  const originalRpc = client.rpc;
  const calls: Array<{ name: string; args: unknown }> = [];
  client.rpc = async (name, args) => {
    calls.push({ name, args });
    const error = results[Math.min(calls.length - 1, results.length - 1)];
    return { data: null, error };
  };
  try {
    await run(calls);
  } finally {
    client.rpc = originalRpc;
  }
}

async function callViewRoute(id: string, body: string): Promise<Response> {
  const { POST } = await import("../../src/app/api/venue-stories/[id]/view/route");
  return POST(
    new NextRequest(`http://localhost/api/venue-stories/${id}/view`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // beacon/keepalive 와 동일 조건
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

const bodyOf = (kind: string) =>
  JSON.stringify({ kind, guestId: GUEST, accessToken: null });

test("route 실호출: RPC 성공 → 204 (guest viewer_key 로 record RPC 1회)", async () => {
  await withMockedRpc([null], async (calls) => {
    const res = await callViewRoute("11", bodyOf("click"));
    assert.equal(res.status, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "record_venue_story_view");
    assert.deepEqual(calls[0].args, {
      p_story_id: 11,
      p_viewer_key: `guest:${GUEST}`,
      p_kind: "click",
    });
  });
});

test("route 실호출: RPC 실패 → 500 (성공 위장 금지 — 클라 재시도 신호)", async () => {
  await withMockedRpc([{ message: "db down" }], async (calls) => {
    const res = await callViewRoute("11", bodyOf("impression"));
    assert.equal(res.status, 500);
    assert.equal(calls.length, 1);
  });
});

test("route 실호출: invalid kind → 400, RPC 미호출", async () => {
  await withMockedRpc([null], async (calls) => {
    const res = await callViewRoute("11", JSON.stringify({ kind: "view", guestId: GUEST }));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("end-to-end 재시도: 헬퍼가 route 500 을 보고 false → mark 해제 → 재전송이 서버에 다시 도달", async () => {
  const { sendVenueStoryViewPing, venueStorySentKey } = await import(
    "../../src/lib/venue-stories/view-tracking"
  );

  // 1차 RPC 실패(500) → 2차 성공(204)
  await withMockedRpc([{ message: "transient rpc failure" }, null], async (calls) => {
    // route 로 직접 연결되는 fetchFn — 클라 헬퍼가 실제 핸들러 응답 status 를 본다.
    const fetchFn = (async (url: unknown, init?: RequestInit) =>
      callViewRoute("11", String(init?.body))) as typeof fetch;

    // view-tracker-client 의 mark 계약 재현: 선점 mark → 2xx 확인 실패 시 해제.
    const sent = new Set<string>();
    const key = venueStorySentKey(11, "click", `guest:${GUEST}`);
    const payload = { kind: "click" as const, guestId: GUEST, accessToken: null };

    sent.add(key);
    const first = await sendVenueStoryViewPing({
      url: "/api/venue-stories/11/view",
      payload,
      fetchFn,
    });
    assert.equal(first, false); // route 500 → 실패 감지 (beacon 큐잉=성공 착각 경로 제거)
    if (!first) sent.delete(key); // mark 해제 — 유실 대신 재시도 가능 상태

    assert.equal(sent.has(key), false);

    // 다음 노출/열람: mark 없음 → 재전송 → 이번엔 RPC 성공 → mark 확정
    assert.equal(sent.has(key), false);
    sent.add(key);
    const second = await sendVenueStoryViewPing({
      url: "/api/venue-stories/11/view",
      payload,
      fetchFn,
    });
    assert.equal(second, true);
    assert.equal(sent.has(key), true);

    // 서버가 실제로 2회 RPC 를 받았다 — 이벤트 영구 유실 없음(중복은 서버 일별 dedupe 권위).
    assert.equal(calls.length, 2);
  });
});

test("실제 client/hook: hidden beacon 미확정 재시도 + impression 500→재노출→204/RPC 2회", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://keubo.fan/",
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const globalKeys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "IS_REACT_ACT_ENVIRONMENT",
    "IntersectionObserver",
  ] as const;
  const originalGlobals = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Element = dom.window.Element;
  globals.Node = dom.window.Node;
  globals.Event = dom.window.Event;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });

  let hidden = true;
  Object.defineProperty(dom.window.document, "visibilityState", {
    get: () => (hidden ? "hidden" : "visible"),
    configurable: true,
  });
  dom.window.localStorage.setItem("vsv_guest_id", GUEST);

  type ObserverState = {
    callback: IntersectionObserverCallback;
    disconnected: boolean;
  };
  const observers: ObserverState[] = [];
  class MockIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0, 0.5, 1];
    private readonly state: ObserverState;
    constructor(callback: IntersectionObserverCallback) {
      this.state = { callback, disconnected: false };
      observers.push(this.state);
    }
    observe() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
    disconnect() {
      this.state.disconnected = true;
    }
  }
  globals.IntersectionObserver = MockIntersectionObserver;

  let beaconed = 0;
  Object.defineProperty(dom.window.navigator, "sendBeacon", {
    value: () => {
      beaconed++;
      return true;
    },
    configurable: true,
  });

  const { act } = await import("react");
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { trackVenueStoryView } = await import(
    "../../src/lib/venue-stories/view-tracker-client"
  );
  const { useVenueStoryImpression } = await import(
    "../../src/lib/venue-stories/useStoryImpression"
  );

  const originalFetch = globalThis.fetch;
  try {
    // hidden/pagehide: keepalive fetch가 시작되지 못해 beacon이 queued돼도 false/mark 해제.
    globalThis.fetch = (async () => {
      throw new Error("page freezing");
    }) as typeof fetch;
    assert.equal(await trackVenueStoryView(12, "click"), false);
    assert.equal(beaconed, 1);

    // BFCache 복원 뒤 같은 key가 다시 전송되어 route 204를 확인한다.
    hidden = false;
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    await withMockedRpc([null], async (calls) => {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
        callViewRoute("12", String(init?.body))) as typeof fetch;
      assert.equal(await trackVenueStoryView(12, "click"), true);
      assert.equal(calls.length, 1);
    });

    function Harness() {
      const ref = useVenueStoryImpression<HTMLSpanElement>(13);
      return React.createElement("span", { ref });
    }
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(observers.length, 1);
    const observer = observers[0];
    const emit = (ratio: number) =>
      observer.callback(
        [{ intersectionRatio: ratio } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
      const started = Date.now();
      while (!condition() && Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return condition();
    };

    await withMockedRpc([{ message: "transient rpc failure" }, null], async (calls) => {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
        callViewRoute("13", String(init?.body))) as typeof fetch;

      // 첫 실제 노출은 route 500. observer가 살아 있어야 이탈/재노출이 가능하다.
      emit(1);
      assert.equal(await waitFor(() => calls.length === 1), true);
      assert.equal(observer.disconnected, false);

      emit(0);
      emit(1);
      assert.equal(await waitFor(() => calls.length === 2), true);
      assert.equal(calls.length, 2);
      assert.equal(observer.disconnected, true);
    });

    await act(async () => root.unmount());
  } finally {
    globalThis.fetch = originalFetch;
    const { supabase } = await import("../../src/lib/supabase/client");
    supabase.auth.stopAutoRefresh();
    (
      supabase.auth as unknown as { broadcastChannel?: { close: () => void } }
    ).broadcastChannel?.close();
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = originalGlobals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
});
