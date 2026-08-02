/**
 * MY TEAM "다음 경기" 카드 — 날짜 오독 방지 회귀 (실제 GamesPage 를 렌더).
 *
 * 배경(2026-08-03 하린아빠 제보): 경기탭에서 오늘을 보고 있는데 최애팀 경기가 없으면
 * 14일 이내 다음 경기를 오늘 화면에 얹어 보여준다. 그런데 카드 배지에는 `18:30`만
 * 있어서 "오늘 18:30 경기"로 읽혔다. 헤더의 회색 작은 글씨만으로는 오독을 못 막는다.
 *
 * ⚠️ 이 스크립트의 1차 판본은 false-green 이었다(삼순 NO-GO 2026-08-03).
 * `CompactGameCard` 에 `dateStr` 를 직접 주입해 렌더했을 뿐이라, 정작 결함 지점인
 * `games/page.tsx` 의 `dateStr={nextMyGame.dateStr}` 배선과 `오늘 … 경기가 없습니다`
 * 안내를 지워도 그대로 통과했다. 카드가 prop 을 받으면 잘 그리는지는 이 사고와 무관하다.
 *
 * 그래서 이 판본은 **페이지를 통째로 렌더**한다:
 *   - `/api/games` 를 stub 해 "오늘 0건 · 내일 최애팀 경기 있음" 상황을 만들고
 *   - `localStorage['kbo-my-team']` 으로 실제 최애팀 경로를 태우고
 *   - 페이지가 스스로 다음 경기를 스캔·렌더한 DOM 을 검사한다.
 * 따라서 page.tsx 의 배선을 제거하면 RED 가 된다.
 *
 * 실행: npm run qa:next-game-date-badge
 */
import { JSDOM } from "jsdom";

// 페이지 트리가 supabase 브라우저 클라이언트를 import 한다(모듈 로드 시점 생성).
// 이 테스트는 네트워크를 타지 않고 fetch 를 stub 하므로 플레이스홀더 값이면 충분하다.
// (실제 키를 요구하면 CI 게이트로 쓸 수 없다.)
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "qa-anon-key";

// React 의 `act` 는 **development 번들에만** 존재한다(react package.json 의 조건부
// exports). Vercel prebuild 는 NODE_ENV=production 이라 production 번들이 로드돼
// `act is not a function` 으로 죽었다(2026-08-03 실측). 로컬에서만 통과하는 게이트는
// 게이트가 아니므로, 이 하네스는 어디서 돌든 development React 를 쓰도록 고정한다.
// (import 보다 먼저 세팅돼야 조건부 export 해석에 반영된다.)
process.env.NODE_ENV = "development";

// ── jsdom 환경 ──────────────────────────────────────────────────────────────
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
  "IntersectionObserver", "ResizeObserver", "matchMedia",
]) {
  g[k] = win[k];
}
g.self = win;
(win as Record<string, unknown>).requestIdleCallback ??= (cb: () => void) =>
  (win.setTimeout as (f: () => void, t: number) => number)(cb, 0);
