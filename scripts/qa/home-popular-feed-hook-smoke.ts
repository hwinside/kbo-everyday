/**
 * useHomePopularFeed 훅 회귀 smoke (삼순 #1343 재리뷰 3건 고정) — 실제 React(jsdom) mount + 주입 supabase 목.
 *
 * R1) 응답 역전(팀 전환): A 조회 pending 중 B 로 전환 → B 응답 → 늦은 A 응답 도착.
 *     화면·커서·hasMore 모두 B 기준이어야 하고, A 행이 섞이거나 A 커서로 더보기가 나가면 FAIL.
 * R2) 응답 역전(reload): 더보기 pending 중 reload → reload 응답 → 늦은 더보기 응답 도착.
 *     첫 페이지만 보여야 하고 옛 더보기 행이 뒤에 붙으면 FAIL.
 * R3) 실패→재시도: 더보기 조회 오류 → posts/cursor/hasMore 보존(버튼 유지) → 재클릭 시 같은 커서로 재조회 성공.
 * R4) 정확 소진: 창 안 글이 정확히 5건 → 초기 조회 직후 hasMore=false(버튼 즉시 숨김). 정확히 20건 → 더보기 후 false.
 * R5) 필터 전부 탈락 채우기: 첫 묶음 5건이 전부 타팀 선수 태그(배지 2팀) → 뒤 묶음을 이어 읽어 보이는 글 5개를 채운다.
 * R6) 차단 채우기: 차단 작성자 글이 섞이면 건너뛰고 채운다. 차단 목록이 늦게 도착하면 첫 페이지를 다시 채운다.
 * R7) 5→20→35 진행 + 순위 이동 재등장 글 dedupe + 창 소진 시 버튼 숨김.
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
async function waitFor(condition: () => boolean, timeoutMs = 1_500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
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

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { supabase } = await import("../../src/lib/supabase/client");
  const { useHomePopularFeedCore } = await import("../../src/lib/supabase/useHomePopularFeed");
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
        new Promise<{ data: Row[]; error: null } | { data: null; error: { message: string } }>((resolve, reject) => {
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
          void reject;
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
  const cursorFilterOf = (id: number, popularity: number) => `popularity.lt.${popularity},and(popularity.eq.${popularity},id.lt.${id})`;

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
      React.createElement("button", { id: "more", onClick: () => void loadMore() }, "more"),
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
    const click = (id: string) => (container.querySelector(`#${id}`) as HTMLButtonElement).click();
    return { root, container, text, click, rerender: (p: HostProps) => root.render(React.createElement(Host, p)) };
  }

  // ── R1: 팀 전환 응답 역전 ──
  console.log("── R1 팀 전환 응답 역전");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    const qA = last();
    check("R1 초기 조회가 LG 단독 필터·limit 6(5+확인행)", qA.team === '["lg"]' && qA.limit === 6, `team=${qA.team} limit=${qA.limit}`);
    h.rerender({ board: DOOSAN });
    await waitFor(() => unsettled().length === 2);
    const qB = last();
    check("R1 전환 직후 loading 표시", h.text().startsWith("L|"), h.text());
    settle(qB, rows(6, 2000, 100, ["doosan"])); // B: 2000..1995 (확인행 1995), 두산 단독 글
    await waitFor(() => h.text() === "2000,1999,1998,1997,1996|more=true|lm=false");
    check("R1 B 응답 반영(5개, 확인행 제외, hasMore=true)", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    settle(qA, rows(3, 1000)); // 늦은 A 응답: 3건(소진) — 반영되면 화면/hasMore 가 오염된다
    await sleep(30);
    check("R1 늦은 A 응답이 화면·hasMore 를 덮지 않음", h.text() === "2000,1999,1998,1997,1996|more=true|lm=false", h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    const qMore = last();
    check("R1 더보기 커서가 B 의 마지막 소비 행(1996)", qMore.cursorOr === cursorFilterOf(1996, 96) && qMore.team === '["doosan"]', `${qMore.cursorOr} team=${qMore.team}`);
    settle(qMore, []);
    await waitFor(() => h.text().includes("more=false"));
    check("R1 더보기 빈 응답 → 소진", h.text() === "2000,1999,1998,1997,1996|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R2: reload 응답 역전 ──
  console.log("── R2 reload 응답 역전");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false");
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    const qMore = last();
    check("R2 더보기 limit 16(15+확인행)·커서 996", qMore.limit === 16 && qMore.cursorOr === cursorFilterOf(996, 96), `${qMore.limit} ${qMore.cursorOr}`);
    h.click("reload");
    await waitFor(() => unsettled().length === 2);
    const qReload = last();
    check("R2 reload 는 커서 없이 첫 페이지", qReload.cursorOr === null && qReload.limit === 6, `${qReload.cursorOr} ${qReload.limit}`);
    settle(qReload, rows(6, 3000));
    await waitFor(() => h.text() === "3000,2999,2998,2997,2996|more=true|lm=false");
    settle(qMore, rows(16, 995)); // 늦은 더보기 응답 — 붙으면 옛 목록 오염
    await sleep(30);
    check("R2 늦은 더보기 응답이 새 첫 페이지 뒤에 붙지 않음", h.text() === "3000,2999,2998,2997,2996|more=true|lm=false", h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    check("R2 다음 더보기 커서는 reload 결과(2996)", last().cursorOr === cursorFilterOf(2996, 96), last().cursorOr ?? "null");
    settle(last(), []);
    h.root.unmount();
  }

  // ── R3: 실패 → 재시도 ──
  console.log("── R3 실패→재시도");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false");
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    failQ(last());
    await waitFor(() => h.text().includes("lm=false") && unsettled().length === 0);
    check("R3 조회 오류 후 posts/hasMore 보존(버튼 유지)", h.text() === "1000,999,998,997,996|more=true|lm=false", h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    check("R3 재시도가 같은 커서(996)로 나감", last().cursorOr === cursorFilterOf(996, 96), last().cursorOr ?? "null");
    settle(last(), rows(3, 995));
    await waitFor(() => h.text().includes("more=false"));
    check("R3 재시도 성공 → 이어 붙고 소진", h.text() === "1000,999,998,997,996,995,994,993|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R3b: 첫 조회 실패 → reload 로 복구 ──
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    failQ(last());
    await waitFor(() => !h.text().startsWith("L|"));
    check("R3b 첫 조회 실패 → 빈 목록(섹션 숨김)·loading 해제", h.text() === "|more=true|lm=false", h.text());
    h.click("reload");
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(2, 500));
    await waitFor(() => h.text() === "500,499|more=false|lm=false");
    check("R3b reload 로 복구", h.text() === "500,499|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R4: 정확 소진 ──
  console.log("── R4 정확 소진");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(5, 1000)); // 정확히 5건(확인행 없음)
    await waitFor(() => !h.text().startsWith("L|"));
    check("R4 정확히 5건 → 초기 조회 직후 hasMore=false", h.text() === "1000,999,998,997,996|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false");
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(15, 995)); // 정확히 15건(확인행 없음) = 총 20건
    await waitFor(() => h.text().includes("more=false"));
    check("R4 정확히 20건 → 더보기 직후 hasMore=false", h.text().endsWith("981|more=false|lm=false") && h.text().split("|")[0].split(",").length === 20, h.text());
    h.root.unmount();
  }

  // ── R5: 필터 전부 탈락 채우기 ──
  console.log("── R5 필터 전부 탈락 채우기");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    // 첫 묶음 6건 전부 [lg]+두산 선수 태그(배지 2팀) → 전부 탈락
    const mixed = Array.from({ length: 6 }, (_, i) => row(1000 - i, 100 - i, { players: [DOOSAN_PLAYER] }));
    settle(last(), mixed);
    await waitFor(() => unsettled().length === 1);
    const q2 = last();
    // 확인행(995)은 소비하지 않았으므로 커서는 묶음의 마지막 소비 행(996) — 995 부터 다시 읽는다(누락 0).
    check("R5 전부 탈락 → 마지막 소비 행(996) 커서로 이어 읽음", q2.cursorOr === cursorFilterOf(996, 96) && q2.limit === 6, `${q2.cursorOr} ${q2.limit}`);
    // 두 번째 묶음: LG 선수 태그 2건 + 탈락 1건 + 단독 2건 + 확인행 → 4개만 채워져 1건을 더 읽는다
    settle(q2, [
      row(994, 94, { players: [LG_PLAYER] }),
      row(993, 93, { players: [DOOSAN_PLAYER] }),
      row(992, 92, { players: [LG_PLAYER] }),
      row(991, 91),
      row(990, 90),
      row(989, 89),
    ]);
    await waitFor(() => unsettled().length === 1);
    const q3 = last();
    check("R5 4개만 채워짐 → 부족 1건을 커서(990)·limit 2 로 이어 읽음", q3.cursorOr === cursorFilterOf(990, 90) && q3.limit === 2, `${q3.cursorOr} ${q3.limit}`);
    settle(q3, [row(989, 89), row(988, 88)]);
    await waitFor(() => !h.text().startsWith("L|"));
    check("R5 보이는 글 5개 채움·확인행(988) 남아 hasMore=true", h.text() === "994,992,991,990,989|more=true|lm=false", h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    check("R5 다음 커서 = 마지막 소비 행(989)", last().cursorOr === cursorFilterOf(989, 89), last().cursorOr ?? "null");
    settle(last(), []);
    await waitFor(() => h.text().includes("more=false"));
    h.root.unmount();
  }
  {
    // 상한: 전부 탈락 묶음이 MAX_FILL_BATCHES 회 이어지면 멈추되 hasMore=true 로 남긴다(무한 조회 금지).
    pending.length = 0;
    const h = mount({ board: LG });
    for (let b = 0; b < 4; b++) {
      await waitFor(() => unsettled().length === 1);
      settle(last(), Array.from({ length: 6 }, (_, i) => row(1000 - b * 6 - i, 100 - b * 6 - i, { players: [DOOSAN_PLAYER] })));
      await sleep(10);
    }
    await waitFor(() => !h.text().startsWith("L|"));
    check("R5 채우기 상한(4회) 후 멈춤·hasMore 유지·추가 조회 없음", h.text() === "|more=true|lm=false" && unsettled().length === 0, `${h.text()} pending=${unsettled().length}`);
    h.root.unmount();
  }

  // ── R6: 차단 채우기 ──
  console.log("── R6 차단 채우기");
  {
    pending.length = 0;
    const h = mount({ board: LG, blocked: ["bad"] });
    await waitFor(() => unsettled().length === 1);
    settle(last(), [row(1000, 100, { author: "bad" }), row(999, 99), row(998, 98, { author: "bad" }), row(997, 97), row(996, 96), row(995, 95)]);
    await waitFor(() => unsettled().length === 1);
    check("R6 차단 2건 탈락 → 이어 읽음(커서 996, limit 3)", last().cursorOr === cursorFilterOf(996, 96) && last().limit === 3, `${last().cursorOr} ${last().limit}`);
    settle(last(), [row(995, 95), row(994, 94)]);
    await waitFor(() => !h.text().startsWith("L|"));
    check("R6 차단 제외하고 5개 채움·소진", h.text() === "999,997,996,995,994|more=false|lm=false", h.text());
    h.root.unmount();
  }
  {
    // 차단 목록이 늦게 도착: 첫 페이지 5건이 전부 차단 작성자 → 목록 도착 시 첫 페이지 재조회로 채운다.
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), Array.from({ length: 6 }, (_, i) => row(1000 - i, 100 - i, { author: "bad" })));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false");
    h.rerender({ board: LG, blocked: ["bad"] });
    await waitFor(() => unsettled().length === 1);
    check("R6 차단 목록 늦게 도착 → 첫 페이지 재조회", last().cursorOr === null, last().cursorOr ?? "null");
    settle(last(), Array.from({ length: 6 }, (_, i) => row(1000 - i, 100 - i, { author: "bad" })));
    await waitFor(() => unsettled().length === 1);
    settle(last(), [row(994, 94)]);
    await waitFor(() => !h.text().startsWith("L|"));
    check("R6 차단 5건 전부 탈락해도 뒤의 정상 글로 채움", h.text() === "994|more=false|lm=false", h.text());
    h.root.unmount();
  }

  // ── R7: 5→20→35 + dedupe ──
  console.log("── R7 5→20→35 진행·dedupe");
  {
    pending.length = 0;
    const h = mount({ board: LG });
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(6, 1000));
    await waitFor(() => h.text() === "1000,999,998,997,996|more=true|lm=false");
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    // 순위 이동으로 이미 보이는 998 이 재등장 → dedupe 후 15개를 채우려 확인행까지 소비, 이어 읽기 발생
    const second = [row(998, 95.5 as unknown as number), ...rows(15, 995, 95)];
    settle(last(), second);
    await waitFor(() => unsettled().length === 1);
    check("R7 재등장 글 dedupe → 부족분 1건을 마지막 소비 행(982) 커서로 이어 읽음", last().cursorOr === cursorFilterOf(982, 82) && last().limit === 2, `${last().cursorOr} ${last().limit}`);
    settle(last(), [row(980, 80), row(979, 79)]);
    await waitFor(() => h.text().split("|")[0].split(",").length === 20);
    const ids = h.text().split("|")[0].split(",").map(Number);
    check("R7 20개·중복 0·hasMore=true", ids.length === 20 && new Set(ids).size === 20 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    check("R7 3페이지 커서 = 마지막 소비 행(980)", last().cursorOr === cursorFilterOf(980, 80), last().cursorOr ?? "null");
    settle(last(), rows(16, 979, 79)); // 979..964 (확인행 964)
    await waitFor(() => h.text().split("|")[0].split(",").length === 35);
    check("R7 35개·hasMore=true", h.text().split("|")[0].split(",").length === 35 && h.text().includes("more=true"), h.text());
    h.click("more");
    await waitFor(() => unsettled().length === 1);
    settle(last(), rows(4, 964, 64));
    await waitFor(() => h.text().includes("more=false"));
    check("R7 창 소진 → 39개·버튼 숨김", h.text().split("|")[0].split(",").length === 39 && h.text().includes("more=false"), h.text());
    h.root.unmount();
  }

  console.log(`\n${fail ? "❌" : "✅"} home-popular-feed-hook-smoke — pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
