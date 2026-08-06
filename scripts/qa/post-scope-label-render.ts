/**
 * 글 공개범위 라벨 게이트 — 실제 피드 컴포넌트를 렌더해서 검증한다.
 *
 * 스펙(하린아빠 2026-08-06):
 *   · 10팀 전부 / 팀 태그 없음  → "전체구단 공개"
 *   · 2~3팀                    → 각 팀 배지
 *   · 4~9팀                    → 앞 3팀 배지 + "외 n팀"
 *   · 1팀 / 선수 1명           → 팀(+선수) 배지
 *   · 커뮤니티 피드와 홈 최신글이 **같은 규칙**
 *
 * ⚠️ 이 게이트는 순수함수(resolvePostScope)만 부르지 않는다. 그렇게 하면 컴포넌트가
 * 그 함수를 안 써도(=화면이 안 고쳐져도) GREEN 이 된다 — 2026-08-04 하루에 5건 터진
 * false-green 과 같은 형태다. 그래서 실제 `PhotoFeed`(커뮤니티 피드)를 jsdom 에
 * 마운트해 DOM 텍스트를 읽고, 홈 최신글은 실제 `PostLabel` 경로가 쓰는 컴포넌트
 * (`PostScopeBadge` + `scopeInputForPost`)를 그대로 렌더해 대조한다.
 *
 * 실행: npm run qa:post-scope-label
 * 자체검증: npm run qa:post-scope-label -- --selftest  (결함주입 시 RED 인지 확인)
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

function feedPost(f: Fixture) {
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
    nickname: `유저${f.id}`,
    team_id: 1,
    avatar_url: null,
    grade: "member",
    click_view_count: 0,
    impression_view_count: 0,
  };
}

/**
 * 카드별 `공개범위` 라벨 블록의 칩 텍스트 목록을 공백 1칸으로 이은 문자열.
 * 배지를 여러 개 나열하면 textContent 가 "LG두산KT" 처럼 붙어버려 경계가 안 보인다.
 * 칩 단위로 읽어야 "3팀까지 각 팀 배지" 스펙을 제대로 검증한다.
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

  // TeamBadge 가 useTheme 을 쓰므로 실제 ThemeProvider 로 감싼다(모듈 목킹 금지 — 목킹하면
  // 배지 렌더 경로 자체가 가짜가 돼 false-green 위험).
  const { ThemeProvider } = await import("../../src/components/ThemeProvider");

  const { TEAMS } = await import("../../src/lib/constants/teams");
  const allSlugs = TEAMS.map((t) => t.slug);
  const s = (n: number) => TEAMS.slice(0, n).map((t) => t.slug);
  const shortName = (slug: string) => TEAMS.find((t) => t.slug === slug)!.shortName;

  // ── §1. 실제 커뮤니티 피드(PhotoFeed) 렌더 ────────────────────────────────
  // AuthProvider 없이 렌더한다 — useAuth 는 createContext 기본값(user/profile null)을
  // 반환하므로 비로그인 사용자가 피드를 보는 실제 경로와 같다.
  const PhotoFeed = (await import("../../src/components/community/PhotoFeed")).default;

  const fixtures: { label: string; post: Fixture; expect: string }[] = [
    { label: "10팀 전부 → 전체구단 공개", post: { id: 1, team_tags: allSlugs }, expect: "전체구단 공개" },
    { label: "태그 없음 → 전체구단 공개", post: { id: 2 }, expect: "전체구단 공개" },
    { label: "1팀 → 팀 배지", post: { id: 3, team_tags: s(1) }, expect: shortName(allSlugs[0]) },
    { label: "2팀 → 팀 배지 2개", post: { id: 4, team_tags: s(2) }, expect: s(2).map(shortName).join(" ") },
    { label: "3팀 → 팀 배지 3개(외 n팀 없음)", post: { id: 5, team_tags: s(3) }, expect: s(3).map(shortName).join(" ") },
    { label: "4팀 → 3팀 + 외 1팀", post: { id: 6, team_tags: s(4) }, expect: `${s(3).map(shortName).join(" ")} 외 1팀` },
    { label: "9팀 → 3팀 + 외 6팀", post: { id: 7, team_tags: s(9) }, expect: `${s(3).map(shortName).join(" ")} 외 6팀` },
  ];

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
  ok(
    `§1 피드 카드 수 = ${fixtures.length}`,
    texts.length === fixtures.length,
    `실제 ${texts.length}개`,
  );
  fixtures.forEach((f, i) => {
    ok(`§1 피드 ${f.label}`, texts[i] === f.expect, `기대 "${f.expect}" / 실제 "${texts[i]}"`);
  });

  // 회귀 방지: 이전 라벨 문구가 남아있으면 안 된다.
  const feedHtml = (el as unknown as HTMLElement).innerHTML;
  ok("§1 피드에 옛 '글 소속' 라벨 없음", !feedHtml.includes("글 소속"));

  await act(async () => { root.unmount(); });

  // ── §2. 홈 최신글(compact) 라벨 ──────────────────────────────────────────
  // 홈은 좁아서 팀 배지를 로고만 표기한다 → 텍스트가 아닌 aria-label 로 검증한다.
  const PostScopeBadge = (await import("../../src/components/community/PostScopeBadge")).default;
  const { scopeInputForPost } = await import("../../src/lib/utils/post-scope-input");

  const el2 = document.createElement("div");
  document.body.appendChild(el2);
  const root2 = createRoot(el2);
  await act(async () => {
    root2.render(
      React.createElement(
        ThemeProvider,
        null,
        fixtures.map((f) =>
          React.createElement(
            "div",
            { key: f.post.id, "data-fixture": String(f.post.id) },
            React.createElement(PostScopeBadge as never, {
              post: scopeInputForPost(feedPost(f.post) as never),
              variant: "compact",
            } as never),
          ),
        ),
      ),
    );
  });

  fixtures.forEach((f) => {
    const node = (el2 as unknown as HTMLElement).querySelector(`[data-fixture="${f.post.id}"]`)!;
    const aria = node.querySelector("[aria-label]")?.getAttribute("aria-label");
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    // 다팀은 aria-label, 단일/전체는 텍스트로 검증(compact 에서도 텍스트가 남는다).
    const actual = aria ? aria.replace(/,\s*/g, " ") : text;
    ok(`§2 홈 ${f.label}`, actual === f.expect, `기대 "${f.expect}" / 실제 "${actual}"`);
  });

  await act(async () => { root2.unmount(); });

  // ── §3. 소스 배선 — 홈/피드가 실제로 SSOT 를 통과하는가 ────────────────────
  // (컴포넌트 렌더만 보면 "홈이 아직 옛 resolveLabel 을 쓰는" 회귀를 놓친다.)
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const home = src("src/components/home/CommunityLatestPosts.tsx");
  const feed = src("src/components/community/PhotoFeed.tsx");

  ok("§3 홈이 PostScopeBadge 사용", home.includes("PostScopeBadge"));
  ok("§3 홈이 scopeInputForPost 사용", home.includes("scopeInputForPost"));
  ok("§3 홈에 옛 resolveLabel 없음", !/function\s+resolveLabel/.test(home));
  ok("§3 피드가 PostScopeBadge 사용", feed.includes("PostScopeBadge"));
  ok("§3 피드가 scopeInputForPost 사용", feed.includes("scopeInputForPost"));
  ok("§3 피드가 옛 getPostSourceLabel 미사용", !/getPostSourceLabel\s*\(/.test(feed));

  // ── §4. 작성 화면 — 최소 1팀 태그 필수 + 전체 선택 옵션 ────────────────────
  const tagger = src("src/components/community/TeamTagger.tsx");
  ok("§4 TeamTagger 에 전체 선택 칩", tagger.includes("data-team-select-all"));

  for (const file of [
    "src/components/community/WritePost.tsx",
    "src/components/community/WritePhotoPost.tsx",
    "src/components/community/WritePoll.tsx",
  ]) {
    const body = src(file);
    ok(`§4 ${file.split("/").pop()} 최소1팀 가드`, body.includes("hasTeamScope"));
    ok(`§4 ${file.split("/").pop()} 전체 선택 연결`, body.includes("onSetAll"));
  }

  // ── §5. 결함주입 자체검증 ────────────────────────────────────────────────
  // 게이트가 실제로 결함을 잡는지 확인한다. 여기서 기대 RED 가 안 나오면 게이트는
  // 검출력이 없는 것이므로 통째로 실패시킨다.
  if (SELFTEST) {
    console.log("\n  [selftest] 결함주입 — 아래 항목은 RED 여야 정상");
    const { resolvePostScope } = await import("../../src/lib/utils/post-scope");
    const mutations: { name: string; check: () => boolean }[] = [
      {
        name: "10팀을 9팀으로 줄이면 전체구단이 아님",
        check: () => resolvePostScope({ team_tags: s(9) }).kind !== "all",
      },
      {
        name: "3팀은 overflow 0",
        check: () => {
          const r = resolvePostScope({ team_tags: s(3) });
          return r.kind === "teams" && r.overflow === 0;
        },
      },
      {
        name: "4팀은 shown 3 + overflow 1",
        check: () => {
          const r = resolvePostScope({ team_tags: s(4) });
          return r.kind === "teams" && r.shown.length === 3 && r.overflow === 1;
        },
      },
      {
        // shown 은 teamId 배열이다. 슬러그로 다시 변환해 비교한다.
        name: "선택 순서를 뒤집어도 shown 은 구단 기본 순서",
        check: () => {
          const r = resolvePostScope({ team_tags: [...s(4)].reverse() });
          if (r.kind !== "teams") return false;
          const slugs = r.shown.map((id) => TEAMS.find((t) => t.id === id)!.slug);
          return slugs.join(",") === s(3).join(",");
        },
      },
      {
        name: "태그 0개는 all",
        check: () => resolvePostScope({}).kind === "all",
      },
    ];
    for (const m of mutations) ok(`§5 ${m.name}`, m.check());
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n  실패 항목: ${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
