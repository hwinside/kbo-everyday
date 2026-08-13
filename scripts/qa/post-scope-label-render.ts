/**
 * 글 공개범위 라벨 게이트 — 실제 화면 컴포넌트를 렌더해서 검증한다.
 *
 * 스펙(하린아빠 2026-08-06):
 *   · 10팀 전부 / 팀 태그 없음  → "전체구단 공개"
 *   · 2~3팀                    → 각 팀 배지
 *   · 4~9팀                    → 앞 3팀 배지 + "외 n팀" (앞 3팀 = **사용자 선택 순서**)
 *   · 1팀 / 선수 1명           → 팀(+선수) 배지
 *   · 홈 최신글·커뮤니티 피드·프로필 글 목록이 **같은 규칙**
 *   · 작성 시 **명시적 team_tags 1개 이상 필수** + "전체 선택" 옵션
 *
 * ⚠️ false-green 이력 (삼순 NO-GO 2026-08-06):
 *   - §2 가 실제 `CommunityLatestPosts` 대신 배지를 직접 렌더해, 홈 배선을 끊어도 GREEN 이었다.
 *   - §3/§4 가 문자열 존재만 검사해, 가드를 무력화하고 흔적만 남겨도 GREEN 이었다.
 *   - fixture 가 전부 구단 기본 순서 입력이라, 기본 순서로 재정렬하는 잘못된 구현도 GREEN 이었다.
 * 그래서 이 판본은 §1·§2 를 **실제 페이지/피드 컴포넌트 렌더**로, §4 를 **실제 제출 시도**로 바꾼다.
 *
 * 실행: npm run qa:post-scope-label
 * 자체검증: npm run qa:post-scope-label:selftest  (결함주입 RED 확인)
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "qa-anon-key";
// React act 는 development 번들에만 있다(Vercel prebuild 는 NODE_ENV=production).
process.env.NODE_ENV = "development";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "Event", "MouseEvent", "SVGElement", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage",
  "matchMedia",
]) {
  g[k] = win[k];
}
g.self = win;
(win as Record<string, unknown>).matchMedia ??= () => ({
  matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, media: "", dispatchEvent: () => false,
});
g.matchMedia = (win as Record<string, unknown>).matchMedia;
class NoopObserver {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
g.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver;
g.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const proto = (win.HTMLElement as { prototype: Record<string, unknown> }).prototype;
proto.scrollIntoView ??= function scrollIntoView() {};
proto.scrollTo ??= function scrollTo() {};
g.fetch ??= (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++;
    failures.push(name);
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SELFTEST = process.argv.includes("--selftest");

type Fixture = {
  id: number;
  team_tags?: string[];
  player_tags?: string[];
  board_type?: string;
  board_id?: string;
};

function feedRow(f: Fixture) {
  return {
    id: f.id,
    author_id: `author-${f.id}`,
    board_type: f.board_type ?? "free",
    board_id: f.board_id ?? "free",
    content_type: "general",
    title: "",
    content: `본문 ${f.id}`,
    image_urls: [],
    video_urls: [],
    like_count: 0,
    comment_count: 0,
    created_at: new Date().toISOString(),
    is_hidden: false,
    game_id: null,
    player_tags: f.player_tags ?? [],
    team_tags: f.team_tags ?? [],
    hashtags: [],
    author_team_id_snapshot: 1,
    click_view_count: 0,
    impression_view_count: 0,
    profiles: { nickname: `유저${f.id}`, team_id: 1, grade: "member", points: 0, avatar_url: null },
  };
}

/** 피드 카드용 Post(useUnifiedFeed.mapRow 결과와 동형). */
function feedPost(f: Fixture) {
  const r = feedRow(f);
  return {
    ...r,
    nickname: r.profiles.nickname,
    team_id: r.profiles.team_id,
    grade: r.profiles.grade,
    avatar_url: null,
    profiles: undefined,
  };
}

/**
 * 카드별 `공개범위` 라벨 블록의 칩 텍스트를 공백 1칸으로 이은 문자열.
 * 배지를 여러 개 나열하면 textContent 가 "LG두산KT"처럼 붙어 경계가 안 보인다.
 * 칩 단위로 읽어야 "3팀까지 각 팀 배지" 스펙을 실제로 검증한다.
 */
function scopeTextsFrom(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("[data-community-source-label]")).map((block) => {
    const badge = block.querySelector("span.inline-flex.items-center.gap-1.min-w-0");
    const host = badge ?? block;
    const chips = Array.from(host.children)
      .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (chips.length > 0) return chips.join(" ");
    return (host.textContent ?? "").replace(/\s+/g, " ").trim();
  });
}

