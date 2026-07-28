/**
 * 커뮤니티 투표 목록 카드 실행형 회귀 (spec §6, S3).
 *
 * 삼순 2차 재리뷰 P1 반영:
 *   1) 무한피드 누적 id ↔ summaries 100개 상한 충돌 — chunkSummaryIds 로 101개+ 전량 커버.
 *   2) 마감 배지 경계 전환 — pollBoundaryTimer / isPollEffectiveClosed 순수 함수 회귀.
 *
 * 삼순 3차 재리뷰 (durable regression) 반영 — 순수 함수 계약만으로는 실배선을
 * 못 거른다는 지적을 받아 실제 배선 3층을 추가로 잡는다:
 *   3) fetch mock — fetchPollSummaries(250개) → 3요청(100/100/50) POST + 250 merge 고정.
 *   4) 4목록(전체글/팀/선수=PhotoFeed, 자유=PostList→PostCard) poll→summary→PollCardBody
 *      연결 source guard (배선 끊김 방지).
 *   5) 렌더된 배지(마감/진행중)가 isPollEffectiveClosed 결과와 일치하는지 —
 *      react-dom/server 로 실제 마크업을 렌더해 배지 텍스트 연결을 고정.
 */
import "./_smoke-env"; // supabase client 싱글톤(poll-client 트랜지티브 로드)이 env 요구 → 더미 선주입
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  chunkSummaryIds,
  SUMMARIES_CHUNK,
  fetchPollSummaries,
  type PollSummary,
} from "../../src/lib/community/poll-client";
import PollCardBody, {
  isPollEffectiveClosed,
  pollBoundaryTimer,
} from "../../src/components/community/PollCardBody";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
function readSrc(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), "utf8");
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// ---------- 1) chunkSummaryIds: 무한피드 100개 상한 커버 ----------
{
  const ids0 = chunkSummaryIds([]);
  ok("빈 입력 → chunk 0개", ids0.length === 0);

  const ids50 = chunkSummaryIds(Array.from({ length: 50 }, (_, i) => i + 1));
  ok("50개 → 단일 chunk", ids50.length === 1 && ids50[0].length === 50);

  const ids100 = chunkSummaryIds(Array.from({ length: 100 }, (_, i) => i + 1));
  ok("100개 경계 → 단일 chunk", ids100.length === 1 && ids100[0].length === 100);

  const src101 = Array.from({ length: 101 }, (_, i) => i + 1);
  const ids101 = chunkSummaryIds(src101);
  ok("101개 → 2 chunk(100+1)", ids101.length === 2 && ids101[0].length === 100 && ids101[1].length === 1);
  const flat101 = ids101.flat();
  ok("101개 전량 커버(101번째 포함)", flat101.length === 101 && flat101.includes(101));

  const src250 = Array.from({ length: 250 }, (_, i) => i + 1);
  const ids250 = chunkSummaryIds(src250);
  ok("250개 → 3 chunk(100/100/50)", ids250.length === 3 && ids250.every((c) => c.length <= SUMMARIES_CHUNK));
  ok("250개 각 chunk ≤100", ids250.flat().length === 250);

  // 중복·비유효 제거
  const dedup = chunkSummaryIds([1, 1, 2, -3, 0, NaN as unknown as number, 4]);
  ok("중복·비유효 제거 후 chunk", JSON.stringify(dedup) === JSON.stringify([[1, 2, 4]]));
}

