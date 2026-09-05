/**
 * useHomePopularFeed 훅 + 홈 섹션(CommunityLatestPosts) 회귀 smoke (삼순 #1343 2·3차 재리뷰 고정)
 * — 실제 React(jsdom) mount + 주입 supabase 목. 모든 대기(waitFor)는 시한 초과 시 즉시 FAIL(throw).
 *
 * [훅 코어: useHomePopularFeedCore 에 차단 목록 주입]
 * R1) 응답 역전(팀 전환): A 조회 pending 중 B 로 전환 → B 응답 → 늦은 A 응답 도착.
 *     화면·커서·hasMore 모두 B 기준이어야 하고, A 행이 섞이거나 A 커서로 더보기가 나가면 FAIL.
 * R2) 응답 역전(reload): 더보기 pending 중 reload → reload 응답 → 늦은 더보기 응답 도착.
 *     첫 페이지만 보여야 하고 옛 더보기 행이 뒤에 붙으면 FAIL. reload 직후 옛 더보기 잠금(loadingMore)이 풀려
 *     새 세대 더보기가 즉시 나가야 하고, 옛 요청 완료가 새 세대 잠금을 건드리면 FAIL(3차 ②).
 * R3) 실패→재시도: 더보기 조회 오류 → posts/cursor/hasMore 보존(버튼 유지) → 재클릭 시 같은 커서로 재조회 성공.
 * R4) 정확 소진: 창 안 글이 정확히 5건 → 초기 조회 직후 hasMore=false. 정확히 20건 → 더보기 후 false.
 * R5) 필터 전부 탈락 채우기: 첫 묶음 전부 타팀 선수 태그 → 이어 읽어 5개를 채운다. 첫 20건 부적합이면 21번째
 *     적합 글까지 이어간다(3차 ①). 1건 이상 채운 뒤에는 상한(4묶음)에서 멈추고 hasMore 유지.
 * R6) 차단 채우기: 차단 작성자 글을 건너뛰고 채운다. 차단 목록이 늦게 도착하면 첫 페이지를 다시 채운다.
 * R7) 5→20→35 진행 + 순위 이동 재등장 글 dedupe + 창 소진 시 버튼 숨김.
 * R8) 확인행 노출 필터: 적합 5건 + 부적합 확인행 → 뒤를 더 읽어 다음 적합 글 존재로만 hasMore 판정(3차 ③).
 *
 * [실제 섹션 DOM: CommunityLatestPosts(myTeamId=LG) — 실제 useHomePopularFeed·버튼 게이트·disabled]
 * D1) 로딩 중 섹션 숨김 → 5행 렌더 + '15개 더 보기' 버튼(hasMore) 노출. 정확 5건이면 버튼 없음.
 * D2) 버튼 클릭 → 더보기 조회 → 응답 중 disabled/aria-busy → 15행 추가 → 소진 시 버튼 제거.
 * D3) 첫 20건 부적합(타팀 선수 태그) → 섹션이 숨지 않고 21번째부터 5행 렌더(3차 ①).
 * D4) 더보기 pending 중 pull-to-refresh(refreshNonce) → 새 첫 페이지 렌더, 버튼 즉시 활성, 늦은 옛 응답 무시(3차 ②).
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
type Pending = {
  seq: number;
  team: string | null;
  cursorOr: string | null;
  limit: number;
  settled: boolean;
  resolve: (v: { data: Row[]; error: null }) => void;
  reject: (v: { data: null; error: { message: string } }) => void;
};

const LG_PLAYER = "79109:오지환";
const DOOSAN_PLAYER = "63123:강승호";

function row(id: number, popularity: number, opts: { team?: string[]; players?: string[]; author?: string } = {}): Row {
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
    player_tags: opts.players ?? [],
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
/** 타팀(두산) 선수 태그가 섞인 [lg] 글 n개 — 서버 eq 필터는 통과하지만 배지 SSOT 재확인에서 탈락. */
function mixedRows(n: number, base: number, popStart: number): Row[] {
  return Array.from({ length: n }, (_, i) => row(base - i, popStart - i, { players: [DOOSAN_PLAYER] }));
}

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { useHomePopularFeedCore } = await import("../../src/lib/supabase/useHomePopularFeed");
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");
  const CommunityLatestPosts = (await import("../../src/components/home/CommunityLatestPosts")).default;
  type FeedBoard = import("../../src/lib/supabase/useUnifiedFeed").FeedBoard;

  const pending: Pending[] = [];
  let seq = 0;
  const unsettled = () => pending.filter((q) => !q.settled);

  const mutableClient = supabase as unknown as { from: (table: string) => unknown };
  mutableClient.from = (table: string) => {
    if (table !== "posts") throw new Error(`unexpected table: ${table}`);
    let team: string | null = null;
    let cursorOr: string | null = null;
    const query = {
      select: () => query,
      neq: () => query,
      gte: () => query,
      in: () => query,
      eq: () => query,
      filter: (col: string, op: string, value: string) => {
        if (col === "team_tags" && op === "eq") team = value;
        return query;
      },
      or: (expr: string) => {
        if (expr.startsWith("popularity.lt.")) cursorOr = expr;
        return query;
      },
      order: () => query,
      limit: (limit: number) =>
        new Promise<{ data: Row[]; error: null } | { data: null; error: { message: string } }>((resolve) => {
          pending.push({
            seq: ++seq,
            team,
            cursorOr,
            limit,
            settled: false,
            resolve: (v) => resolve(v),
            // supabase-js 는 오류를 reject 가 아니라 { error } 로 돌려준다 — 훅의 error 분기를 그대로 태운다.
            reject: (v) => resolve(v),
          });
        }),
    };
    return query;
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
  const cursorFilterOf = (id: number, popularity: number) => `popularity.lt.${popularity},and(popularity.eq.${popularity},id.lt.${id})`;

  // ───────────────────────── 훅 코어 하네스 ─────────────────────────
  type HostProps = { board: FeedBoard; blocked?: string[] };
  function Host({ board, blocked = [] }: HostProps) {
    const sig = blocked.join(",");
    const blockedSet = React.useMemo(() => new Set(sig ? sig.split(",") : []), [sig]);
    const { posts, loading, loadingMore, hasMore, loadMore, reload } = useHomePopularFeedCore(board, 5, 15, blockedSet);
    return React.createElement(
      "div",
      null,
      React.createElement(
        "output",
        null,
        `${loading ? "L|" : ""}${posts.map((p) => p.id).join(",")}|more=${hasMore}|lm=${loadingMore}`,
      ),
      // 실제 섹션과 같은 게이트: hasMore 일 때만 렌더, loadingMore 면 disabled.
      hasMore ? React.createElement("button", { id: "more", disabled: loadingMore, onClick: () => void loadMore() }, "more") : null,
      React.createElement("button", { id: "reload", onClick: () => void reload() }, "reload"),
    );
  }

  const LG: FeedBoard = { kind: "team", teamId: "lg" };
  const DOOSAN: FeedBoard = { kind: "team", teamId: "doosan" };

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

  // ── R1: 팀 전환 응답 역전 ──
  console.log("── R1 팀 전환 응답 역전");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R1 초기 조회");
    const qA = last();
    check("R1 초기 조회가 LG 단독 필터·limit 6(5+확인행)", qA.team === '["lg"]' && qA.limit === 6, `team=${qA.team} limit=${qA.limit}`);
    h.rerender({ board: DOOSAN });
    await waitPending(2, "R1 팀 전환 조회");
    const qB = last();
    check("R1 전환 직후 loading 표시", h.text().startsWith("L|"), h.text());
    settle(qB, rows(6, 2000, 100, ["doosan"])); // B: 2000..1995 (확인행 1995), 두산 단독 글
    await waitFor(() => h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", "R1 B 응답 반영");
    check("R1 B 응답 반영(5개, 확인행 제외, hasMore=true)", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    settle(qA, rows(3, 1000)); // 늦은 A 응답: 3건(소진) — 반영되면 화면/hasMore 가 오염된다
    await sleep(30);
    check("R1 늦은 A 응답이 화면·hasMore 를 덮지 않음", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    h.click("more");
    await waitPending(1, "R1 더보기");
    const qMore = last();
    check("R1 더보기 커서가 B 의 마지막 소비 행(1996)", qMore.cursorOr === cursorFilterOf(1996, 96) && qMore.team === '["doosan"]', `${qMore.cursorOr} team=${qMore.team}`);
    settle(qMore, []);
    await waitFor(() => h.text().includes("more=false"), "R1 소진");
    check("R1 더보기 빈 응답 → 소진·버튼 제거", h.text() === "2000,1999,1998,1997,1996|more=false|lm=false" && h.btn("more") === null, h.text());
    h.root.unmount();
  }

  // ── R2: reload 응답 역전 + 옛 더보기 잠금 해제 ──
  console.log("── R2 reload 응답 역전·잠금");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R2 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R2 초기 반영");
    h.click("more");
    await waitPending(1, "R2 더보기");
    const qMore = last();
    check("R2 더보기 limit 16(15+확인행)·커서 996", qMore.limit === 16 && qMore.cursorOr === cursorFilterOf(996, 96), `${qMore.limit} ${qMore.cursorOr}`);
    await waitFor(() => h.btn("more")?.disabled === true, "R2 더보기 중 disabled");
    check("R2 더보기 응답 대기 중 버튼 disabled", h.btn("more")?.disabled === true, h.text());
    h.click("reload");
    await waitPending(2, "R2 reload 조회");
    const qReload = last();
    check("R2 reload 는 커서 없이 첫 페이지", qReload.cursorOr === null && qReload.limit === 6, `${qReload.cursorOr} ${qReload.limit}`);
    settle(qReload, rows(6, 3000));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996|more=true|lm=false", "R2 reload 반영");
    check("R2 reload 직후 옛 더보기 잠금 해제(lm=false·버튼 활성)", h.text().endsWith("lm=false") && h.btn("more")?.disabled === false, h.text());
    // 옛 더보기(qMore)가 아직 pending 인 상태에서 새 세대 더보기가 즉시 나가야 한다(3차 ②).
    h.click("more");
    await waitPending(2, "R2 새 세대 더보기");
    const qMore2 = last();
    check("R2 옛 더보기 pending 중에도 새 세대 더보기 진행(커서 2996)", qMore2.cursorOr === cursorFilterOf(2996, 96), qMore2.cursorOr ?? "null");
    settle(qMore, rows(16, 995)); // 늦은 옛 더보기 응답 — 붙으면 오염, finally 가 새 잠금을 풀면 결함
    await sleep(30);
    check("R2 늦은 옛 더보기 응답이 붙지 않고 새 세대 잠금(lm=true) 유지", h.text() === "3000,2999,2998,2997,2996|more=true|lm=true" && h.btn("more")?.disabled === true, h.text());
    settle(qMore2, rows(2, 2995, 95));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996,2995,2994|more=false|lm=false", "R2 새 세대 더보기 반영");
    check("R2 새 세대 더보기 반영·소진", h.text() === "3000,2999,2998,2997,2996,2995,2994|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R3: 실패 → 재시도 ──
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
    check("R3 재시도가 같은 커서(996)로 나감", last().cursorOr === cursorFilterOf(996, 96), last().cursorOr ?? "null");
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

  // ── R4: 정확 소진 ──
  console.log("── R4 정확 소진");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R4 초기 조회");
    settle(last(), rows(5, 1000)); // 정확히 5건(확인행 없음)
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
    settle(last(), rows(15, 995)); // 정확히 15건(확인행 없음) = 총 20건
    await waitFor(() => h.text().includes("more=false"), "R4b 소진");
    check("R4 정확히 20건 → 더보기 직후 hasMore=false", h.text().endsWith("981|more=false|lm=false") && h.text().split("|")[0].split(",").length === 20, h.text());
    h.root.unmount();
  }

  // ── R5: 필터 전부 탈락 채우기 ──
  console.log("── R5 필터 전부 탈락 채우기");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R5 초기 조회");
    settle(last(), mixedRows(6, 1000, 100)); // 첫 묶음 6건 전부 탈락
    await waitPending(1, "R5 2번째 묶음");
    const q2 = last();
    // 확인행(995)은 소비하지 않았으므로 커서는 묶음의 마지막 소비 행(996) — 995 부터 다시 읽는다(누락 0).
    check("R5 전부 탈락 → 마지막 소비 행(996) 커서로 이어 읽음", q2.cursorOr === cursorFilterOf(996, 96) && q2.limit === 6, `${q2.cursorOr} ${q2.limit}`);
    settle(q2, [
      row(994, 94, { players: [LG_PLAYER] }),
      row(993, 93, { players: [DOOSAN_PLAYER] }),
      row(992, 92, { players: [LG_PLAYER] }),
      row(991, 91),
      row(990, 90),
      row(989, 89),
    ]);
    await waitPending(1, "R5 3번째 묶음");
    const q3 = last();
    check("R5 4개만 채워짐 → 부족 1건을 커서(990)·limit 2 로 이어 읽음", q3.cursorOr === cursorFilterOf(990, 90) && q3.limit === 2, `${q3.cursorOr} ${q3.limit}`);
    settle(q3, [row(989, 89), row(988, 88)]);
    await waitFor(() => !h.text().startsWith("L|"), "R5 반영");
    check("R5 보이는 글 5개 채움·확인행(988) 적합 → hasMore=true", h.text() === "994,992,991,990,989|more=true|lm=false", h.text());
    h.click("more");
    await waitPending(1, "R5 더보기");
    check("R5 다음 커서 = 마지막 소비 행(989)", last().cursorOr === cursorFilterOf(989, 89), last().cursorOr ?? "null");
    settle(last(), []);
    await waitFor(() => h.text().includes("more=false"), "R5 소진");
    h.root.unmount();
  }
  {
    // 3차 ①: 첫 20건(4묶음) 부적합 → 상한과 무관하게 21번째 적합 글까지 이어 읽는다. 0행·hasMore=true 금지.
    pending.length = 0;
    const h = mount({ board: LG });
    for (let b = 0; b < 4; b++) {
      await waitPending(1, `R5b 묶음 ${b + 1}`);
      settle(last(), mixedRows(6, 1000 - b * 5, 100 - b * 5));
    }
    await waitPending(1, "R5b 5번째 묶음(상한 초과 이어 읽기)");
    check("R5b 0행이면 상한 뒤에도 계속 읽음(5번째 조회, 커서 980)", last().cursorOr === cursorFilterOf(981, 81) && h.text().startsWith("L|"), `${last().cursorOr} ${h.text()}`);
    settle(last(), rows(6, 980, 80));
    await waitFor(() => !h.text().startsWith("L|"), "R5b 반영");
    check("R5b 21번째부터 적합 글 5개 렌더·hasMore=true", h.text() === "980,979,978,977,976|more=true|lm=false", h.text());
    h.root.unmount();
  }
  {
    // 1건 이상 채운 뒤에는 상한 적용 — 무한 조회 방지, hasMore 유지.
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R5c 초기 조회");
    settle(last(), [row(1000, 100), ...mixedRows(5, 999, 99)]);
    for (let b = 1; b < 4; b++) {
      await waitPending(1, `R5c 묶음 ${b + 1}`);
      settle(last(), mixedRows(5, 1000 - b * 4 - 1, 100 - b * 4 - 1));
    }
    await waitFor(() => !h.text().startsWith("L|"), "R5c 반영");
    await sleep(20);
    check("R5c 1건 채운 뒤 상한(4묶음)에서 멈춤·hasMore 유지·추가 조회 없음", h.text() === "1000|more=true|lm=false" && unsettled().length === 0, `${h.text()} pending=${unsettled().length}`);
    h.root.unmount();
  }

  // ── R6: 차단 채우기 ──
  console.log("── R6 차단 채우기");
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R6 초기 조회");
    settle(last(), [row(1000, 100, { author: "bad" }), row(999, 99), row(998, 98, { author: "bad" }), row(997, 97), row(996, 96), row(995, 95)]);
    await waitPending(1, "R6 2번째 묶음");
    check("R6 차단 2건 탈락 → 이어 읽음(커서 996, limit 3)", last().cursorOr === cursorFilterOf(996, 96) && last().limit === 3, `${last().cursorOr} ${last().limit}`);
    settle(last(), [row(995, 95), row(994, 94)]);
    await waitFor(() => !h.text().startsWith("L|"), "R6 반영");
    check("R6 차단 제외하고 5개 채움·소진", h.text() === "999,997,996,995,994|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    // 차단 목록이 늦게 도착: 첫 페이지 5건이 전부 차단 작성자 → 목록 도착 시 첫 페이지 재조회로 채운다.
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R6b 초기 조회");
    settle(last(), Array.from({ length: 6 }, (_, i) => row(1000 - i, 100 - i, { author: "bad" })));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R6b 초기 반영");
    h.rerender({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R6b 재조회");
    check("R6b 차단 목록 늦게 도착 → 첫 페이지 재조회", last().cursorOr === null, last().cursorOr ?? "null");
    settle(last(), Array.from({ length: 6 }, (_, i) => row(1000 - i, 100 - i, { author: "bad" })));
    await waitPending(1, "R6b 이어 읽기");
    settle(last(), [row(994, 94)]);
    await waitFor(() => !h.text().startsWith("L|"), "R6b 반영");
    check("R6b 차단 5건 전부 탈락해도 뒤의 정상 글로 채움", h.text() === "994|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R7: 5→20→35 + dedupe ──
  console.log("── R7 5→20→35 진행·dedupe");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R7 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R7 초기 반영");
    h.click("more");
    await waitPending(1, "R7 더보기");
    // 순위 이동으로 이미 보이는 998 이 재등장 → dedupe 후 15개를 채우려 이어 읽기 발생
    settle(last(), [row(998, 95.5 as unknown as number), ...rows(15, 995, 95)]);
    await waitPending(1, "R7 이어 읽기");
    check("R7 재등장 글 dedupe → 부족분 1건을 마지막 소비 행(982) 커서로 이어 읽음", last().cursorOr === cursorFilterOf(982, 82) && last().limit === 2, `${last().cursorOr} ${last().limit}`);
    settle(last(), [row(980, 80), row(979, 79)]);
    await waitFor(() => h.text().split("|")[0].split(",").length === 20, "R7 20개");
    const ids = h.text().split("|")[0].split(",").map(Number);
    check("R7 20개·중복 0·hasMore=true", ids.length === 20 && new Set(ids).size === 20 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 3페이지");
    check("R7 3페이지 커서 = 마지막 소비 행(980)", last().cursorOr === cursorFilterOf(980, 80), last().cursorOr ?? "null");
    settle(last(), rows(16, 979, 79)); // 979..964 (확인행 964)
    await waitFor(() => h.text().split("|")[0].split(",").length === 35, "R7 35개");
    check("R7 35개·hasMore=true", h.text().split("|")[0].split(",").length === 35 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 4페이지");
    settle(last(), rows(4, 964, 64));
    await waitFor(() => h.text().includes("more=false"), "R7 소진");
    check("R7 창 소진 → 39개·버튼 숨김", h.text().split("|")[0].split(",").length === 39 && h.text().includes("more=false") && h.btn("more") === null, h.text());
    h.root.unmount();
  }

  // ── R8: 확인행 노출 필터 ──
  console.log("── R8 확인행 노출 필터(3차 ③)");
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R8 초기 조회");
    settle(last(), [...rows(5, 1000), row(995, 95, { author: "bad" })]); // 적합 5 + 부적합 확인행
    await waitPending(1, "R8 확인 probe");
    const probe = last();
    check("R8 부적합 확인행 → 뒤를 더 읽어 확인(커서 995·limit 6)", probe.cursorOr === cursorFilterOf(995, 95) && probe.limit === 6, `${probe.cursorOr} ${probe.limit}`);
    settle(probe, [row(994, 94, { author: "bad" })]); // 뒤도 부적합 1건뿐 → 소진
    await waitFor(() => !h.text().startsWith("L|"), "R8 반영");
    check("R8 다음 적합 글 없음 → hasMore=false·버튼 없음", h.text() === "1000,999,998,997,996|more=false|lm=false" && h.btn("more") === null, h.text());
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R8b 초기 조회");
    settle(last(), [...rows(5, 1000), row(995, 95, { author: "bad" })]);
    await waitPending(1, "R8b 확인 probe");
    settle(last(), [row(994, 94, { author: "bad" }), row(993, 93)]); // 뒤에 적합 글 존재
    await waitFor(() => !h.text().startsWith("L|"), "R8b 반영");
    check("R8b 뒤에 적합 글 있음 → hasMore=true, 커서는 마지막 소비 행(996) 유지", h.text() === "1000,999,998,997,996|more=true|lm=false", h.text());
    h.click("more");
    await waitPending(1, "R8b 더보기");
    check("R8b 더보기 커서 996(부적합 995·994 재독 → 누락 0)", last().cursorOr === cursorFilterOf(996, 96), last().cursorOr ?? "null");
    settle(last(), [row(995, 95, { author: "bad" }), row(994, 94, { author: "bad" }), row(993, 93)]);
    await waitFor(() => h.text() === "1000,999,998,997,996,993|more=false|lm=false", "R8b 더보기 반영");
    check("R8b 993 이어 붙고 소진", h.text() === "1000,999,998,997,996,993|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ───────────────────────── 실제 섹션 DOM ─────────────────────────
  console.log("── D 실제 섹션(CommunityLatestPosts) DOM");
  // CommunityWriteFlow(글쓰기 모달)가 next/navigation useRouter 를 쓰므로 실제 앱처럼 app router 컨텍스트를 공급한다.
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
    check("D1 로딩 중 섹션 숨김", s.section() === null, String(s.section()?.outerHTML.length));
    settle(last(), rows(6, 1000));
    await waitFor(() => s.rowsOf() === 5, "D1 5행 렌더");
    check("D1 섹션 표시·5행·제목 '커뮤니티 인기글(LG)'", s.section() !== null && s.rowsOf() === 5 && (s.section()?.textContent ?? "").includes("커뮤니티 인기글(LG)"), s.section()?.textContent?.slice(0, 80));
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
    check("D2 버튼 클릭 → 더보기 조회(커서 996·limit 16)", last().cursorOr === cursorFilterOf(996, 96) && last().limit === 16, `${last().cursorOr} ${last().limit}`);
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
    for (let b = 0; b < 4; b++) {
      await waitPending(1, `D3 묶음 ${b + 1}`);
      settle(last(), mixedRows(6, 1000 - b * 5, 100 - b * 5));
    }
    await waitPending(1, "D3 5번째 묶음");
    check("D3 첫 20건 부적합 → 섹션 숨긴 채 21번째로 이어 읽음", s.section() === null && last().cursorOr === cursorFilterOf(981, 81), `${last().cursorOr}`);
    settle(last(), rows(6, 980, 80));
    await waitFor(() => s.rowsOf() === 5, "D3 5행");
    check("D3 21번째부터 5행 렌더·버튼 노출(섹션 소실 없음)", s.section() !== null && s.rowsOf() === 5 && s.moreBtn() !== undefined);
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
    await waitPending(2, "D4 refresh 조회");
    const qRefresh = last();
    check("D4 refreshNonce → 첫 페이지 재조회(커서 없음)", qRefresh.cursorOr === null && qRefresh.limit === 6, `${qRefresh.cursorOr}`);
    settle(qRefresh, rows(6, 3000));
    await waitFor(() => s.rowsOf() === 5 && s.container.querySelector("a[href*='3000']") !== null, "D4 새 첫 페이지");
    check("D4 새 첫 페이지 렌더·버튼 즉시 활성(옛 더보기 잠금 해제)", s.moreBtn()?.disabled === false);
    settle(oldMore, rows(16, 995));
    await sleep(30);
    check("D4 늦은 옛 더보기 응답 무시(5행 유지·버튼 활성)", s.rowsOf() === 5 && s.moreBtn()?.disabled === false, String(s.rowsOf()));
    s.root.unmount();
  }

  console.log(`\n${fail ? "❌" : "✅"} home-popular-feed-hook-smoke — pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("❌ home-popular-feed-hook-smoke ABORT:", e instanceof Error ? e.message : e);
  process.exit(1);
});