/** 홈 최신글 compact 라벨 — 로고만 노출되므로 aria-label 을 우선 읽는다. */
function homeScopeTexts(root: HTMLElement): string[] {
  const links = Array.from(root.querySelectorAll("a[data-home-latest-row], a[href^='/community/']"));
  const out: string[] = [];
  for (const link of links) {
    const badge = link.querySelector("span.inline-flex.items-center.gap-1.min-w-0");
    if (!badge) continue;
    const aria = badge.getAttribute("aria-label");
    if (aria) { out.push(aria.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim()); continue; }
    const chips = Array.from(badge.children)
      .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    out.push(chips.length ? chips.join(" ") : (badge.textContent ?? "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * supabase 브라우저 클라이언트 stub — `posts` 조회만 fixture 로 응답한다.
 * useUnifiedFeed 가 실제로 이 클라이언트를 통해 SELECT/필터/limit 을 조립하므로,
 * 홈 컴포넌트를 통째로 렌더해도 네트워크 없이 돌아간다.
 */
function installSupabaseStub(rows: unknown[]) {
  const selected: string[] = [];
  const makeQuery = (table: string) => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ["or", "eq", "in", "lt", "neq", "contains", "order", "limit", "gte", "lte", "not"]) {
      q[m] = (...args: unknown[]) => {
        if (m === "limit" || m === "order") { /* terminal-ish, still chainable */ }
        void args;
        return chain();
      };
    }
    q.select = (cols: string) => { selected.push(`${table}:${cols}`); return chain(); };
    // await 되는 지점: thenable 로 결과 반환.
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: table === "posts" ? rows : [], error: null }).then(res);
    return q;
  };
  return { client: { from: (table: string) => makeQuery(table) }, selected };
}

/**
 * **투영(projection) supabase stub** — SELECT 에 적힌 컬럼만 돌려준다.
 *
 * ⚠️ 이게 이번 판본의 핵심이다. 종전 stub 은 컬럼 목록을 기록만 하고 row 를 통째로 반환했다.
 *   그래서 `usePosts` 의 SELECT 에서 `team_tags` 가 빠져 있어도 데이터가 그대로 흘러 GREEN 이었고,
 *   실제 화면에서는 라벨이 `전체구단 공개` 로 폴백하고 있었다(삼순 NO-GO 2026-08-07).
 *   조회 컬럼을 실제로 적용해야 query→map→card 중 **query 구간**이 게이트에 잡힌다.
 */
