/**
 * useHomePopularFeed 훅 + 홈 섹션(CommunityLatestPosts) 회귀 smoke (삼순 #1343 2~5차 재리뷰 고정, 설계 A + RPC)
 * — 실제 React(jsdom) mount + 주입 supabase.rpc 목. 모든 대기(waitFor)는 시한 초과 시 즉시 FAIL(throw).
 *
 * 설계 A: 페이지당 RPC 1회, 정확히 5/15개, 정확 소진. 노출 조건은 전부 SQL(home_popular_posts)이 판정.
 * 다음 페이지 = 화면 id 제외(p_exclude) 후 인기도 최상위 → 순위 이동 무관 누락 0·중복 0.
 *
 * [훅 코어: useHomePopularFeedCore 에 차단 목록·timeout 주입]
 * R1) 응답 역전(팀 전환): A 조회 pending 중 B 로 전환 → A 요청 abort 신호 수신 → B 응답 반영. RPC 인자:
 *     p_team_slug·p_other_kbo_ids(거부 목록: 두산 강승호 포함·LG 오지환 제외)·p_limit=want+1·p_exclude.
 * R2) 응답 역전(reload): 더보기 pending 중 reload → 옛 더보기 abort·잠금 즉시 해제 → 새 세대 더보기 독립 진행.
 * R3) 실패→재시도: 더보기 오류 → 목록/hasMore 보존(버튼 유지) → 재클릭 재조회 성공. 첫 조회 실패 → reload 복구.
 * R4) 정확 소진: 정확히 5건 → hasMore=false 즉시. 정확히 20건 → 더보기 후 false.
 * R5) 서버 인자: 차단 목록 p_blocked, 더보기 p_exclude=화면 id, 서버 결과 그대로 정확히 want 개(추가 조회 0).
 *     차단 목록 늦게 도착 → 첫 페이지 재조회. 같은 목록 재렌더 → 재조회 없음.
 * R6) 시간 상한: 더보기가 timeout 안에 응답 없음 → abort → 버튼 잠금 해제·재시도 가능. 첫 페이지 timeout → 섹션 숨김·reload 가능.
 * R7) 5→20→35 진행 + 순위 상승 글(첫 페이지 밖 95→110)이 다음 페이지 최상단에 나옴 + 창 소진 시 버튼 숨김.
 *
 * [실제 섹션 DOM: CommunityLatestPosts(myTeamId=LG) — 실제 useHomePopularFeed·버튼 게이트·disabled]
 * D1) 로딩 중 섹션 숨김 → 5행 렌더 + 버튼 노출. 실제 RPC 인자(LG·거부 목록·limit 6). 정확 5건이면 버튼 없음.
 * D2) 버튼 클릭 → 더보기 RPC(p_exclude 화면 5개·limit 16) → disabled/aria-busy → 15행 추가 → 소진 시 버튼 제거.
 * D3) 첫 조회 오류 → 섹션 숨김 → refreshNonce 로 복구.
 * D4) 더보기 pending 중 pull-to-refresh → 옛 요청 abort·새 첫 페이지 렌더·버튼 즉시 활성.
 *
 * 실행: npm run qa:home-popular-feed:hook
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
g.self = dom.window; // next/link 가 재렌더 경로에서 self 를 참조한다(jsdom 전역 보강)
g.sessionStorage = dom.window.sessionStorage;
g.localStorage = dom.window.localStorage;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
});
g.matchMedia = (dom.window as unknown as Record<string, unknown>).matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = false;

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  ❌ FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 조건이 시한 안에 참이 되지 않으면 throw — 대기 실패는 조용히 지나가지 않는다(삼순 3차). */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 1_500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await sleep(5);
  }
  if (!condition()) throw new Error(`waitFor timeout: ${what}`);
}

type Row = Record<string, unknown> & { id: number; popularity: number };
type RpcArgs = { p_since: string; p_limit: number; p_team_slug: string | null; p_other_kbo_ids: string[]; p_blocked: string[]; p_exclude: number[] };
type Pending = {
  seq: number;
  fn: string;
  args: RpcArgs;
  aborted: boolean;
  settled: boolean;
  resolve: (v: { data: Row[]; error: null }) => void;
  reject: (v: { data: null; error: { message: string } }) => void;
};

