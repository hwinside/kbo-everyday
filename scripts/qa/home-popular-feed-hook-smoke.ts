/**
 * useHomePopularFeed 훅 + 홈 섹션(CommunityLatestPosts) 회귀 smoke (삼순 #1343 2·3·4차 재리뷰 고정, 설계 A)
 * — 실제 React(jsdom) mount + 주입 supabase 목. 모든 대기(waitFor)는 시한 초과 시 즉시 FAIL(throw).
 *
 * 설계 A(하린아빠 2026-09-05 15:16): 페이지당 서버 조회 1회, 정확히 5/15개, 정확 소진. 노출 조건은 전부 서버 필터.
 *
 * [훅 코어: useHomePopularFeedCore 에 차단 목록 주입]
 * R1) 응답 역전(팀 전환): A 조회 pending 중 B 로 전환 → B 응답 → 늦은 A 응답 도착.
 *     화면·커서·hasMore 모두 B 기준이어야 하고, A 행이 섞이거나 A 커서로 더보기가 나가면 FAIL.
 *     서버 필터: team_tags eq [팀] + player_tags cd 로스터(LG 값엔 오지환, 두산 값엔 강승호·오지환 없음).
 * R2) 응답 역전(reload): 더보기 pending 중 reload → reload 응답 → 늦은 더보기 응답 도착.
 *     첫 페이지만 보여야 하고 옛 더보기 행이 뒤에 붙으면 FAIL. reload 직후 옛 더보기 잠금이 풀려 새 세대 더보기가
 *     즉시 나가야 하고, 옛 요청 완료가 새 세대 잠금을 건드리면 FAIL(3차 ②).
 * R3) 실패→재시도: 더보기 조회 오류 → posts/cursor/hasMore 보존(버튼 유지) → 재클릭 시 같은 커서로 재조회 성공.
 * R4) 정확 소진: 창 안 글이 정확히 5건 → 초기 조회 직후 hasMore=false. 정확히 20건 → 더보기 후 false.
 * R5) 서버 필터·정확 채움: 차단 목록은 author_id not.in 으로, 더보기는 화면 id 를 id not.in 으로 서버에 넘기고,
 *     서버가 돌려준 행은 걸러내지 않고 그대로 정확히 want 개 표시(추가 조회 0). 차단 목록이 늦게 도착하면 첫 페이지 재조회.
 * R7) 5→20→35 진행 + 제외 목록(seen) 누적 + 창 소진 시 버튼 숨김.
 *
 * [실제 섹션 DOM: CommunityLatestPosts(myTeamId=LG) — 실제 useHomePopularFeed·버튼 게이트·disabled]
 * D1) 로딩 중 섹션 숨김 → 5행 렌더 + '15개 더 보기' 버튼(hasMore) 노출. 정확 5건이면 버튼 없음.
 *     실제 조회에 LG 단독 서버 필터(team eq + 로스터 cd) 가 실린다.
 * D2) 버튼 클릭 → 더보기 조회(id not.in 화면 5개) → 응답 중 disabled/aria-busy → 15행 추가 → 소진 시 버튼 제거.
 * D3) 첫 조회 오류 → 섹션 숨김(빈 박스 없음) → refreshNonce 로 복구.
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
  playerCd: string[] | null;
  notIn: Record<string, string>;
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
    let playerCd: string[] | null = null;
    let cursorOr: string | null = null;
    const notIn: Record<string, string> = {};
    const query = {
      select: () => query,
      neq: () => query,
      gte: () => query,
      in: () => query,
      eq: () => query,
      filter: (col: string, op: string, value: string) => {
        if (col === "team_tags" && op === "eq") team = value;
        if (col === "player_tags" && op === "cd") playerCd = JSON.parse(value) as string[];
        return query;
      },
      not: (col: string, op: string, value: string) => {
        if (op === "in") notIn[col] = value;
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
            playerCd,
            notIn,
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

  // ── R1: 팀 전환 응답 역전 + 서버 필터 ──
  console.log("── R1 팀 전환 응답 역전·서버 필터");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R1 초기 조회");
    const qA = last();
    check("R1 초기 조회가 LG 단독 필터·limit 6(5+확인행)", qA.team === '["lg"]' && qA.limit === 6, `team=${qA.team} limit=${qA.limit}`);
    check("R1 LG 로스터 cd 필터(오지환 포함·강승호 제외·50명 이상)", (qA.playerCd?.length ?? 0) > 50 && qA.playerCd!.includes(LG_PLAYER) && !qA.playerCd!.includes(DOOSAN_PLAYER), `cd=${qA.playerCd?.length}`);
    check("R1 차단 없음·첫 페이지 → not.in 없음", Object.keys(qA.notIn).length === 0, JSON.stringify(qA.notIn));
    h.rerender({ board: DOOSAN });
    await waitPending(2, "R1 팀 전환 조회");
    const qB = last();
    check("R1 전환 직후 loading 표시", h.text().startsWith("L|"), h.text());
    check("R1 두산 전환 → team eq [doosan]·로스터 cd 강승호 포함·오지환 제외", qB.team === '["doosan"]' && qB.playerCd!.includes(DOOSAN_PLAYER) && !qB.playerCd!.includes(LG_PLAYER), `team=${qB.team}`);
    settle(qB, rows(6, 2000, 100, ["doosan"])); // B: 2000..1995 (확인행 1995)
    await waitFor(() => h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", "R1 B 응답 반영");
    check("R1 B 응답 반영(5개, 확인행 제외, hasMore=true)", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    settle(qA, rows(3, 1000)); // 늦은 A 응답: 3건(소진) — 반영되면 화면/hasMore 가 오염된다
    await sleep(30);
    check("R1 늦은 A 응답이 화면·hasMore 를 덮지 않음", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    h.click("more");
    await waitPending(1, "R1 더보기");
    const qMore = last();
    check("R1 더보기 커서가 B 의 마지막 행(1996)·두산 필터", qMore.cursorOr === cursorFilterOf(1996, 96) && qMore.team === '["doosan"]', `${qMore.cursorOr} team=${qMore.team}`);
    check("R1 더보기가 화면 id 5개를 서버 제외 목록으로 넘김", qMore.notIn.id === "(2000,1999,1998,1997,1996)", qMore.notIn.id);
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
    check("R2 reload 는 커서·제외 목록 없이 첫 페이지", qReload.cursorOr === null && qReload.limit === 6 && !qReload.notIn.id, `${qReload.cursorOr} ${qReload.limit}`);
    settle(qReload, rows(6, 3000));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996|more=true|lm=false", "R2 reload 반영");
    check("R2 reload 직후 옛 더보기 잠금 해제(lm=false·버튼 활성)", h.text().endsWith("lm=false") && h.btn("more")?.disabled === false, h.text());
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

  // ── R5: 서버 필터·정확 채움(클라이언트 드롭 0) ──
  console.log("── R5 서버 필터·정확 채움");
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad-1", "bad-2"] });
    await waitPending(1, "R5 초기 조회");
    check("R5 차단 목록이 author_id not.in 으로 서버에 실림", last().notIn.author_id === '("bad-1","bad-2")', last().notIn.author_id);
    // 서버가 돌려준 6행은 그대로 신뢰 — 클라이언트에서 더 걸러내지 않고 정확히 5개 표시, 추가 조회 0.
    settle(last(), rows(6, 1000));
    await waitFor(() => !h.text().startsWith("L|"), "R5 반영");
    await sleep(20);
    check("R5 서버 결과 그대로 정확 5개·추가 조회 0", h.text() === "1000,999,998,997,996|more=true|lm=false" && unsettled().length === 0, `${h.text()} pending=${unsettled().length}`);
    h.click("more");
    await waitPending(1, "R5 더보기");
    check("R5 더보기: 차단 not.in + 화면 id not.in 동시 전송", last().notIn.author_id === '("bad-1","bad-2")' && last().notIn.id === "(1000,999,998,997,996)", JSON.stringify(last().notIn));
    settle(last(), rows(3, 995));
    await waitFor(() => h.text().includes("more=false"), "R5 소진");
    h.root.unmount();
  }
  {
    // 차단 목록이 늦게 도착(로그인 직후): 서버 필터가 바뀌므로 첫 페이지를 다시 읽는다.
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R5b 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R5b 초기 반영");
    h.rerender({ board: LG, blocked: ["bad"] });
    await waitPending(1, "R5b 재조회");
    check("R5b 차단 목록 늦게 도착 → 첫 페이지 재조회(커서 없음·not.in bad)", last().cursorOr === null && last().notIn.author_id === '("bad")', `${last().cursorOr} ${last().notIn.author_id}`);
    settle(last(), [row(999, 99), row(997, 97)]);
    await waitFor(() => h.text() === "999,997|more=false|lm=false", "R5b 반영");
    check("R5b 재조회 결과로 교체·소진", h.text() === "999,997|more=false|lm=false", h.text());
    h.rerender({ board: LG, blocked: ["bad"] });
    await sleep(30);
    check("R5b 같은 차단 목록 재렌더는 재조회 없음", unsettled().length === 0, String(unsettled().length));
    h.root.unmount();
  }

  // ── R7: 5→20→35 + seen 누적 ──
  console.log("── R7 5→20→35 진행·제외 목록 누적");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitPending(1, "R7 초기 조회");
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false", "R7 초기 반영");
    h.click("more");
    await waitPending(1, "R7 더보기");
    check("R7 2페이지 제외 목록 = 화면 5개", last().notIn.id === "(1000,999,998,997,996)", last().notIn.id);
    settle(last(), rows(16, 995, 95)); // 995..980 (확인행 980)
    await waitFor(() => h.text().split("|")[0].split(",").length === 20, "R7 20개");
    const ids = h.text().split("|")[0].split(",").map(Number);
    check("R7 20개·중복 0·hasMore=true", ids.length === 20 && new Set(ids).size === 20 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 3페이지");
    check("R7 3페이지 커서 = 마지막 행(981)·제외 목록 20개", last().cursorOr === cursorFilterOf(981, 81) && last().notIn.id.split(",").length === 20, `${last().cursorOr} ${last().notIn.id}`);
    settle(last(), rows(16, 980, 80)); // 980..965 (확인행 965)
    await waitFor(() => h.text().split("|")[0].split(",").length === 35, "R7 35개");
    check("R7 35개·hasMore=true", h.text().split("|")[0].split(",").length === 35 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitPending(1, "R7 4페이지");
    settle(last(), rows(4, 965, 65));
    await waitFor(() => h.text().includes("more=false"), "R7 소진");
    check("R7 창 소진 → 39개·버튼 숨김", h.text().split("|")[0].split(",").length === 39 && h.text().includes("more=false") && h.btn("more") === null, h.text());
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
    check("D1 실제 조회에 LG 단독 서버 필터(team eq + 로스터 cd)·limit 6", last().team === '["lg"]' && (last().playerCd?.includes(LG_PLAYER) ?? false) && last().limit === 6, `team=${last().team} cd=${last().playerCd?.length} limit=${last().limit}`);
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
    check("D2 버튼 클릭 → 더보기 조회(커서 996·limit 16·화면 id not.in)", last().cursorOr === cursorFilterOf(996, 96) && last().limit === 16 && last().notIn.id === "(1000,999,998,997,996)", `${last().cursorOr} ${last().limit} ${last().notIn.id}`);
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
    check("D3 첫 조회 오류 → 섹션 숨김(빈 박스 없음)·추가 조회 없음", s.section() === null && unsettled().length === 0, String(unsettled().length));
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