function installProjectingStub(rows: Record<string, unknown>[]) {
  const selected: string[] = [];
  /** posts 조회가 몇 번 일어났는지 — reload() 가 실제로 두 번째 SELECT 를 냈는지 판정한다. */
  const postsSelects: string[] = [];
  const project = (cols: string) => {
    // "a, b, profiles(x, y)" → 최상위 컬럼만 추출(괄호 안은 조인이므로 통째로 통과).
    const top = cols.replace(/\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean);
    const joins = Array.from(cols.matchAll(/(\w+)\s*\(/g)).map((m) => m[1]);
    const keep = new Set([...top, ...joins]);
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(r)) if (keep.has(k)) out[k] = r[k];
      return out;
    });
  };
  const makeQuery = (table: string) => {
    const q: Record<string, unknown> = {};
    let projected: unknown[] = [];
    const inserted: unknown[] = [];
    const chain = () => q;
    for (const m of ["or", "eq", "in", "lt", "neq", "contains", "order", "limit", "gte", "lte", "not"]) {
      q[m] = (...args: unknown[]) => { void args; return chain(); };
    }
    q.select = (cols?: string) => {
      // ⚠️ `.insert(row).select().single()` 처럼 **인자 없는 select()** 도 있다.
      //    컬럼 문자열을 전제하면 여기서 터진다(자체결함 이력). 조회 SELECT 만 투영 대상이다.
      if (cols === undefined) return chain();
      selected.push(`${table}:${cols}`);
      if (table === "posts") postsSelects.push(cols);
      projected = table === "posts" ? project(cols) : [];
      return chain();
    };
    // createPost 가 실제로 도는 경로도 태운다(모듈 export 를 갈아끼우는 방식은
    // ESM import 바인딩 때문에 안 먹는다 — 실제로 "로그인 필요"가 그대로 터졌다).
    q.insert = (row: unknown) => { inserted.push(row); return chain(); };
    q.single = () => chain();
    q.maybeSingle = () => chain();
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({
        data: inserted.length > 0 ? { id: 999 } : projected,
        error: null,
      }).then(res);
    return q;
  };
  return { from: (table: string) => makeQuery(table), selected, postsSelects };
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AppRouterContext } = (await import(
    "next/dist/shared/lib/app-router-context.shared-runtime"
  )) as unknown as { AppRouterContext: React.Context<unknown> };
  const routerValue = {
    push: () => {}, replace: () => {}, back: () => {}, forward: () => {},
    refresh: () => {}, prefetch: () => {},
  };

  // TeamBadge 가 useTheme 을 쓰므로 실제 ThemeProvider 로 감싼다(목킹하면 배지 렌더 경로가 가짜가 됨).
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");
  const { TEAMS } = await import("../../src/lib/constants/teams");
  const allSlugs = TEAMS.map((t) => t.slug);
  const s = (n: number) => TEAMS.slice(0, n).map((t) => t.slug);
  const shortName = (slug: string) => TEAMS.find((t) => t.slug === slug)!.shortName;

  // 선수 태그는 실제 로스터에서 뽑는다 — 가짜 kboId 면 teamIdForKboId 가 null 이라
  // "선수 유래 팀" 경로를 아예 안 태운다.
  const roster = (await import("../../src/lib/constants/players-roster.json"))
    .default as { kboId: string; name: string; teamId: number }[];
  const playerTagOfTeam = (teamId: number) => {
    const p = roster.find((r) => r.teamId === teamId);
    if (!p) throw new Error(`roster 에 teamId=${teamId} 선수가 없음 — fixture 재구성 필요`);
    return `${p.kboId}:${p.name}`;
  };

  // 사용자 선택 순서 보존을 검증하려면 입력 순서가 구단 기본 순서와 달라야 한다.
  const rev4 = [...s(4)].reverse();

  const fixtures: { label: string; post: Fixture; expect: string }[] = [
    { label: "10팀 전부 → 전체구단 공개", post: { id: 1, team_tags: allSlugs }, expect: "전체구단 공개" },
    { label: "태그 없음 → 전체구단 공개", post: { id: 2 }, expect: "전체구단 공개" },
    { label: "1팀 → 팀 배지", post: { id: 3, team_tags: s(1) }, expect: shortName(allSlugs[0]) },
    { label: "2팀 → 팀 배지 2개", post: { id: 4, team_tags: s(2) }, expect: s(2).map(shortName).join(" ") },
    { label: "3팀 → 팀 배지 3개(외 n팀 없음)", post: { id: 5, team_tags: s(3) }, expect: s(3).map(shortName).join(" ") },
    { label: "4팀 → 3팀 + 외 1팀", post: { id: 6, team_tags: s(4) }, expect: `${s(3).map(shortName).join(" ")} 외 1팀` },
    { label: "9팀 → 3팀 + 외 6팀", post: { id: 7, team_tags: s(9) }, expect: `${s(3).map(shortName).join(" ")} 외 6팀` },
    {
      label: "선택 순서 보존(역순 4팀)",
      post: { id: 8, team_tags: rev4 },
      expect: `${rev4.slice(0, 3).map(shortName).join(" ")} 외 1팀`,
    },
    {
      label: "직접 선택 우선, 선수 유래 팀은 뒤",
      post: { id: 9, team_tags: [allSlugs[4]], player_tags: [playerTagOfTeam(1)] },
      expect: `${shortName(allSlugs[4])} ${shortName(allSlugs[0])}`,
    },
    {
      // cross-board: 선수 페이지 피드에 뜨는 다팀 글. team_tags 가 조회에서 빠지면
      // 선수 소속팀 1개로 축소돼 다른 화면과 어긋난다(삼순 NO-GO 2026-08-06).
      label: "cross-board 다팀 글(선수 태그 + 4팀)",
      post: { id: 10, team_tags: s(4), player_tags: [playerTagOfTeam(1)], board_type: "team", board_id: allSlugs[0] },
      expect: `${s(3).map(shortName).join(" ")} 외 1팀`,
    },
  ];

  // ── §1. 실제 커뮤니티 피드(PhotoFeed) 렌더 ────────────────────────────────
  const PhotoFeed = (await import("../../src/components/community/PhotoFeed")).default;

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: routerValue },
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(PhotoFeed as never, {
            posts: fixtures.map((f) => feedPost(f.post)),
            loading: false,
            onLike: () => {},
          } as never),
        ),
      ),
    );
  });

  const texts = scopeTextsFrom(el as unknown as HTMLElement);
  ok(`§1 피드 카드 수 = ${fixtures.length}`, texts.length === fixtures.length, `실제 ${texts.length}개`);
  fixtures.forEach((f, i) => {
    ok(`§1 피드 ${f.label}`, texts[i] === f.expect, `기대 "${f.expect}" / 실제 "${texts[i]}"`);
  });
  ok("§1 피드에 옛 '글 소속' 라벨 없음", !(el as unknown as HTMLElement).innerHTML.includes("글 소속"));

  await act(async () => { root.unmount(); });

  // ── §2. 실제 홈 최신글(CommunityLatestPosts) 렌더 ─────────────────────────
  // 이전 판본은 배지를 직접 렌더해 홈 배선을 끊어도 GREEN 이었다(삼순 NO-GO).
  // 이제 홈 컴포넌트를 통째로 마운트하고 useUnifiedFeed 가 supabase stub 을 타게 한다.
  const stub = installSupabaseStub(fixtures.map((f) => feedRow(f.post)));
  const clientMod = await import("../../src/lib/supabase/client");
  const originalFrom = (clientMod.supabase as unknown as { from: unknown }).from;
  (clientMod.supabase as unknown as { from: unknown }).from = stub.client.from;

  const CommunityLatestPosts = (await import("../../src/components/home/CommunityLatestPosts")).default;

  const el2 = document.createElement("div");
  document.body.appendChild(el2);
  const root2 = createRoot(el2);
  await act(async () => {
    root2.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: routerValue },
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(CommunityLatestPosts as never, { myTeamId: null } as never),
        ),
      ),
    );
  });
  // 피드 로드는 effect 안의 async — settle 대기.
  for (let i = 0; i < 20; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  const homeTexts = homeScopeTexts(el2 as unknown as HTMLElement);
  ok(
    `§2 홈 카드 수 ≥ 1 (실제 컴포넌트 마운트 확인)`,
    homeTexts.length > 0,
    `홈이 카드를 하나도 렌더하지 않음 — 배선 끊김 또는 stub 부적합`,
  );
  // 홈은 기본 5개만 펼쳐 보여주므로(HOME_LATEST_COLLAPSED) 앞쪽 fixture 만 대조한다.
  const homeCheckCount = Math.min(homeTexts.length, fixtures.length);
  for (let i = 0; i < homeCheckCount; i++) {
    ok(
      `§2 홈 ${fixtures[i].label}`,
      homeTexts[i] === fixtures[i].expect,
      `기대 "${fixtures[i].expect}" / 실제 "${homeTexts[i]}"`,
    );
  }
  ok("§2 홈이 옛 '크보팬' 라벨을 쓰지 않음", !homeTexts.some((t) => t === "크보팬"));

  await act(async () => { root2.unmount(); });
  (clientMod.supabase as unknown as { from: unknown }).from = originalFrom;

  // ── §3. 선수 페이지 조회 컬럼 — team_tags 포함 ────────────────────────────
  // 조회에서 빠지면 다팀 글이 선수 피드에서만 축소 표시된다(런타임에 안 터지고 조용히 틀림).
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const playerPage = src("src/app/(main)/community/players/[playerId]/page.tsx");
  const colsLine = playerPage.match(/const cols = "([^"]+)"/)?.[1] ?? "";
  ok("§3 선수 피드 조회에 team_tags 포함", colsLine.includes("team_tags"), `cols="${colsLine.slice(0, 60)}…"`);
  ok("§3 선수 피드 조회에 player_tags 포함", colsLine.includes("player_tags"));

  const profilePage = src("src/app/(main)/profile/[userId]/page.tsx");
  ok("§3 프로필 글 목록 조회에 team_tags 포함", /select\([^)]*team_tags/.test(profilePage));

  // ── §4. 작성 화면 — 실제 제출 시도로 가드 검증(문자열 존재 검사 아님) ──────
  // 이전 판본은 `hasTeamScope` 문자열만 봐서, 가드를 무력화하고 이름만 남겨도 GREEN 이었다.
  const { hasRequiredTeamTag } = await import("../../src/lib/utils/post-scope");
  const TeamTagger = (await import("../../src/components/community/TeamTagger")).default;

  // 4-1. 전체 선택 칩이 실제로 10팀을 넘겨주는지 — 클릭해서 콜백 인자를 본다.
  let setAllArg: string[] | null = null;
  const el3 = document.createElement("div");
  document.body.appendChild(el3);
  const root3 = createRoot(el3);
  await act(async () => {
    root3.render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(TeamTagger as never, {
          selectedSlugs: [],
          onToggle: () => {},
          onSetAll: (v: string[]) => { setAllArg = v; },
        } as never),
      ),
    );
  });
  const allChip = (el3 as unknown as HTMLElement).querySelector("[data-team-select-all]") as HTMLElement | null;
  ok("§4 전체 선택 칩 렌더", !!allChip);
  if (allChip) {
    await act(async () => { allChip.click(); });
  }
  ok(
    "§4 전체 선택 클릭 → 10팀 전부 전달",
    Array.isArray(setAllArg) && (setAllArg as string[]).length === TEAMS.length,
    `실제 ${(setAllArg as string[] | null)?.length ?? "null"}개`,
  );
  await act(async () => { root3.unmount(); });

  // 4-2. WritePost 실제 마운트 — 팀 미선택 시 제출 콜백이 호출되지 않아야 한다.
  const WritePost = (await import("../../src/components/community/WritePost")).default;
  let submitCalls = 0;
  const el4 = document.createElement("div");
  document.body.appendChild(el4);
  const root4 = createRoot(el4);
  await act(async () => {
    root4.render(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(WritePost as never, {
          isOpen: true,
          onClose: () => {},
          enableTags: true,
          onSubmit: async () => { submitCalls += 1; },
        } as never),
      ),
    );
  });
  const host4 = el4 as unknown as HTMLElement;
  const textarea = host4.querySelector("textarea") as HTMLTextAreaElement | null;
  ok("§4 WritePost 본문 입력 필드 렌더", !!textarea);
  if (textarea) {
    // React controlled input 에 값 주입 후 input 이벤트 발화.
    const setter = Object.getOwnPropertyDescriptor(
      (win.HTMLTextAreaElement as { prototype: object }).prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, "테스트 본문");
      textarea.dispatchEvent(new (win.Event as typeof Event)("input", { bubbles: true }));
    });
  }
  const submitBtn = Array.from(host4.querySelectorAll("button")).find((b) =>
    /등록|게시|저장/.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  ok("§4 WritePost 제출 버튼 렌더", !!submitBtn);
  if (submitBtn) {
    await act(async () => { submitBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  ok("§4 팀 미선택이면 제출되지 않음", submitCalls === 0, `submit ${submitCalls}회 호출됨`);

  // 팀을 하나 고르면 제출된다 — 가드가 항상 막기만 하는 게 아님을 확인(반대 방향).
  const teamChip = Array.from(host4.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === shortName(allSlugs[0]) && !b.hasAttribute("data-team-select-all"),
  ) as HTMLButtonElement | undefined;
  ok("§4 팀 칩 렌더", !!teamChip);
  if (teamChip && submitBtn) {
    await act(async () => { teamChip.click(); });
    await act(async () => { submitBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  ok("§4 팀 1개 선택하면 제출됨", submitCalls === 1, `submit ${submitCalls}회`);
  await act(async () => { root4.unmount(); });

  // 4-3. 서버 write 경계 — /api/polls 를 **실제로 POST** 해서 경계를 확인한다.
  //
  // 이전 판본은 소스에서 `teamTags.size === 0` 의 위치만 봤다. 그건 두 가지를 놓쳤다:
  //   ① 문자열이 있어도 그 Set 이 이미 선지 파생 팀을 담고 있으면 가드는 무의미하다
  //     (삼순 2차 NO-GO — 순서만 앞이지 검사 대상이 틀렸다).
  //   ② 가드 변수명을 바꾸면 문자열 검사는 조용히 무너진다.
  // 따라서 route 핸들러를 직접 호출해 **응답 상태코드**로 판정한다.
  {
    const pollRoute = src("src/app/api/polls/route.ts");
    // 명시 태그를 파생과 다른 집합으로 분리했는지(구조 계약).
    ok(
      "§4 /api/polls 명시 teamTags 를 파생과 별도 집합으로 검증",
      /explicitTeamTags\.length === 0/.test(pollRoute),
      "합쳐진 Set 크기로 보면 팀 선지만 있어도 통과한다",
    );

    // 실제 POST — 모듈을 로드해 핸들러를 호출한다.
    // 인증은 admin 싱글턴의 auth.getUser 를 stub 해서 통과시킨다 — 우리가 보려는 건
    // 토큰 검증이 아니라 그 다음의 공개범위 경계다. RPC 까지 가기 전에 400 으로 끝나야 정상.
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "qa-service-role-key";
    const adminMod = await import("../../src/lib/supabase/admin");
    const admin = adminMod.getSupabaseAdmin() as unknown as {
      auth: { getUser: (t: string) => Promise<unknown> };
      from: unknown;
      rpc: unknown;
    };
    admin.auth.getUser = async () => ({
      data: { user: { id: "00000000-0000-0000-0000-0000000000qa".slice(0, 36) } },
      error: null,
    });
    // RPC 까지 도달하면 그건 경계를 통과했다는 뜻 — 실 DB 를 치지 않게 막고 표시만 남긴다.
    admin.rpc = async () => ({ data: null, error: { code: "QA_STUB", message: "rpc stubbed" } });
    const pollModule = (await import("../../src/app/api/polls/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    // dead-token guard의 exp 프리체크가 비JWT 토큰을 로컬 거절하므로
    // 테스트 토큰도 exp가 유효한 JWT 형태여야 한다 (서명 검증은 stub이 대신).
    const qaB64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const qaJwt = `${qaB64({ alg: "HS256", typ: "JWT" })}.${qaB64({ sub: "qa", exp: Math.floor(Date.now() / 1000) + 3600 })}.qa-sig`;
    const postPoll = async (body: unknown) => {
      const res = await pollModule.POST(
        new Request("http://localhost/api/polls", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${qaJwt}` },
          body: JSON.stringify(body),
        }) as never,
      );
      return { status: res.status, text: await res.text() };
    };
    const teamOptionBody = {
      title: "올해 우승팀은?",
      closesAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      options: [
        { kind: "team", refId: "lg" },
        { kind: "team", refId: "doosan" },
      ],
      teamTags: [],
    };
    const denied = await postPoll(teamOptionBody);
    ok(
      "§4 팀 선지만 있고 명시 teamTags 가 비면 400",
      denied.status === 400 && denied.text.includes("팀을 최소 1개"),
      `status ${denied.status} / ${denied.text.slice(0, 80)}`,
    );
    const playerOnly = await postPoll({
      title: "MVP 는?",
      closesAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      options: [
        { kind: "player", refId: playerTagOfTeam(TEAMS[0].id).split(":")[0] },
        { kind: "player", refId: playerTagOfTeam(TEAMS[1].id).split(":")[0] },
      ],
      teamTags: [],
    });
    ok(
      "§4 선수 선지만 있고 명시 teamTags 가 비면 400",
      playerOnly.status === 400,
      `status ${playerOnly.status}`,
    );
    // 반대 방향 — 명시 태그가 있으면 이 경계에서 거절되지 않아야 한다(이후 단계에서 죽는 건 무관).
    const allowed = await postPoll({ ...teamOptionBody, teamTags: ["lg"] });
    ok(
      "§4 명시 teamTags 가 있으면 공개범위 경계를 통과",
      !(allowed.status === 400 && allowed.text.includes("팀을 최소 1개")),
      `status ${allowed.status} / ${allowed.text.slice(0, 80)}`,
    );
  }

  // 4-4. DB 경계는 **정규식이 아니라 실제 Postgres 행동**으로 검증한다.
  //   종전 이 자리에 있던 소스 정규식 검사는 `['']`·`['not-a-team']` 이 통과하는 걸 못 잡았다
  //   (삼순 NO-GO 2026-08-06 2차). 검증기가 대상 SQL 을 읽고 '문자열이 있나' 를 보는 방식은
  //   그 SQL 이 무엇을 거절하는지에 대해 검출력이 0 이다.
  //   → `scripts/qa/post-scope-db-trigger-integration.ts` (npm run qa:post-scope-db-trigger)
  //   여기서는 그 게이트가 **prebuild 에 실제로 물려 있는지**만 확인한다(배선 누락 방지).
  {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    ok("§4 DB 경계 게이트 스크립트가 등록돼 있다", typeof pkg.scripts["qa:post-scope-db-trigger"] === "string");
    ok(
      "§4 DB 경계 게이트가 prebuild(required) 에 물려 있다",
      (pkg.scripts.prebuild ?? "").includes("qa:post-scope-db-trigger"),
    );
  }

  // ── §6. query→map→card 실배선 (삼순 NO-GO 2026-08-07) ────────────────────
  //
  //   종전 게이트는 fixture 에 태그를 **직접 주입**해 카드만 태웠다. 그래서 조회(SELECT)와
  //   매핑(map) 두 구간이 끊겨도 GREEN 이었고, 실제 화면에서는 라벨이 조용히
  //   `전체구단 공개` 로 폴백하고 있었다. 여기서는 **투영 stub** 으로 SELECT 컬럼을 실제로
  //   적용해 DB→hook→page→card 전 구간을 태운다.
  //   판정 축: 4팀 태그 글이 "3팀 + 외 1팀" 으로 나와야 한다. 태그가 중간에 유실되면
  //   board 폴백이 걸려 `전체구단 공개`(free) 또는 선수 소속 1팀(player)으로 축소된다.
  console.log("\n[6] query→map→card 실배선");

  const wiredFixture = { id: 501, team_tags: s(4), player_tags: [] as string[] };
  const wiredExpect = `${s(3).map(shortName).join(" ")} 외 1팀`;

  // 6-1. 자유게시판: usePosts(SELECT+map) → free/page(toPost) → PostList → PostCard
  {
    const stub6 = installProjectingStub([
      { ...feedRow(wiredFixture), board_type: "free", board_id: "general", content_type: "general" },
    ]);
    const clientMod6 = await import("../../src/lib/supabase/client");
    const orig6 = (clientMod6.supabase as unknown as { from: unknown }).from;
    (clientMod6.supabase as unknown as { from: unknown }).from = stub6.from;

    const FreeBoardPage = (await import("../../src/app/(main)/community/free/page")).default;
    const el6 = document.createElement("div");
    document.body.appendChild(el6);
    const root6 = createRoot(el6);
    await act(async () => {
      root6.render(
        React.createElement(
          AppRouterContext.Provider,
          { value: routerValue },
          React.createElement(ThemeProvider, null, React.createElement(FreeBoardPage as never, {} as never)),
        ),
      );
    });
    for (let i = 0; i < 30; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    const freeTexts = scopeTextsFrom(el6 as unknown as HTMLElement);
    ok(
      "§6 자유게시판이 카드를 렌더한다(실배선 확인)",
      freeTexts.length > 0,
      "카드 0개 — hook/page 배선 끊김 또는 stub 부적합",
    );
    ok(
      "§6 자유게시판 4팀 글이 '3팀 + 외 1팀'",
      freeTexts[0] === wiredExpect,
      `기대 "${wiredExpect}" / 실제 "${freeTexts[0]}" — 중간 구간에서 태그가 유실되면 전체구단 공개로 폴백한다`,
    );
    // SELECT 자체에 컬럼이 있는지도 함께 남긴다(진단용 — 판정은 위 렌더 결과가 한다).
    ok(
      "§6 usePosts SELECT 에 team_tags 포함",
      stub6.selected.some((c) => c.startsWith("posts:") && c.includes("team_tags")),
      stub6.selected.find((c) => c.startsWith("posts:"))?.slice(0, 80),
    );

    // ── 6-1b. reload() 경로 ──────────────────────────────────────────────
    //   ⚠️ 삼순 NO-GO 2026-08-07: 여기까지는 **최초 mount 만** 태운다.
    //   `usePosts` 는 조회 SELECT 가 최초/`reload()` 두 벌로 **복제**돼 있어서,
    //   reload 쪽에서만 team_tags 가 빠져도 위 검사는 전부 GREEN 이다.
    //   reload 는 글 작성·수정·삭제 직후에 도는 경로 — 결손이 나면 "방금 쓴 내 글만
    //   라벨이 틀리는" 형태로, 유저가 가장 먼저 보는 자리에서 터진다.
    //   → 실제로 글쓰기를 완료시켜 reload() 를 호출하고, **두 번째** SELECT 결과가
    //     카드 라벨까지 가는지 본다.
    const beforeReloadSelects = stub6.postsSelects.length;

    // reload 는 WritePost 의 onSubmit 끝에서 호출된다. UI 를 다 태우는 대신
    // 그 콜백을 직접 실행해 reload 만 정확히 트리거한다(제출 가드는 §4 가 이미 검증).
    //
    // ⚠️ 자체결함 이력: 처음엔 `usePosts` 모듈의 `createPost` export 를 갈아끼웠는데
    //    ESM import 바인딩이라 무효였고 실제로 "로그인 필요"가 그대로 터졌다.
    //    → 모듈을 흉내내지 말고 **실제 createPost 를 태우되 인증만 stub** 한다.
    //      insert 는 위 projecting stub 이 받는다.
    const authMod = (clientMod6.supabase as unknown as {
      auth: { getUser: unknown; getSession: unknown };
    }).auth;
    const realGetUser = authMod.getUser;
    const realGetSession = authMod.getSession;
    authMod.getUser = async () => ({ data: { user: { id: "qa-author" } }, error: null });
    authMod.getSession = async () => ({ data: { session: null }, error: null });

    // 렌더된 트리에서 WritePost 의 onSubmit 을 찾아 호출한다.
    const findOnSubmit = (node: unknown): ((...a: unknown[]) => unknown) | null => {
      const q: unknown[] = [node];
      while (q.length) {
        const n = q.shift() as Record<string, unknown> | null;
        if (!n || typeof n !== "object") continue;
        const props = n.memoizedProps as Record<string, unknown> | undefined;
        const t = n.type as { name?: string } | undefined;
        if (props && typeof props.onSubmit === "function" && t?.name === "WritePost") {
          return props.onSubmit as (...a: unknown[]) => unknown;
        }
        if (n.child) q.push(n.child);
        if (n.sibling) q.push(n.sibling);
      }
      return null;
    };
    const fiberKey = Object.keys(el6).find((k) => k.startsWith("__reactContainer$"));
    const rootFiber = fiberKey ? (el6 as unknown as Record<string, unknown>)[fiberKey] : null;
    // React 19: container 키에 HostRoot fiber 가 직접 들어있다. `.current` 가 있으면 그걸,
    // 없으면 노드 자체를 루트로 삼는다(둘 다 지원해야 버전 차이에 안 깨진다).
    const rootAny = rootFiber as Record<string, unknown> | null;
    const onSubmit = rootAny ? findOnSubmit(rootAny.current ?? rootAny) : null;

    ok("§6 reload 트리거 지점(WritePost.onSubmit) 확보", !!onSubmit, "찾지 못하면 reload 경로를 못 태운다");

    if (onSubmit) {
      await act(async () => { await onSubmit("공개범위 reload 검증 글", "reload 경로가 team_tags 를 실어오는지 확인한다", [], undefined, { teamTags: s(4), playerTags: [] }); });
      for (let i = 0; i < 30; i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      }
    }
    authMod.getUser = realGetUser;
    authMod.getSession = realGetSession;

    ok(
      "§6 reload() 가 실제로 두 번째 posts SELECT 를 낸다",
      stub6.postsSelects.length > beforeReloadSelects,
      `조회 수 ${beforeReloadSelects} → ${stub6.postsSelects.length}`,
    );
    ok(
      "§6 reload SELECT 에 team_tags 포함",
      stub6.postsSelects.slice(beforeReloadSelects).every((c) => c.includes("team_tags")),
      stub6.postsSelects.slice(beforeReloadSelects)[0]?.slice(0, 80),
    );
    const afterReloadTexts = scopeTextsFrom(el6 as unknown as HTMLElement);
    ok(
      "§6 reload 후에도 4팀 글이 '3팀 + 외 1팀'",
      afterReloadTexts.length > 0 && afterReloadTexts[0] === wiredExpect,
      `기대 "${wiredExpect}" / 실제 "${afterReloadTexts[0]}" — reload SELECT 결손이면 여기서 전체구단 공개로 뒤집힌다`,
    );

    await act(async () => { root6.unmount(); });
    (clientMod6.supabase as unknown as { from: unknown }).from = orig6;
  }

  // 6-2. 최애선수 사진탭: usePlayerCommunity(SELECT+setPhotoPosts map) → PhotoFeed → PostCard
  //   hook 을 실제로 돌려야 map 구간이 태워진다. renderHook 대신 소비 컴포넌트를 즉석에서 만든다.
  {
    const stub7 = installProjectingStub([
      { ...feedRow({ ...wiredFixture, id: 502 }), board_type: "player", board_id: "53123", content_type: "photo" },
    ]);
    const clientMod7 = await import("../../src/lib/supabase/client");
    const orig7 = (clientMod7.supabase as unknown as { from: unknown }).from;
    (clientMod7.supabase as unknown as { from: unknown }).from = stub7.from;

    const { usePlayerCommunity } = await import("../../src/hooks/usePlayerCommunity");
    const PhotoFeedMod = (await import("../../src/components/community/PhotoFeed")).default;

    const Harness = () => {
      const c = usePlayerCommunity(1) as unknown as {
        filteredPhotoPosts: unknown[];
        setSelectedPlayer: (v: string) => void;
        handleTabChange: (t: string) => void;
      };
      React.useEffect(() => {
        c.setSelectedPlayer("53123");
        c.handleTabChange("photo");
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement(PhotoFeedMod as never, {
        posts: c.filteredPhotoPosts,
        loading: false,
        onLike: () => {},
      } as never);
    };

    const el7 = document.createElement("div");
    document.body.appendChild(el7);
    const root7 = createRoot(el7);
    await act(async () => {
      root7.render(
        React.createElement(
          AppRouterContext.Provider,
          { value: routerValue },
          React.createElement(ThemeProvider, null, React.createElement(Harness)),
        ),
      );
    });
    for (let i = 0; i < 30; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }

    const photoTexts = scopeTextsFrom(el7 as unknown as HTMLElement);
    ok(
      "§6 최애선수 사진탭이 카드를 렌더한다(실배선 확인)",
      photoTexts.length > 0,
      "카드 0개 — hook 이 사진글을 못 실었다",
    );
    ok(
      "§6 최애선수 사진탭 4팀 글이 '3팀 + 외 1팀'",
      photoTexts[0] === wiredExpect,
      `기대 "${wiredExpect}" / 실제 "${photoTexts[0]}" — setPhotoPosts 매핑이 태그를 버리면 선수 보드 1팀으로 축소된다`,
    );

    await act(async () => { root7.unmount(); });
    (clientMod7.supabase as unknown as { from: unknown }).from = orig7;
  }

  // ── §5. 결함주입 자체검증 ────────────────────────────────────────────────
  if (SELFTEST) {
    console.log("\n  [selftest] 순수 규칙 결함주입");
    const { resolvePostScope } = await import("../../src/lib/utils/post-scope");
    const mutations: { name: string; check: () => boolean }[] = [
      { name: "10팀을 9팀으로 줄이면 전체구단이 아님", check: () => resolvePostScope({ team_tags: s(9) }).kind !== "all" },
      {
        name: "3팀은 overflow 0",
        check: () => { const r = resolvePostScope({ team_tags: s(3) }); return r.kind === "teams" && r.overflow === 0; },
      },
      {
        name: "4팀은 shown 3 + overflow 1",
        check: () => { const r = resolvePostScope({ team_tags: s(4) }); return r.kind === "teams" && r.shown.length === 3 && r.overflow === 1; },
      },
      {
        name: "역순 입력이면 shown 도 역순(선택 순서 보존)",
        check: () => {
          const r = resolvePostScope({ team_tags: [...s(4)].reverse() });
          if (r.kind !== "teams") return false;
          const slugs = r.shown.map((id) => TEAMS.find((t) => t.id === id)!.slug);
          return slugs.join(",") === [...s(4)].reverse().slice(0, 3).join(",");
        },
      },
      { name: "선수 태그 소속팀은 필수조건을 대신하지 않음", check: () => !hasRequiredTeamTag([]) },
      { name: "team_tags 1개면 필수조건 충족", check: () => hasRequiredTeamTag(s(1)) },
      { name: "알 수 없는 슬러그는 필수조건 미충족", check: () => !hasRequiredTeamTag(["not-a-team"]) },
      { name: "태그 0개는 all", check: () => resolvePostScope({}).kind === "all" },
    ];
    for (const m of mutations) ok(`§5 ${m.name}`, m.check());
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n  실패 항목: ${failures.join(" / ")}`);
    process.exit(1);
  }
  // ⚠️ **명시 종료 필수.** JSDOM 타이머와 supabase GoTrue 자동갱신 핸들이 살아있어
  // 자연 종료를 기다리면 프로세스가 안 끝난다. 실제로 2026-08-06 exact 01ad5a10f 의 Vercel 배포가
  // 이 게이트 출력("37 passed, 0 failed")을 끝으로 **next build 로 넘어가지 못하고** ERROR 로 죽었다.
  // 로컬에서는 사람이 전진하니 안 보이고 CI 에서만 터지는 유형이라 더 위험하다.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
