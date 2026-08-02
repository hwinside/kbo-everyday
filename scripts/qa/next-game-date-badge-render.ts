/**
 * MY TEAM "다음 경기" 카드 — 날짜 오독 방지 회귀 (실제 CompactGameCard 렌더).
 *
 * 배경(2026-08-03 하린아빠 제보): 경기탭에서 8/3(월)을 보고 있는데 최애팀 경기가 없으면
 * 14일 이내 다음 경기(8/4)를 오늘 화면에 얹어 보여준다. 그런데 카드 배지에는 `18:30`만
 * 있어서 "월요일 18:30 경기"로 읽혔다. 헤더의 회색 작은 글씨만으로는 오독을 못 막는다.
 *
 * 그래서 다른 날짜 경기를 얹을 때는 `dateStr` prop 으로 **카드 배지 안에** 날짜를 찍는다.
 * 이 테스트는 진짜 CompactGameCard 를 jsdom 에 렌더해 실제 DOM 텍스트를 검사하므로,
 * 아래 결함주입이 전부 RED 가 된다:
 *   - dateStr 을 배지에 안 찍으면(원복) → "8/4(화)" 없음으로 실패
 *   - dateStr 없는 오늘 경기 카드에 날짜가 새면 → 오늘 카드 오염으로 실패
 *   - live/final/cancelled 가 dateStr 때문에 상태 배지를 잃으면 → 실패
 *   - 요일 계산이 틀리면(off-by-one) → 실패
 * 실행: npm run qa:next-game-date-badge
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, { pretendToBeVisual: true, url: "http://localhost/" });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "navigator", "HTMLElement", "Element", "Node",
  "Event", "MouseEvent", "SVGElement", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage",
  "IntersectionObserver",
]) {
  g[k] = win[k];
}
// next/image 의 use-intersection 이 self.requestIdleCallback 을 참조한다(jsdom 미제공).
g.self = win;
(win as Record<string, unknown>).requestIdleCallback ??= (cb: () => void) => win.setTimeout && (win.setTimeout as (f: () => void, t: number) => number)(cb, 0);
(win as Record<string, unknown>).cancelIdleCallback ??= () => {};
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Status = "scheduled" | "live" | "final" | "cancelled";

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const CompactGameCard = (await import("../../src/components/game/CompactGameCard")).default;

  /** 실제 카드를 렌더하고 상태 배지(첫 pill span)의 텍스트를 돌려준다. */
  async function badgeTextOf(opts: {
    status: Status;
    time: string;
    dateStr?: string;
    inning?: string;
  }): Promise<{ badge: string; whole: string }> {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        React.createElement(CompactGameCard, {
          dateStr: opts.dateStr,
          myTeamId: 1,
          game: {
            id: "20260804LGSK0",
            awayTeamId: 1,
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
    // 배지는 rounded-full pill span 중 첫 번째
    const pill = el.querySelector("span.rounded-full");
    const badge = (pill?.textContent ?? "").trim();
    const whole = (el.textContent ?? "").trim();
    await act(async () => { root.unmount(); });
    el.remove();
    return { badge, whole };
  }

  // ── 1) 핵심: 다른 날짜 경기를 얹을 때 배지에 날짜가 찍힌다 ────────────────
  // 2026-08-04 는 화요일. 요일 계산이 틀리면 여기서 잡힌다.
  const next = await badgeTextOf({ status: "scheduled", time: "18:30", dateStr: "2026-08-04" });
  ok("다음 경기 카드 배지에 날짜 포함", next.badge.includes("8/4"), `badge="${next.badge}"`);
  ok("다음 경기 카드 배지에 요일(화) 포함", next.badge.includes("(화)"), `badge="${next.badge}"`);
  ok("다음 경기 카드 배지에 시간 유지", next.badge.includes("18:30"), `badge="${next.badge}"`);

  // ── 2) 회귀 방지: 오늘 경기 카드(dateStr 없음)는 날짜가 새면 안 된다 ──────
  const today = await badgeTextOf({ status: "scheduled", time: "18:30" });
  ok("오늘 경기 카드 배지는 시간만", today.badge === "18:30", `badge="${today.badge}"`);
  ok("오늘 경기 카드에 날짜 미노출", !/\d+\/\d+\(/.test(today.badge), `badge="${today.badge}"`);

  // ── 3) 상태 배지 우선순위: dateStr 이 있어도 상태 표기를 덮지 않는다 ──────
  const live = await badgeTextOf({ status: "live", time: "18:30", inning: "5회초", dateStr: "2026-08-04" });
  ok("LIVE 배지 유지", live.badge.startsWith("LIVE"), `badge="${live.badge}"`);
  ok("LIVE 배지에 날짜 미혼입", !live.badge.includes("8/4"), `badge="${live.badge}"`);

  const finalG = await badgeTextOf({ status: "final", time: "18:30", dateStr: "2026-08-04" });
  ok("종료 배지 유지", finalG.badge === "종료", `badge="${finalG.badge}"`);

  const cancelled = await badgeTextOf({ status: "cancelled", time: "18:30", dateStr: "2026-08-04" });
  ok("취소 배지 유지", cancelled.badge === "취소", `badge="${cancelled.badge}"`);

  // ── 4) 월/일 경계: 한 자리 월·일도 그대로 (zero-pad 아님) ────────────────
  // 2027-03-07 은 일요일.
  const single = await badgeTextOf({ status: "scheduled", time: "14:00", dateStr: "2027-03-07" });
  ok("한 자리 월/일 표기", single.badge.includes("3/7(일)"), `badge="${single.badge}"`);

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