const LG_PLAYER_ID = "79109"; // 오지환(LG)
const DOOSAN_PLAYER_ID = "63123"; // 강승호(두산)

function row(id: number, popularity: number, opts: { team?: string[]; author?: string } = {}): Row {
  return {
    id,
    popularity,
    like_count: popularity,
    comment_count: 0,
    author_id: opts.author ?? `author-${id}`,
    board_type: "team",
    board_id: (opts.team ?? ["lg"])[0],
    content_type: "general",
    title: `p${id}`,
    content: "",
    image_urls: [],
    video_urls: [],
    created_at: "2026-09-04T00:00:00Z",
    is_hidden: false,
    game_id: null,
    player_tags: [],
    team_tags: opts.team ?? ["lg"],
    hashtags: [],
    author_team_id_snapshot: 1,
    click_view_count: 0,
    impression_view_count: 0,
    profiles: null,
  };
}
/** 인기도 내림차순 id 내림차순 행 n개 (id 는 base 부터 감소). */
function rows(n: number, base = 1000, popStart = 100, team: string[] = ["lg"]): Row[] {
  return Array.from({ length: n }, (_, i) => row(base - i, popStart - i, { team }));
}

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { useHomePopularFeedCore } = await import("../../src/lib/supabase/useHomePopularFeed");
  type HomePopularBoard = import("../../src/lib/supabase/useHomePopularFeed").HomePopularBoard;
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");
  const CommunityLatestPosts = (await import("../../src/components/home/CommunityLatestPosts")).default;

  const pending: Pending[] = [];
  let seq = 0;
  const unsettled = () => pending.filter((q) => !q.settled);

  const mutableClient = supabase as unknown as { rpc: (fn: string, args: RpcArgs) => unknown; from: (t: string) => unknown };
  mutableClient.from = (table: string) => {
    throw new Error(`unexpected supabase.from(${table}) — 홈 인기글은 RPC 만 써야 한다`);
  };
  mutableClient.rpc = (fn: string, args: RpcArgs) => {
    const entry: Pending = { seq: ++seq, fn, args, aborted: false, settled: false, resolve: () => {}, reject: () => {} };
    const builder = {
      select: () => builder,
      abortSignal: (signal: AbortSignal) =>
        new Promise<{ data: Row[]; error: null } | { data: null; error: { message: string } }>((resolve) => {
          entry.resolve = (v) => resolve(v);
          entry.reject = (v) => resolve(v);
          signal.addEventListener("abort", () => {
            entry.aborted = true;
            if (!entry.settled) {
              entry.settled = true;
              resolve({ data: null, error: { message: "AbortError" } });
            }
          });
          pending.push(entry);
        }),
    };
    return builder;
  };

  const settle = (q: Pending, data: Row[]) => {
    q.settled = true;
    q.resolve({ data, error: null });
  };
  const failQ = (q: Pending) => {
    q.settled = true;
    q.reject({ data: null, error: { message: "boom" } });
  };
  const last = () => {
    const u = unsettled();
    if (!u.length) throw new Error("no pending query");
    return u[u.length - 1];
  };
  const waitPending = (n: number, what: string) => waitFor(() => unsettled().length === n, `${what} (pending=${n})`);
  const isDenyListLg = (a: RpcArgs) => a.p_other_kbo_ids.length > 500 && a.p_other_kbo_ids.includes(DOOSAN_PLAYER_ID) && !a.p_other_kbo_ids.includes(LG_PLAYER_ID);

  // ───────────────────────── 훅 코어 하네스 ─────────────────────────
  type HostProps = { board: HomePopularBoard; blocked?: string[]; timeoutMs?: number };
  function Host({ board, blocked = [], timeoutMs }: HostProps) {
    const sig = blocked.join(",");
    const blockedSet = React.useMemo(() => new Set(sig ? sig.split(",") : []), [sig]);
    const options = React.useMemo(() => (timeoutMs ? { timeoutMs } : {}), [timeoutMs]);
    const { posts, loading, loadingMore, hasMore, loadMore, reload } = useHomePopularFeedCore(board, 5, 15, blockedSet, options);
    return React.createElement(
      "div",
      null,
      React.createElement("output", null, `${loading ? "L|" : ""}${posts.map((p) => p.id).join(",")}|more=${hasMore}|lm=${loadingMore}`),
      // 실제 섹션과 같은 게이트: hasMore 일 때만 렌더, loadingMore 면 disabled.
      hasMore ? React.createElement("button", { id: "more", disabled: loadingMore, onClick: () => void loadMore() }, "more") : null,
      React.createElement("button", { id: "reload", onClick: () => void reload() }, "reload"),
    );
  }

  const LG: HomePopularBoard = { kind: "team", teamId: "lg" };
  const DOOSAN: HomePopularBoard = { kind: "team", teamId: "doosan" };

  function mount(props: HostProps) {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    root.render(React.createElement(Host, props));
    const text = () => container.querySelector("output")?.textContent ?? "";
    const btn = (id: string) => container.querySelector(`#${id}`) as HTMLButtonElement | null;
    const click = (id: string) => {
      const b = btn(id);
      if (!b) throw new Error(`button #${id} not rendered`);
      if (b.disabled) throw new Error(`button #${id} disabled`);
      b.click();
    };
    return { root, container, text, btn, click, rerender: (p: HostProps) => root.render(React.createElement(Host, p)) };
  }

  // ── R1 ──
  console.log("── R1 팀 전환 응답 역전·RPC 인자·abort");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R1 초기 조회");
    const qA = last();
    check("R1 RPC 이름·LG·p_limit 6(5+확인행)·p_exclude 없음·차단 없음", qA.fn === "home_popular_posts" && qA.args.p_team_slug === "lg" && qA.args.p_limit === 6 && qA.args.p_exclude.length === 0 && qA.args.p_blocked.length === 0, JSON.stringify({ ...qA.args, p_other_kbo_ids: qA.args.p_other_kbo_ids.length }));
    check("R1 거부 목록 = 타팀 로스터(두산 강승호 포함·LG 오지환 제외·500+)", isDenyListLg(qA.args), `n=${qA.args.p_other_kbo_ids.length}`);
    h.rerender({ board: DOOSAN });
    await waitFor(() => qA.aborted, "R1 팀 전환 시 A 요청 abort");
    check("R1 팀 전환 → 진행 중 A 요청 abort", qA.aborted);
    await waitPending(1, "R1 팀 전환 조회");
    const qB = last();
    check("R1 전환 직후 loading 표시", h.text().startsWith("L|"), h.text());
    check("R1 두산 전환 → p_team_slug doosan·거부 목록에 오지환 포함·강승호 제외", qB.args.p_team_slug === "doosan" && qB.args.p_other_kbo_ids.includes(LG_PLAYER_ID) && !qB.args.p_other_kbo_ids.includes(DOOSAN_PLAYER_ID));
    settle(qB, rows(6, 2000, 100, ["doosan"]));
    await waitFor(() => h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", "R1 B 응답 반영");
    check("R1 B 응답 반영(5개, 확인행 제외, hasMore=true)", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    h.click("more");
    await waitPending(1, "R1 더보기");
    const qMore = last();
    check("R1 더보기 p_exclude = 화면 id 5개·두산·p_limit 16", qMore.args.p_exclude.join() === "2000,1999,1998,1997,1996" && qMore.args.p_team_slug === "doosan" && qMore.args.p_limit === 16, JSON.stringify(qMore.args.p_exclude));
    settle(qMore, []);
    await waitFor(() => h.text().includes("more=false"), "R1 소진");
    check("R1 더보기 빈 응답 → 소진·버튼 제거", h.text() === "2000,1999,1998,1997,1996|more=false|lm=false" && h.btn("more") === null, h.text());
    h.root.unmount();
  }

  // ── R2 ──
  console.log("── R2 reload 응답 역전·잠금·abort");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R2 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R2 초기 반영");
    h.click("more");
    await waitPending(1, "R2 더보기");
    const qMore = last();
    await waitFor(() => h.btn("more")?.disabled === true, "R2 더보기 중 disabled");
    check("R2 더보기 응답 대기 중 버튼 disabled", h.btn("more")?.disabled === true, h.text());
    h.click("reload");
    await waitFor(() => qMore.aborted, "R2 reload 시 옛 더보기 abort");
    check("R2 reload → 옛 더보기 요청 abort", qMore.aborted);
    await waitPending(1, "R2 reload 조회");
    const qReload = last();
    check("R2 reload 는 p_exclude 없이 첫 페이지", qReload.args.p_exclude.length === 0 && qReload.args.p_limit === 6);
    // reload 는 응답 전까지 기존 행을 유지한 채 loading 만 켠다 — 옛 더보기 잠금(lm)은 즉시 풀려야 한다.
    await waitFor(() => h.text().startsWith("L|1000,999,998,997,996|") && h.text().endsWith("lm=false"), "R2 reload 중 옛 잠금 해제");
    check("R2 reload 직후(응답 전) 옛 더보기 잠금 해제(lm=false)", h.text() === "L|1000,999,998,997,996|more=true|lm=false", h.text());
    settle(qReload, rows(6, 3000));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996|more=true|lm=false", "R2 reload 반영");
    check("R2 reload 반영·버튼 활성", h.btn("more")?.disabled === false, h.text());
    h.click("more");
    await waitPending(1, "R2 새 세대 더보기");
    check("R2 새 세대 더보기 p_exclude = 새 첫 페이지 id", last().args.p_exclude.join() === "3000,2999,2998,2997,2996", last().args.p_exclude.join());
    settle(last(), rows(2, 2995, 95));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996,2995,2994|more=false|lm=false", "R2 새 세대 더보기 반영");
    check("R2 새 세대 더보기 반영·소진", h.text() === "3000,2999,2998,2997,2996,2995,2994|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R3 ──
  console.log("── R3 실패→재시도");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R3 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R3 초기 반영");
    h.click("more");
    await waitPending(1, "R3 더보기");
    failQ(last());
    await waitFor(() => h.text().endsWith("lm=false") && unsettled().length === 0, "R3 오류 정착");
    check("R3 조회 오류 후 posts/hasMore 보존(버튼 유지·활성)", h.text() === "1000,999,998,997,996|more=true|lm=false" && h.btn("more")?.disabled === false, h.text());
    h.click("more");
    await waitPending(1, "R3 재시도");
    check("R3 재시도가 같은 제외 목록으로 나감", last().args.p_exclude.join() === "1000,999,998,997,996");
    settle(last(), rows(3, 995));
    await waitFor(() => h.text().includes("more=false"), "R3 재시도 반영");
    check("R3 재시도 성공 → 이어 붙고 소진", h.text() === "1000,999,998,997,996,995,994,993|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R3b 초기 조회");
    failQ(last());
    await waitFor(() => !h.text().startsWith("L|"), "R3b 오류 정착");
    check("R3b 첫 조회 실패 → 빈 목록(섹션 숨김)·loading 해제", h.text() === "|more=true|lm=false", h.text());
    h.click("reload");
    await waitPending(1, "R3b reload");
    settle(last(), rows(2, 500));
    await waitFor(() => h.text() === "500,499|more=false|lm=false", "R3b 복구");
    check("R3b reload 로 복구", h.text() === "500,499|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R4 ──
  console.log("── R4 정확 소진");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R4 초기 조회");
    settle(last(), rows(5, 1000));
    await waitFor(() => !h.text().startsWith("L|"), "R4 초기 반영");
    check("R4 정확히 5건 → 초기 조회 직후 hasMore=false·버튼 없음", h.text() === "1000,999,998,997,996|more=false|lm=false" && h.btn("more") === null, h.text());
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R4b 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R4b 초기 반영");
    h.click("more");
    await waitPending(1, "R4b 더보기");
    settle(last(), rows(15, 995));
    await waitFor(() => h.text().includes("more=false"), "R4b 소진");
    check("R4 정확히 20건 → 더보기 직후 hasMore=false", h.text().endsWith("981|more=false|lm=false") && h.text().split("|")[0].split(",").length === 20, h.text());
    h.root.unmount();
  }

  // ── R5 ──
  console.log("── R5 서버 인자·정확 채움");
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad-1", "bad-2"] });
    await waitPending(1, "R5 초기 조회");
    check("R5 차단 목록이 p_blocked 로 서버에 실림", last().args.p_blocked.join() === "bad-1,bad-2", last().args.p_blocked.join());
    settle(last(), rows(6, 1000));
    await waitFor(() => !h.text().startsWith("L|"), "R5 반영");
    await sleep(20);
    check("R5 서버 결과 그대로 정확 5개·추가 조회 0", h.text() === "1000,999,998,997,996|more=true|lm=false" && unsettled().length === 0, `${h.text()} pending=${unsettled().length}`);
    h.click("more");
    await waitPending(1, "R5 더보기");
    check("R5 더보기: p_blocked + p_exclude 동시 전송", last().args.p_blocked.join() === "bad-1,bad-2" && last().args.p_exclude.join() === "1000,999,998,997,996");
    settle(last(), rows(3, 995));
    await waitFor(() => h.text().includes("more=false"), "R5 소진");
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R5b 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R5b 초기 반영");
    h.rerender({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R5b 재조회");
    check("R5b 차단 목록 늦게 도착 → 첫 페이지 재조회(p_exclude 없음·p_blocked bad)", last().args.p_exclude.length === 0 && last().args.p_blocked.join() === "bad");
    settle(last(), [row(999, 99), row(997, 97)]);
    await waitFor(() => h.text() === "999,997|more=false|lm=false", "R5b 반영");
    check("R5b 재조회 결과로 교체·소진", h.text() === "999,997|more=false|lm=false", h.text());
    h.rerender({ board: LG, blocked: ["bad"] });
    await sleep(30);
    check("R5b 같은 차단 목록 재렌더는 재조회 없음", unsettled().length === 0, String(unsettled().length));
    h.root.unmount();
  }

  // ── R6 ──
  console.log("── R6 시간 상한(timeout → abort)");
  {
    pending.length = 0;
    const h = mount({ board: LG, timeoutMs: 80 });
    await waitPending(1, "R6 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R6 초기 반영");
    h.click("more");
    await waitPending(1, "R6 더보기");
    const q = last();
    await waitFor(() => q.aborted, "R6 timeout abort", 1_000);
    await waitFor(() => h.text().endsWith("lm=false"), "R6 잠금 해제");
    check("R6 더보기 무응답 → timeout abort → 목록 보존·버튼 활성(재시도 가능)", q.aborted && h.text() === "1000,999,998,997,996|more=true|lm=false" && h.btn("more")?.disabled === false, h.text());
    h.click("more");
    await waitPending(1, "R6 재시도");
    settle(last(), rows(1, 995));
    await waitFor(() => h.text() === "1000,999,998,997,996,995|more=false|lm=false", "R6 재시도 반영");
    check("R6 재시도 성공", h.text() === "1000,999,998,997,996,995|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG, timeoutMs: 80 });
    await waitPending(1, "R6b 초기 조회");
    const q = last();
    await waitFor(() => q.aborted, "R6b 첫 페이지 timeout abort", 1_000);
    await waitFor(() => !h.text().startsWith("L|"), "R6b loading 해제");
    check("R6b 첫 페이지 무응답 → timeout → 빈 목록·loading 해제(reload 가능)", h.text() === "|more=true|lm=false", h.text());
    h.click("reload");
    await waitPending(1, "R6b reload");
    settle(last(), rows(2, 500));
    await waitFor(() => h.text() === "500,499|more=false|lm=false", "R6b 복구");
    check("R6b reload 로 복구", h.text() === "500,499|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    // 언마운트 시 진행 중 요청 abort
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R6c 초기 조회");
    const q = last();
    h.root.unmount();
    await waitFor(() => q.aborted, "R6c 언마운트 abort");
    check("R6c 언마운트 → 진행 중 요청 abort", q.aborted);
  }

  // ── R7 ──
  console.log("── R7 5→20→35·순위 상승 반례·소진");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R7 초기 조회");
    settle(last(), rows(6, 1000)); // 확인행 995(점수 95)는 미노출
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R7 초기 반영");
    h.click("more");
    await waitPending(1, "R7 더보기");
    check("R7 2페이지 p_exclude = 화면 5개(커서 없음)", last().args.p_exclude.join() === "1000,999,998,997,996");
    // 순위 상승 반례: 미노출 995 가 95→110 으로 올라 서버가 다음 페이지 최상단으로 돌려준다(커서 방식이면 누락).
    settle(last(), [row(995, 110), ...rows(15, 994, 94)]); // 995 + 994..980 (확인행 980)
    await waitFor(() => h.text().split("|")[0].split(",").length === 20, "R7 20개");
    const ids = h.text().split("|")[0].split(",").map(Number);
    check("R7 순위 상승 글 995 가 2페이지 최상단·20개·중복 0·hasMore=true", ids[5] === 995 && ids.length === 20 && new Set(ids).size === 20 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 3페이지");
    check("R7 3페이지 p_exclude 20개", last().args.p_exclude.length === 20 && last().args.p_exclude.includes(995));
    settle(last(), rows(16, 979, 79));
    await waitFor(() => h.text().split("|")[0].split(",").length === 35, "R7 35개");
    check("R7 35개·hasMore=true", h.text().split("|")[0].split(",").length === 35 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 4페이지");
    settle(last(), rows(4, 964, 64));
    await waitFor(() => h.text().includes("more=false"), "R7 소진");
    check("R7 창 소진 → 39개·버튼 숨김", h.text().split("|")[0].split(",").length === 39 && h.text().includes("more=false") && h.btn("more") === null, h.text());
    h.root.unmount();
  }

  // ───────────────────────── 실제 섹션 DOM ─────────────────────────
  console.log("── D 실제 섹션(CommunityLatestPosts) DOM");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => Promise.resolve() };
  function mountSection(refreshNonce = 0) {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    const render = (nonce: number) =>
      root.render(
        React.createElement(
          AppRouterContext.Provider,
          { value: router as never },
          React.createElement(ThemeProvider, null, React.createElement(CommunityLatestPosts, { myTeamId: 1, refreshNonce: nonce })),
        ),
      );
    render(refreshNonce);
    const rowsOf = () => Array.from(container.querySelectorAll("a[href*='/posts/']")).length;
    const moreBtn = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("개 더 보기")) as HTMLButtonElement | undefined;
    const section = () => container.querySelector("section");
    return { root, container, render, rowsOf, moreBtn, section };
  }
  const sectionMoreBtn = (s: ReturnType<typeof mountSection>) => {
    const b = s.moreBtn();
    if (!b) throw new Error("'15개 더 보기' 버튼 없음");
    if (b.disabled) throw new Error("'15개 더 보기' disabled");
    b.click();
  };

  // D1
  {
    pending.length = 0;
    const s = mountSection();
    await waitPending(1, "D1 초기 조회");
    check("D1 로딩 중 섹션 숨김", s.section() === null);
    check("D1 실제 RPC 인자(LG·거부 목록·p_limit 6)", last().fn === "home_popular_posts" && last().args.p_team_slug === "lg" && isDenyListLg(last().args) && last().args.p_limit === 6);
    settle(last(), rows(6, 1000));
    await waitFor(() => s.rowsOf() === 5, "D1 5행 렌더");
    check("D1 섹션 표시·5행·제목 '커뮤니티 인기글(LG)'", s.section() !== null && s.rowsOf() === 5 && (s.section()?.textContent ?? "").includes("커뮤니티 인기글(LG)"));
    check("D1 '15개 더 보기' 버튼 노출·활성", s.moreBtn()?.textContent?.includes("15개 더 보기") === true && s.moreBtn()?.disabled === false);
    check("D1 하단 링크 '커뮤니티 최신글 보기'(/community/all-posts)·'접기' 없음", (s.section()?.textContent ?? "").includes("커뮤니티 최신글 보기") && !(s.section()?.textContent ?? "").includes("접기") && s.container.querySelector("a[href='/community/all-posts']") !== null);
    s.root.unmount();
  }
  {
    pending.length = 0;
    const s = mountSection();
    await waitPending(1, "D1b 초기 조회");
    settle(last(), rows(5, 1000));
    await waitFor(() => s.rowsOf() === 5, "D1b 5행 렌더");
    check("D1b 정확 5건 → 버튼 없음", s.moreBtn() === undefined);
    s.root.unmount();
  }

  // D2
  {
    pending.length = 0;
    const s = mountSection();
    await waitPending(1, "D2 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => s.rowsOf() === 5, "D2 5행");
    sectionMoreBtn(s);
    await waitPending(1, "D2 더보기 조회");
    check("D2 버튼 클릭 → 더보기 RPC(p_exclude 화면 5개·p_limit 16)", last().args.p_exclude.join() === "1000,999,998,997,996" && last().args.p_limit === 16);
    await waitFor(() => s.moreBtn()?.disabled === true, "D2 disabled");
    check("D2 응답 대기 중 disabled·aria-busy", s.moreBtn()?.disabled === true && s.moreBtn()?.getAttribute("aria-busy") === "true");
    settle(last(), rows(15, 995));
    await waitFor(() => s.rowsOf() === 20, "D2 20행");
    check("D2 15행 추가(20행)·정확 소진 → 버튼 제거", s.rowsOf() === 20 && s.moreBtn() === undefined);
    s.root.unmount();
  }

  // D3
  {
    pending.length = 0;
    const s = mountSection();
    await waitPending(1, "D3 초기 조회");
    failQ(last());
    await sleep(40);
    check("D3 첫 조회 오류 → 섹션 숨김(빈 박스 없음)·추가 조회 없음", s.section() === null && unsettled().length === 0);
    s.render(1);
    await waitPending(1, "D3 refresh 재조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => s.rowsOf() === 5, "D3 복구");
    check("D3 refreshNonce 로 복구·5행·버튼", s.rowsOf() === 5 && s.moreBtn() !== undefined);
    s.root.unmount();
  }

  // D4
  {
    pending.length = 0;
    const s = mountSection();
    await waitPending(1, "D4 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => s.rowsOf() === 5, "D4 5행");
    sectionMoreBtn(s);
    await waitPending(1, "D4 더보기 조회");
    const oldMore = last();
    await waitFor(() => s.moreBtn()?.disabled === true, "D4 disabled");
    s.render(1); // pull-to-refresh
    await waitFor(() => oldMore.aborted, "D4 refresh 시 옛 더보기 abort");
    await waitPending(1, "D4 refresh 조회");
    const qRefresh = last();
    check("D4 refreshNonce → 옛 더보기 abort + 첫 페이지 재조회(p_exclude 없음)", oldMore.aborted && qRefresh.args.p_exclude.length === 0 && qRefresh.args.p_limit === 6);
    settle(qRefresh, rows(6, 3000));
    await waitFor(() => s.rowsOf() === 5 && s.container.querySelector("a[href*='3000']") !== null, "D4 새 첫 페이지");
    check("D4 새 첫 페이지 렌더·버튼 즉시 활성(옛 더보기 잠금 해제)", s.moreBtn()?.disabled === false);
    s.root.unmount();
  }

  console.log(`\n${fail ? "❌" : "✅"} home-popular-feed-hook-smoke — pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("❌ home-popular-feed-hook-smoke ABORT:", e instanceof Error ? e.message : e);
  process.exit(1);
});
