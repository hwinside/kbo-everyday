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
 * S5) in-flight INSERT lost-update (라운드3 blocker): 서버 스냅샷(maxSeenId) 이후
 *     도착한 INSERT가 응답 commit으로 유실되지 않고 +1 보존 (삼순 jsdom 시나리오
 *     snapshot=10/4/6 → home INSERT(id>fence) → response 10/4/6 → 기대 11/5/6)
 * S6) in-flight loaded DELETE lost-update (라운드3 blocker): 스냅샷 이후 삭제된
 *     로드 메시지가 응답 commit으로 -1을 잃지 않고 보존 (deleted_at > snapshotAt)
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
  type ServerChatCounts = ChatCounts & { maxSeenId: number; snapshotAt: string };
  type Msg = { id: number; room_id: string; user_id: string; content: string; created_at: string; deleted_at?: string | null; team_id?: number };

  const HOME = 1;
  const AWAY = 2;
  // 넉넉히 큰 fence — 현재 로드 메시지가 전부 스냅샷에 포함된(경계 밖 이벤트 없음) 응답.
  const NO_FENCE = Number.MAX_SAFE_INTEGER;
  const LATE = "2999-01-01T00:00:00.000Z"; // snapshotAt: 어떤 삭제도 이 이후가 아님(=삭제 보존 없음).
  const snap = (
    c: ChatCounts,
    maxSeenId: number = NO_FENCE,
    snapshotAt: string = LATE
  ): ServerChatCounts => ({ ...c, maxSeenId, snapshotAt });
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
    const calls: Array<{ resolve: (v: ServerChatCounts | null) => void }> = [];
    const fetcher = () =>
      new Promise<ServerChatCounts | null>((resolve) => {
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
    // fence=101: msg101은 스냅샷에 포함됨(중복 증분 금지) → 10/4/6 그대로.
    calls[0].resolve(snap({ total: 10, home: 4, away: 6 }, 101));
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
    calls[1].resolve(snap({ total: 10, home: 7, away: 3 }));
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
    calls[0].resolve(snap({ total: 10, home: 7, away: 3 }));
    await waitFor(() => h.rendered() !== "null");
    // 로드 범위 밖 메시지 삭제 — messages 불변, reconcileKey만 증가 (useChat 계약)
    h.update({ messages: [], reconcileKey: 1 });
    const triggered = await waitFor(() => calls.length === 2, 1000);
    check("삭제 이벤트가 재집계 트리거", triggered, true);
    calls[1].resolve(snap({ total: 9, home: 6, away: 3 }));
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
    // fence=199: 이후 INSERT(id 200~) 는 낙관적 +1 대상.
    calls.forEach((c) => c.resolve(snap({ total: 5, home: 2, away: 3 }, 199)));
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

  // ── S5: in-flight INSERT lost-update (삼순 라운드3 blocker) ────────────────
  // 서버 count의 DB snapshot(=maxSeenId fence)이 10/4/6이고 그 뒤 홈팀 INSERT(id>fence)가
  // 도착한 다음 count 응답이 도착 → 응답을 baseline로 잡되 fence 밖 INSERT는 +1 보존.
  // 기대 11/5/6 (응답값 10/4/6 그대로가 아니라 fence 밖 도착분이 살아있어야 함).
  console.log("S5) in-flight INSERT lost-update (snapshot 10/4/6 → home INSERT → response 10/4/6 → 기대 11/5/6)");
  {
    const { calls, fetcher } = makeFetcher();
    const h = makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 });
    await waitFor(() => calls.length === 1);
    // 서버 snapshot 이후 도착한 홈팀 INSERT — fence(100)보다 큰 id 150.
    h.update({ messages: [msg(150, HOME)], reconcileKey: 0 });
    await sleep(30);
    // 응답은 snapshot 시점 count(10/4/6) + fence=100(=msg150 미포함).
    calls[0].resolve(snap({ total: 10, home: 4, away: 6 }, 100));
    const ok = await waitFor(
      () => h.rendered() === JSON.stringify({ total: 11, home: 5, away: 6 })
    );
    check("fence 밖 INSERT delta 보존(lost-update 방지)", ok ? JSON.parse(h.rendered()) : h.rendered(), {
      total: 11,
      home: 5,
      away: 6,
    });
    check("보존은 서버 재조회 없이", calls.length, 1);
    h.unmount();
  }

  // ── S6: in-flight loaded DELETE lost-update (삼순 라운드3 blocker) ───────────
  // 로드된 메시지(id 50, AWAY)가 baseline이 잡힌 뒤, 재집계 in-flight 동안 삭제되면
  // 응답 snapshot(삭제 이전)은 alive로 집계 → commit이 -1을 지우면 안 됨(deleted_at > snapshotAt).
  console.log("S6) in-flight loaded DELETE lost-update (삭제 -1 보존)");
  {
    const { calls, fetcher } = makeFetcher();
    const h = makeHost(fetcher, { intervalMs: 60000, retryMs: 60000, deleteDebounceMs: 10 });
    await waitFor(() => calls.length === 1);
    // 1차 baseline: 로드된 msg50(alive) 포함, fence=100, snapshot 시각 T0.
    h.update({ messages: [msg(50, AWAY)], reconcileKey: 0 });
    await sleep(20);
    const T0 = "2026-07-24T12:00:00.000Z";
    calls[0].resolve(snap({ total: 10, home: 6, away: 4 }, 100, T0));
    await waitFor(() => h.rendered() === JSON.stringify({ total: 10, home: 6, away: 4 }));
    // 2차 재집계 요청 동안(reconcileKey 증가로 트리거) msg50이 삭제됨 → 낙관적 -1(away).
    const T_DEL = "2026-07-24T12:00:30.000Z"; // snapshot(T1)보다 나중.
    h.update({ messages: [msg(50, AWAY, T_DEL)], reconcileKey: 1 });
    await waitFor(() => h.rendered() === JSON.stringify({ total: 9, home: 6, away: 3 }));
    check("삭제 즉시 낙관적 -1", JSON.parse(h.rendered()), { total: 9, home: 6, away: 3 });
    // 2차 응답은 삭제 이전 snapshot(T1 < T_DEL)이라 msg50을 alive로 집계(10/6/4).
    await waitFor(() => calls.length === 2, 1000);
    const T1 = "2026-07-24T12:00:10.000Z";
    calls[1].resolve(snap({ total: 10, home: 6, away: 4 }, 100, T1));
    // commit이 -1을 보존해 9/6/3 유지(10/6/4로 되돌아가면 lost-update).
    await sleep(60);
    check("응답 commit 후에도 삭제 -1 보존", JSON.parse(h.rendered()), { total: 9, home: 6, away: 3 });
    h.unmount();
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
