/**
 * useChatCounts hook lifecycle 회귀 probe (삼순 PR #821 라운드2 blocker 3건 고정).
 * 실제 React(jsdom) mount + 주입 fetcher로 hook effect 배선까지 검증한다.
 *
 * S1) 초기 집계 중 첫 INSERT 도착 → 요청이 취소되지 않고 정상 commit (blocker 1)
 * S2) 집계 실패 → 부분/0 commit 없이 fail-closed(null), interval 소비 없이
 *     retryMs 후 재시도 → 성공 시 한 세트 원자 commit (blocker 2)
 * S3) 로드 범위 밖 soft delete(reconcileKey 증가) → 서버 재집계 트리거 (blocker 3-①②)
 * S4) request budget: 같은 방 hook N개 mount + INSERT 연속 → 초기 N발 이후
 *     INSERT로 인한 추가 집계 쿼리 0 (blocker 3-③, herd 회귀 방지)
 *
 * 실행: npm run qa:chat-count-hook
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch {
  /* Node navigator 재정의 불가 시 기존 것 사용 — react-dom은 document만 있으면 됨 */
}

async function main() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { useChatCounts } = await import("../../src/lib/supabase/useChat");
  type ChatCounts = { total: number; home: number; away: number };
  type Msg = { id: number; room_id: string; user_id: string; content: string; created_at: string; deleted_at?: string | null; team_id?: number };

  const HOME = 1;
  const AWAY = 2;
  let failed = 0;
  const check = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  PASS ${name}`);
    else {
      failed++;
      console.error(`  FAIL ${name}: expected ${e}, got ${a}`);
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await sleep(10);
    }
    return cond();
  };
  const msg = (id: number, teamId?: number, deletedAt?: string | null): Msg => ({
    id,
    room_id: "game:test",
    user_id: `u${id}`,
    content: `m${id}`,
    created_at: new Date(2026, 6, 24, 12, 0, id % 60).toISOString(),
    deleted_at: deletedAt ?? null,
    team_id: teamId,
  });

  // 제어 가능한 fetcher — 호출마다 deferred를 쌓고, 테스트가 원하는 시점에 resolve.
  function makeFetcher() {
    const calls: Array<{ resolve: (v: ChatCounts | null) => void }> = [];
    const fetcher = () =>
      new Promise<ChatCounts | null>((resolve) => {
        calls.push({ resolve });
      });
    return { calls, fetcher };
  }

  interface HostProps {
    messages: Msg[];
    reconcileKey: number;
  }
  function makeHost(
    fetcher: () => Promise<ChatCounts | null>,
    timings: { intervalMs: number; retryMs: number; deleteDebounceMs: number }
  ) {
    const holder: { setProps: ((p: HostProps) => void) | null } = { setProps: null };
    const out = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(out);
    function Host() {
      const [props, sp] = React.useState<HostProps>({ messages: [], reconcileKey: 0 });
      // 렌더 중 외부 변수 재할당 금지(react-hooks/globals) — effect에서 노출.
      React.useEffect(() => {
        holder.setProps = sp;
      }, [sp]);
      const counts = useChatCounts("game:test", HOME, AWAY, props.messages as never, {
        reconcileKey: props.reconcileKey,
        fetchCounts: fetcher,
        intervalMs: timings.intervalMs,
        jitterMs: 0,
        retryMs: timings.retryMs,
        deleteDebounceMs: timings.deleteDebounceMs,
      });
      return React.createElement("span", null, JSON.stringify(counts));
    }
    const root = createRoot(out);
    root.render(React.createElement(Host));
    return {
      rendered: () => out.textContent ?? "",
      update: (p: HostProps) => holder.setProps?.(p),
      unmount: () => {
        root.unmount();
        out.remove();
      },
    };
  }

  // ── S1: 초기 집계 in-flight 중 첫 INSERT → 취소 없이 정상 commit ─────────
  console.log("S1) 초기 집계 + 첫 INSERT (요청 취소 회귀)");
  {
    const { calls, fetcher } = makeFetcher();
    const h = makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 });
    await waitFor(() => calls.length === 1);
    check("초기 집계 1발 시작", calls.length, 1);
    // 응답 도착 전 첫 INSERT (messages 렌더 lifecycle 변화)
    h.update({ messages: [msg(101, HOME)], reconcileKey: 0 });
    await sleep(50);
    calls[0].resolve({ total: 10, home: 4, away: 6 });
    const ok = await waitFor(() => h.rendered() === JSON.stringify({ total: 10, home: 4, away: 6 }));
    check("INSERT에도 응답이 폐기되지 않고 commit", ok ? JSON.parse(h.rendered()) : h.rendered(), {
      total: 10,
      home: 4,
      away: 6,
    });
    check("commit 후 즉시 재요청 폭주 없음", calls.length, 1);
    // 베이스라인 commit 이후 새 INSERT → 낙관적 +1 (서버 재조회 없이)
    h.update({ messages: [msg(101, HOME), msg(102, AWAY)], reconcileKey: 0 });
    await waitFor(() => h.rendered() === JSON.stringify({ total: 11, home: 4, away: 7 }));
    check("commit 후 INSERT는 낙관적 +1", JSON.parse(h.rendered()), { total: 11, home: 4, away: 7 });
    check("낙관적 +1은 서버 쿼리 미발생", calls.length, 1);
    h.unmount();
  }

  // ── S2: 집계 실패 fail-closed + 원자 commit ──────────────────────────────
  console.log("S2) 부분 실패 fail-closed (0-commit 금지 + retry)");
  {
    const { calls, fetcher } = makeFetcher();
    const h = makeHost(fetcher, { intervalMs: 60000, retryMs: 60, deleteDebounceMs: 10 });
    await waitFor(() => calls.length === 1);
    // 실패(홈 쿼리 오류 등 → fetcher 계약상 null) — 부분값 {10,0,3} commit 금지
    calls[0].resolve(null);
    await sleep(30);
    check("실패 시 counts 미확정(null → UI '—')", h.rendered(), "null");
    // 실패는 interval 소비가 아님 — retryMs(60ms) 내 재시도
    const retried = await waitFor(() => calls.length >= 2, 1000);
    check("retryMs 내 재시도", retried, true);
    calls[1].resolve({ total: 10, home: 7, away: 3 });
    await waitFor(() => h.rendered() !== "null");
    check("재시도 성공 시 한 세트 원자 commit", JSON.parse(h.rendered()), { total: 10, home: 7, away: 3 });
    h.unmount();
  }

  // ── S3: 로드 범위 밖 삭제 → reconcile 트리거 ────────────────────────────
  console.log("S3) 로드 범위 밖 soft delete → 서버 재집계");
  {
    const { calls, fetcher } = makeFetcher();
    const h = makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 20 });
    await waitFor(() => calls.length === 1);
    calls[0].resolve({ total: 10, home: 7, away: 3 });
    await waitFor(() => h.rendered() !== "null");
    // 로드 범위 밖 메시지 삭제 — messages 불변, reconcileKey만 증가 (useChat 계약)
    h.update({ messages: [], reconcileKey: 1 });
    const triggered = await waitFor(() => calls.length === 2, 1000);
    check("삭제 이벤트가 재집계 트리거", triggered, true);
    calls[1].resolve({ total: 9, home: 6, away: 3 });
    await waitFor(() => h.rendered() === JSON.stringify({ total: 9, home: 6, away: 3 }));
    check("재집계 결과로 총계·팀계 동기화", JSON.parse(h.rendered()), { total: 9, home: 6, away: 3 });
    h.unmount();
  }

  // ── S4: request budget — hook N개 + INSERT 연속에도 쿼리 상한 ────────────
  console.log("S4) request budget (같은 방 hook 3개 + INSERT 5건)");
  {
    const { calls, fetcher } = makeFetcher();
    const hosts = [
      makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 }),
      makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 }),
      makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 }),
    ];
    await waitFor(() => calls.length === 3);
    check("초기 집계 = hook당 1발 (3발)", calls.length, 3);
    calls.forEach((c) => c.resolve({ total: 5, home: 2, away: 3 }));
    await sleep(50);
    // INSERT 5건 연속 — 서버 재집계 0건이어야 함 (낙관 증분이 즉시성 담당)
    for (let i = 1; i <= 5; i++) {
      const msgs = Array.from({ length: i }, (_, k) => msg(200 + k, HOME));
      hosts.forEach((h) => h.update({ messages: msgs, reconcileKey: 0 }));
      await sleep(20);
    }
    check("INSERT 연속에도 추가 집계 쿼리 0", calls.length, 3);
    check("낙관적 증분 반영", JSON.parse(hosts[0].rendered()), { total: 10, home: 7, away: 3 });
    hosts.forEach((h) => h.unmount());
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll chat-count-hook probes passed");
  process.exit(0); // react/jsdom 스케줄러가 event loop을 잡아 두므로 명시 종료.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