// ---------- 2) 마감 경계: isPollEffectiveClosed / pollBoundaryTimer ----------
{
  const now = Date.parse("2026-07-28T12:00:00Z");
  const future = new Date(now + 3600_000).toISOString(); // +1h
  const past = new Date(now - 1000).toISOString(); // 이미 지남
  const far = new Date(now + 10 * 86400_000).toISOString(); // +10일

  ok("server closed=true → effectiveClosed", isPollEffectiveClosed({ closed: true, closesAt: future }, now));
  ok("진행중(미래 마감) → not closed", !isPollEffectiveClosed({ closed: false, closesAt: future }, now));
  ok("경계 도달(과거 마감) → effectiveClosed", isPollEffectiveClosed({ closed: false, closesAt: past }, now));

  ok("closed poll timer → kind closed", pollBoundaryTimer({ closed: true, closesAt: future }, now).kind === "closed");
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: past }, now);
    ok("이미 마감 → fire(ms 0)", t.kind === "fire" && t.ms === 0);
  }
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: future }, now);
    ok("1h 뒤 마감 → fire(경계+250ms)", t.kind === "fire" && t.ms === 3600_000 + 250);
  }
  {
    const t = pollBoundaryTimer({ closed: false, closesAt: far }, now);
    ok("10일 뒤 마감 → hop(6h 재예약, setTimeout 상한 회피)", t.kind === "hop" && t.ms === 6 * 60 * 60 * 1000);
  }
}

// ---------- 3) fetch mock: fetchPollSummaries 배치 chunking → 3요청 + merge 실배선 ----------
// 순수 chunkSummaryIds 만으로는 실제 fetch 배선(청크별 POST + 응답 merge)을 못 거른다는
// 삼순 지적 반영 — client fetchPollSummaries 를 실제로 구동해 요청 수·chunk 크기·merge를 고정.
async function fetchMockSection() {
  const origFetch = globalThis.fetch;
  type Call = { url: string; postIds: number[] };
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = JSON.parse(init?.body ?? "{}") as { postIds: number[] };
    calls.push({ url, postIds: body.postIds });
    // 서버 계약대로 각 chunk 의 postId 만 summary 로 반환(hidden/비-poll 은 서버가 제외하지만 여기선 전량 반환).
    const summaries: Record<number, PollSummary> = {};
    for (const id of body.postIds) {
      summaries[id] = {
        postId: id,
        closesAt: new Date(Date.now() + 3600_000).toISOString(),
        closed: false,
        voterCount: id,
        optionCount: 2,
        options: [],
      };
    }
    return { ok: true, json: async () => ({ summaries }) } as Response;
  }) as typeof fetch;

  try {
    const src250 = Array.from({ length: 250 }, (_, i) => i + 1);
    const merged = await fetchPollSummaries(src250);
    ok("250개 → fetch 3회 호출(100/100/50)", calls.length === 3);
    ok(
      "각 청크 크기 100/100/50",
      calls[0]?.postIds.length === 100 &&
        calls[1]?.postIds.length === 100 &&
        calls[2]?.postIds.length === 50,
    );
    ok("모든 요청이 /api/polls/summaries POST", calls.every((c) => c.url.includes("/api/polls/summaries")));
    ok("merge 결과 250개 전량", Object.keys(merged).length === 250);
    ok("101번째·250번째 카드까지 누락 없음", !!merged[101] && !!merged[250] && merged[250].voterCount === 250);

    // 개별 chunk 가 !ok 로 재시도까지 실패하면 {} 로 merge — 나머지 카드 살림(영구 로딩 방지).
    calls.length = 0;
    const okAttempts: number[] = [];
    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { postIds: number[] };
      const first = body.postIds[0];
      okAttempts.push(first);
      // 2번째 chunk(id 101부터)는 재시도 포함 항상 !ok.
      if (first === 101) return { ok: false, json: async () => ({}) } as Response;
      const summaries: Record<number, PollSummary> = {};
      for (const id of body.postIds)
        summaries[id] = { postId: id, closesAt: "", closed: true, voterCount: 0, optionCount: 0, options: [] };
      return { ok: true, json: async () => ({ summaries }) } as Response;
    }) as typeof fetch;
    const partial = await fetchPollSummaries(Array.from({ length: 150 }, (_, i) => i + 1));
    ok("1개 chunk !ok(재시도까지) 제외, 나머지 merge(1..100 살아있음)", !!partial[1] && !!partial[100] && !partial[101]);
    ok("!ok chunk 도 bounded 재시도(101 두 번), 정상 chunk 는 1회", okAttempts.filter((f) => f === 101).length === 2 && okAttempts.filter((f) => f === 1).length === 1);

    // 삼순 4차 P1 — chunk 1개가 네트워크 throw 해도 Promise.all 전체 reject 안 되고 나머지 카드 살림.
    // (이전 구현은 throw 가 전체 batch 를 reject 해 모든 카드가 영구 로딩이었음.)
    calls.length = 0;
    const attempts: number[] = []; // chunk별 시도 횟수(2번째 chunk 는 throw로 1회 재시도 = 2)
    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { postIds: number[] };
      const first = body.postIds[0];
      attempts.push(first);
      // 두 번째 chunk(id 101부터)는 항상 throw → bounded 재시도(1)도 throw → 빈 결과.
      if (first === 101) throw new TypeError("simulated network failure");
      const summaries: Record<number, PollSummary> = {};
      for (const id of body.postIds)
        summaries[id] = { postId: id, closesAt: "", closed: true, voterCount: id, optionCount: 0, options: [] };
      return { ok: true, json: async () => ({ summaries }) } as Response;
    }) as typeof fetch;
    let threw = false;
    let throwPartial: Record<number, PollSummary> = {};
    try {
      throwPartial = await fetchPollSummaries(Array.from({ length: 250 }, (_, i) => i + 1));
    } catch {
      threw = true;
    }
    ok("chunk throw 가 전체 reject 로 전파되지 않음(never rejects)", !threw);
    ok("throw 한 chunk(101~200) 제외, 나머지 chunk(1~100·201~250) merge", !!throwPartial[1] && !!throwPartial[100] && !throwPartial[101] && !!throwPartial[201] && !!throwPartial[250]);
    ok("실패 chunk 는 bounded 재시도(101 두 번 시도), 정상 chunk 는 1회", attempts.filter((f) => f === 101).length === 2 && attempts.filter((f) => f === 1).length === 1);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---------- 4) 실제 4페이지 query→renderer 배선 guard (삼순 4차 P1) ----------