(win as Record<string, unknown>).cancelIdleCallback ??= () => {};
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// framer-motion 이 참조
(win as Record<string, unknown>).matchMedia ??= () => ({
  matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, media: "", dispatchEvent: () => false,
});
g.matchMedia = (win as Record<string, unknown>).matchMedia;
class NoopObserver {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
g.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
g.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
// jsdom 미구현 — DateSelector 가 선택 칩을 가운데로 스크롤한다.
const proto = (win.HTMLElement as { prototype: Record<string, unknown> }).prototype;
proto.scrollIntoView ??= function scrollIntoView() {};
proto.scrollTo ??= function scrollTo() {};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 고정 시나리오 ───────────────────────────────────────────────────────────
// 오늘(KST) 은 실행일마다 달라지므로 페이지가 쓰는 getKSTToday 와 같은 방식으로 계산한다.
//
// ⚠️ 이전 판본은 D+1 에 정상 경기 1건만 놓아서 페이지의 취소 제외 필터를 아예 태우지
// 못했다(삼순 NO-GO 2026-08-03: `g.status !== "cancelled"` 를 지워도 10/10 GREEN).
// 그래서 fixture 를 "D+1 = 최애팀 **취소** 경기 / D+2 = 최애팀 정상 경기" 로 바꿔,
// 필터가 없으면 D+1 취소 경기를 집어 날짜·링크가 틀리도록 경계를 실제로 태운다.
const MY_TEAM_ID = 1; // LG
const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
const TODAY = kstNow.toISOString().slice(0, 10);
/** D+1 — 최애팀 경기가 있지만 **취소**. 선택되면 안 된다. */
const CANCELLED_DATE = new Date(kstNow.getTime() + 24 * 60 * 60 * 1000)
  .toISOString().slice(0, 10);
/** D+2 — 최애팀 정상 경기. 이것이 카드에 떠야 한다. */
const NEXT_DATE = new Date(kstNow.getTime() + 2 * 24 * 60 * 60 * 1000)
  .toISOString().slice(0, 10);
const NEXT_GAME_ID = `${NEXT_DATE.replace(/-/g, "")}LGSK0`;
const CANCELLED_GAME_ID = `${CANCELLED_DATE.replace(/-/g, "")}LGOB0`;
const compact = (iso: string) => iso.replace(/-/g, "");

/** 페이지가 기대하는 요일 표기(월/일(요일)) — 요일 off-by-one 을 잡기 위해 독립 계산. */
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
const badgeDateOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}(${WEEKDAY[new Date(y, m - 1, d).getDay()]})`;
};
const EXPECTED_BADGE_DATE = badgeDateOf(NEXT_DATE);
const CANCELLED_BADGE_DATE = badgeDateOf(CANCELLED_DATE);

const NEXT_GAME_PAYLOAD = {
  gameId: NEXT_GAME_ID,
  awayTeamId: MY_TEAM_ID,
  homeTeamId: 4,
  awayScore: null,
  homeScore: null,
  status: "scheduled",
  time: "18:30",
  stadium: "문학",
};
/** D+1 최애팀 취소 경기 — 취소 제외 필터가 없으면 이게 잡혀 D+2 대신 노출된다. */
const CANCELLED_GAME_PAYLOAD = {
  gameId: CANCELLED_GAME_ID,
  awayTeamId: MY_TEAM_ID,
  homeTeamId: 2,
  awayScore: null,
  homeScore: null,
  status: "cancelled",
  time: "18:30",
  stadium: "잠실",
};
/** 오늘 열리는 타팀 경기 — "오늘 카드에 날짜가 새면 안 된다" 검증용. */
const TODAY_OTHER_GAME = {
  gameId: `${compact(TODAY)}NCKT0`,
  awayTeamId: 5,
  homeTeamId: 3,
  awayScore: null,
  homeScore: null,
  status: "scheduled",
  time: "18:30",
  stadium: "수원",
};

function installFetchStub() {
  const calls: string[] = [];
  g.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) => ({
      ok: true, status: 200, json: async () => body,
    }) as unknown as Response;
    if (url.includes("/api/games")) {
      const m = url.match(/date=(\d{8})/);
      const date = m?.[1] ?? "";
      if (date === compact(TODAY)) return json({ games: [TODAY_OTHER_GAME] });
      if (date === compact(CANCELLED_DATE)) return json({ games: [CANCELLED_GAME_PAYLOAD] });
      if (date === compact(NEXT_DATE)) return json({ games: [NEXT_GAME_PAYLOAD] });
      return json({ games: [] });
    }
    if (url.includes("/api/weather")) return json({ stadiums: {} });
    return json({});
  }) as typeof fetch;
  return calls;
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  // next/navigation 훅(useSafeBack → useRouter)과 next/link 는 App Router 컨텍스트가
  // 마운트돼 있어야 동작한다. 모듈을 몸25패치하는 대신 실제 Provider 로 감싼다
  // (모듈을 가짜로 바꾸면 링크 렌더 경로까지 가짜가 돼 false-green 위험이 생긴다).
  const pushed: string[] = [];
  const { AppRouterContext } = (await import(
    "next/dist/shared/lib/app-router-context.shared-runtime"
  )) as unknown as { AppRouterContext: React.Context<unknown> };
  const routerValue = {
    push: (href: string) => { pushed.push(href); },
    replace: (href: string) => { pushed.push(href); },
    back: () => {}, forward: () => {}, refresh: () => {},
    prefetch: () => {},
  };

  installFetchStub();
  localStorage.setItem("kbo-my-team", String(MY_TEAM_ID));

  const GamesPage = (await import("../../src/app/(main)/games/page")).default;

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: routerValue },
        React.createElement(GamesPage),
      ),
    );
  });
  // 다음 경기 스캔은 오늘 로드 완료 후 시작되는 비동기 루프 — settle 대기.
  for (let i = 0; i < 40; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    if (el.textContent?.includes(EXPECTED_BADGE_DATE)) break;
  }

  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();

  // ── 1) 핵심: page.tsx 가 안내 문구를 렌더한다 ─────────────────────────────
  ok(
    "오늘 경기 없음 안내 노출(팀명 포함)",
    /오늘 LG ?경기가 없습니다/.test(text),
    `text="${text.slice(0, 200)}"`,
  );

  // ── 2) 핵심: page.tsx 가 dateStr 을 카드로 배선해 배지에 날짜가 찍힌다 ────
  const badges = [...el.querySelectorAll("span.rounded-full")].map(
    (n) => (n.textContent ?? "").trim(),
  );
  const dateBadge = badges.find((b) => b.includes(EXPECTED_BADGE_DATE));
  ok(
    `다음 경기 카드 배지에 날짜(${EXPECTED_BADGE_DATE}) 포함`,
    dateBadge != null,
    `badges=${JSON.stringify(badges)}`,
  );

  // ── 취소 경계: D+1 취소 경기를 건너뛰고 D+2 를 고른다 ──────────────
  // 페이지의 `g.status !== "cancelled"` 가 없어지면 D+1 취소 경기가 잡혀
  // 이 두 assert 가 동시에 깨진다(삼순 NO-GO 보완).
  ok(
    `취소된 D+1 경기(${CANCELLED_BADGE_DATE})를 선택하지 않음`,
    !badges.some((b) => b.includes(CANCELLED_BADGE_DATE)),
    `badges=${JSON.stringify(badges)}`,
  );
  ok(
    "취소 경기 id 가 화면에 등장하지 않음",
    !el.innerHTML.includes(CANCELLED_GAME_ID),
    `cancelledId=${CANCELLED_GAME_ID}`,
  );
  ok(
    "다음 경기 배지에 시간 유지",
    dateBadge?.includes("18:30") === true,
    `badge="${dateBadge}"`,
  );

  // ── 3) 회귀 방지: 오늘 열리는 다른 경기 카드는 날짜가 새면 안 된다 ────────
  const dateBadgeCount = badges.filter((b) => /\d+\/\d+\([일월화수목금토]\)/.test(b)).length;
  ok(
    "날짜 배지는 다음 경기 카드에만(오늘 카드 무오염)",
    dateBadgeCount === 1,
    `badges=${JSON.stringify(badges)}`,
  );
  ok(
    "오늘 타팀 경기 카드는 시간 배지 유지",
    badges.some((b) => b === "18:30"),
    `badges=${JSON.stringify(badges)}`,
  );

  // ── 4) 카드 클릭이 다음 경기 id 로 이동 ───────────────────────────────────
  const cardEl = dateBadge
    ? [...el.querySelectorAll("span.rounded-full")]
        .find((n) => (n.textContent ?? "").includes(EXPECTED_BADGE_DATE))
        ?.closest("a,button,[role='button'],div[class*='cursor']")
    : null;
  const href = cardEl?.getAttribute?.("href") ?? null;
  if (href) {
    ok("다음 경기 카드 링크가 해당 경기 id", href.includes(NEXT_GAME_ID), `href=${href}`);
  } else {
    (cardEl as HTMLElement | null)?.click?.();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    ok(
      "다음 경기 카드 클릭이 해당 경기로 이동",
      pushed.some((p) => p.includes(NEXT_GAME_ID)),
      `pushed=${JSON.stringify(pushed)}`,
    );
  }

  await act(async () => { root.unmount(); });
  el.remove();

  // ── 5) 순수 표기 계약(CompactGameCard 단위) ───────────────────────────────
  // 페이지 경로와 별개로 카드 자체의 상태 배지 우선순위·요일 계산도 잠근다.
  const CompactGameCard = (await import("../../src/components/game/CompactGameCard")).default;
  async function badgeOf(opts: {
    status: "scheduled" | "live" | "final" | "cancelled";
    time: string;
    dateStr?: string;
    inning?: string;
  }) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => {
      r.render(
        React.createElement(CompactGameCard, {
          dateStr: opts.dateStr,
          myTeamId: MY_TEAM_ID,
          game: {
            id: "20260804LGSK0",
            awayTeamId: MY_TEAM_ID,
            homeTeamId: 4,
            awayScore: opts.status === "final" ? 3 : null,
            homeScore: opts.status === "final" ? 5 : null,
            status: opts.status,
            inning: opts.inning,
            time: opts.time,
            stadium: "문학",
          },
        }),
      );
    });
    const badge = (host.querySelector("span.rounded-full")?.textContent ?? "").trim();
    await act(async () => { r.unmount(); });
    host.remove();
    return badge;
  }

  const live = await badgeOf({ status: "live", time: "18:30", inning: "5회초", dateStr: "2026-08-04" });
  ok("LIVE 배지 유지(날짜가 상태를 덮지 않음)", live.startsWith("LIVE") && !live.includes("8/4"), `badge="${live}"`);
  const finalG = await badgeOf({ status: "final", time: "18:30", dateStr: "2026-08-04" });
  ok("종료 배지 유지", finalG === "종료", `badge="${finalG}"`);
  const cancelled = await badgeOf({ status: "cancelled", time: "18:30", dateStr: "2026-08-04" });
  ok("취소 배지 유지", cancelled === "취소", `badge="${cancelled}"`);
  // 2027-03-07 은 일요일 — zero-pad 없이 한 자리 월/일.
  const single = await badgeOf({ status: "scheduled", time: "14:00", dateStr: "2027-03-07" });
  ok("한 자리 월/일 표기", single.includes("3/7(일)"), `badge="${single}"`);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