// 이전 가드는 공용 컴포넌트만 읽어 선수 페이지가 poll 을 차단해도 PASS 됐다.
// 자유·전체글·팀·선수 실제 page 의 query→posts→renderer 연결을 직접 읽어 끊기면 실패하게 한다.
{
  // — 공통 컴포넌트 배선 (poll → summary → PollCardBody) —
  const postList = readSrc("components/community/PostList.tsx");
  ok("PostList: fetchPollSummaries import", /import\s*\{[^}]*fetchPollSummaries/.test(postList));
  ok("PostList: fetchPollSummaries(pollIds) 호출", postList.includes("fetchPollSummaries(pollIds)"));
  ok(
    "PostList: poll 글에만 pollSummary 전달",
    /pollSummary=\{post\.boardType === "poll"/.test(postList) && postList.includes("pollSummaries[post.id]"),
  );

  const postCard = readSrc("components/community/PostCard.tsx");
  ok("PostCard: <PollCardBody summary={pollSummary}> 렌더", postCard.includes("<PollCardBody summary={pollSummary}"));

  const photoFeed = readSrc("components/community/PhotoFeed.tsx");
  ok("PhotoFeed: board_type poll 분기 + 전용카드 렌더", photoFeed.includes('post.board_type === "poll"') && photoFeed.includes("<PollCardBody summary={summary}"));
  ok("PhotoFeed: fetchPollSummaries(ids) 배치 조회", photoFeed.includes("fetchPollSummaries(ids)"));

  // — 자유게시판(free): usePosts('poll','poll') 병합 → PostList —
  const freePage = readSrc("app/(main)/community/free/page.tsx");
  ok("free page: usePosts('poll','poll') 병합", /usePosts\(\s*["']poll["']\s*,\s*["']poll["']\s*\)/.test(freePage));
  ok("free page: pollRaw 를 poll 로 병합", /pollRaw\.map\(\(p\) => toPost\(p, "poll"\)\)/.test(freePage));
  ok("free page: <PostList> 로 렌더", /<PostList\b/.test(freePage));

  // — 선수 페이지(player): player_tags cross-board → PhotoFeed. poll 을 배제하면 실패 —
  const playerPage = readSrc("app/(main)/community/players/[playerId]/page.tsx");
  ok("player page: player_tags contains cross-board query", playerPage.includes('.contains("player_tags"'));
  // cross-board tag query 는 board_type='player' 반복만 제외 — poll 을 따로 막으면(예: .neq("board_type","poll"))
  // 이 guard 가 즉시 실패해야 한다(삼순 독립 mutation 재현 커버).
  ok(
    "player page: poll 을 배제하는 board_type 필터 없음",
    !/\.neq\(\s*["']board_type["']\s*,\s*["']poll["']\s*\)/.test(playerPage) &&
      !/\.eq\(\s*["']board_type["']\s*,\s*["']player["']\s*\)[\s\S]{0,400}contains\("player_tags"/.test(playerPage),
  );
  ok("player page: <PhotoFeed> 로 렌더", /<PhotoFeed\b/.test(playerPage));

  // — 전체글(all)·팀(team): useUnifiedFeed → PhotoFeed —
  const allPage = readSrc("app/(main)/community/all-posts/page.tsx");
  ok("all-posts page: useUnifiedFeed({kind:'all'}) → <PhotoFeed>", /useUnifiedFeed\(\s*\{\s*kind:\s*"all"/.test(allPage) && /<PhotoFeed\b/.test(allPage));
  const teamPage = readSrc("app/(main)/community/teams/[teamId]/page.tsx");
  ok("team page: useUnifiedFeed({kind:'team'}) → <PhotoFeed>", /useUnifiedFeed\(\s*\{\s*kind:\s*"team"/.test(teamPage) && /<PhotoFeed\b/.test(teamPage));

  // useUnifiedFeed all 분기 board_type 집합에 poll 포함(전체글 도달성). 끊기면 실패.
  const unified = readSrc("lib/supabase/useUnifiedFeed.ts");
  ok(
    "useUnifiedFeed: 전체글 board_type 집합에 poll 포함",
    /\.in\("board_type",\s*\[[^\]]*"poll"/.test(unified),
  );
}

// ---------- 5) 렌더된 배지 ↔ isPollEffectiveClosed 연결 (react-dom/server) ----------
// 순수 함수 결과가 실제 카드 배지 텍스트로 연결되는지 — 삼순 3차 지적(isPollEffectiveClosed 실배선).
function badgeSummary(closed: boolean, closesOffsetMs: number): PollSummary {
  return {
    postId: 1,
    closesAt: new Date(Date.now() + closesOffsetMs).toISOString(),
    closed,
    voterCount: 3,
    optionCount: 2,
    // etc 선지(image null) → next/image 미렌더로 SSR 마크업 안전.
    options: [
      { position: 0, kind: "etc", refId: null, label: "개막승", image: null },
      { position: 1, kind: "etc", refId: null, label: "포스트시즌", image: null },
    ],
  };
}
function renderBadge(summary: PollSummary): string {
  const html = renderToStaticMarkup(React.createElement(PollCardBody, { summary }));
  // "마감" / "진행중" 중 정확히 하나만 렌더되어야 함.
  const closed = html.includes("마감");
  const open = html.includes("진행중");
  if (closed && !open) return "마감";
  if (open && !closed) return "진행중";
  return "NONE";
}
{
  const now = Date.now();
  const closedSummary = badgeSummary(true, 3600_000); // server closed=true
  const openSummary = badgeSummary(false, 3600_000); // 진행중(미래 마감)

  const closedBadge = renderBadge(closedSummary);
  const openBadge = renderBadge(openSummary);

  ok("server closed=true → 렌더 배지 '마감'", closedBadge === "마감");
  ok("진행중(미래 마감) → 렌더 배지 '진행중'", openBadge === "진행중");
  // SSR 초기 렌더에서 결정되는 두 경우는 렌더 배지 == isPollEffectiveClosed 매핑과 정확히 일치.
  ok(
    "렌더 배지 == isPollEffectiveClosed(closed) 매핑",
    closedBadge === (isPollEffectiveClosed(closedSummary, now) ? "마감" : "진행중"),
  );
  ok(
    "렌더 배지 == isPollEffectiveClosed(open) 매핑",
    openBadge === (isPollEffectiveClosed(openSummary, now) ? "마감" : "진행중"),
  );
  // isPollEffectiveClosed 가 PollCardBody effect 에서 실제로 쓰이는지 source guard(배지 경계 즉시 전환).
  const pollCardSrc = readSrc("components/community/PollCardBody.tsx");
  ok(
    "PollCardBody effect 에서 isPollEffectiveClosed 실사용",
    /isPollEffectiveClosed\(summary, Date\.now\(\)\)/.test(pollCardSrc),
  );
}

// ---------- 6) 배지 effect 실행 회귀 (jsdom mount + act) — 삼순 4차 P1 ----------
// SSR 정적 렌더만으론 boundaryClosed→배지 연결을 끊어도 PASS 되는 false-green 해소.
// 지난 closesAt poll 을 실제 mount 해 effect/0ms timer 후 '진행중→마감' 전환을 실행 검증.
async function badgeEffectSection() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const g = globalThis as unknown as Record<string, unknown>;
  const restore = {
    window: g.window,
    document: g.document,
    navigator: g.navigator,
    act: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = dom.window;
  g.document = dom.window.document;
  if (!("navigator" in g) || !g.navigator) g.navigator = dom.window.navigator;

  // 각 poll 은 독립 container/root 에 마운트(컴포넌트 state 블리딩 방지 — 실제로도 카드는 post별 독립 인스턴스).
  async function mountBadge(summary: PollSummary): Promise<string> {
    const c = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(c);
    const r = createRoot(c);
    await act(async () => {
      r.render(React.createElement(PollCardBody, { summary }));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20)); // effect + 0ms boundary timer flush
    });
    const text = c.textContent ?? "";
    await act(async () => {
      r.unmount();
    });
    return text;
  }
  try {
    // closed=false + closesAt 과거 → effect/0ms timer 후 '마감'. boundaryClosed→배지 연결을 끊으면 '진행중'으로 남아 실패.
    const pastText = await mountBadge(badgeSummary(false, -1000));
    ok("past closesAt effect 후 → '마감' 전환(boundaryClosed→배지 실배선)", pastText.includes("마감") && !pastText.includes("진행중"));

    // 동일하게 closed=false 이지만 closesAt 미래 → effect 후에도 '진행중'(경계 미도달). 둘의 차이는 closesAt 뿐.
    const futureText = await mountBadge(badgeSummary(false, 3600_000));
    ok("미래 마감 poll 은 effect 후에도 '진행중' 유지", futureText.includes("진행중") && !futureText.includes("마감"));
  } finally {
    // 글로벌 복원(다른 섹션이 jsdom 상태에 오염되지 않게).
    if (restore.window === undefined) delete g.window; else g.window = restore.window;
    if (restore.document === undefined) delete g.document; else g.document = restore.document;
    if (restore.navigator === undefined) delete g.navigator; else g.navigator = restore.navigator;
    if (restore.act === undefined) delete g.IS_REACT_ACT_ENVIRONMENT; else g.IS_REACT_ACT_ENVIRONMENT = restore.act;
  }
}

// fetch mock 섹션은 비동기 → top-level await 대신 async IIFE(스크립트 런너 cjs 호환).
void (async () => {
  await fetchMockSection();
  await badgeEffectSection();
  console.log(`\npoll card smoke: ${pass} PASS${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
})();
