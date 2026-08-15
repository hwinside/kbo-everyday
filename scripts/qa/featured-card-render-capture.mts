/**
 * 경기탭 카드 실렌더 캡처 (삼순 2026-08-15 최종 GO 조건).
 *
 * 왜 이 방식인가: 리뷰 워크트리의 node_modules 는 메인 체크아웃을 가리키는 심볼릭 링크라
 * `next dev` 가 기동을 거부하고(Symlink node_modules is invalid), Vercel Preview 는 SSO 로 막혀
 * 있다. 그래서 **실제 CompactGameCard 를 SSR 로 렌더 + 실제 globals.css 를 Tailwind 로 컴파일**해
 * 브라우저에 띄우고 Playwright 로 캡처한다. 목업 HTML 이 아니라 production 컴포넌트/CSS 다.
 *
 * 캡처 축:
 *  - light / dark × KT(어두운 팀색) / 한화(가장 밝은 팀색) × 320 / 390  = 8장
 *  - 각 장에 featured(마이팀) 카드 + 일반 카드를 live/final/cancelled/scheduled 로 전부 담고,
 *    `12 : 10` 두 자리 점수, 긴 선발·투타명, lastPlay 유/무를 함께 넣어 오버플로를 본다.
 *
 * 산출물: state/games-card-render/<mode>-<team>-<width>.png + 정렬/오버플로 측정 JSON
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(ROOT, "state/games-card-render");

type Row = { label: string; game: Record<string, unknown>; featured?: boolean; myTeamId?: number };

const RUNNERS_NONE = { first: false, second: false, third: false };

function rows(teamId: number): Row[] {
  return [
    {
      label: "featured · live · 두자리점수 · 긴이름 · lastPlay 有",
      featured: true,
      myTeamId: teamId,
      game: {
        id: "20260815AAAA0", awayTeamId: 4, homeTeamId: teamId, time: "18:30", stadium: "고척스카이돔",
        status: "live", inning: "7회초", awayScore: 12, homeScore: 10,
        liveDetailFromKbo: true, balls: 3, strikes: 2, outs: 1,
        runnersOn: { first: true, second: false, third: true },
        currentPitcher: "김민우준", currentBatter: "에르난데스",
        awayStarterName: "알칸타라", homeStarterName: "후라도",
        lastPlay: "2사 만루에서 좌중간을 가르는 2루타로 주자 두 명이 홈을 밟았습니다",
      },
    },
    {
      label: "featured · live · lastPlay 無 · 상세 degrade(준비 중)",
      featured: true,
      myTeamId: teamId,
      game: {
        id: "20260815BBBB0", awayTeamId: 2, homeTeamId: teamId, time: "18:30", stadium: "잠실",
        status: "live", inning: "3회말", awayScore: 1, homeScore: 0,
        liveDetailFromKbo: false, balls: 0, strikes: 0, outs: 0, runnersOn: RUNNERS_NONE,
        currentPitcher: "", currentBatter: "",
      },
    },
    {
      label: "featured · final · 12 : 10",
      featured: true, myTeamId: teamId,
      game: {
        id: "20260815CCCC0", awayTeamId: 6, homeTeamId: teamId, time: "17:00", stadium: "사직",
        status: "final", inning: "", awayScore: 12, homeScore: 10, runnersOn: RUNNERS_NONE,
        winPitcher: "원태인", losePitcher: "곽빈",
      },
    },
    {
      label: "featured · cancelled",
      featured: true, myTeamId: teamId,
      game: {
        id: "20260815DDDD0", awayTeamId: 7, homeTeamId: teamId, time: "18:30", stadium: "대전한화생명볼파크",
        status: "cancelled", inning: "", awayScore: null, homeScore: null, runnersOn: RUNNERS_NONE,
      },
    },
    {
      label: "featured · scheduled · 긴 선발명",
      featured: true, myTeamId: teamId,
      game: {
        id: "20260815EEEE0", awayTeamId: 9, homeTeamId: teamId, time: "18:30", stadium: "인천SSG랜더스필드",
        status: "scheduled", inning: "", awayScore: null, homeScore: null, runnersOn: RUNNERS_NONE,
        awayStarterName: "네일에르난데스", homeStarterName: "폰세알칸타라",
      },
    },
    // 일반(비 featured) 카드 — 팀컬러가 붙지 않아야 한다(하린아빠 "팀컬러는 맨 위 마이팀만").
    {
      label: "일반 · live · 상세 있음",
      game: {
        id: "20260815FFFF0", awayTeamId: 3, homeTeamId: 8, time: "18:30", stadium: "창원NC파크",
        status: "live", inning: "9회말", awayScore: 5, homeScore: 5,
        liveDetailFromKbo: true, balls: 2, strikes: 2, outs: 2,
        runnersOn: { first: true, second: true, third: true },
        currentPitcher: "고우석", currentBatter: "김도영",
        lastPlay: "볼넷으로 만루 상황이 됐습니다",
      },
    },
    {
      label: "일반 · final",
      game: {
        id: "20260815GGGG0", awayTeamId: 5, homeTeamId: 10, time: "14:00", stadium: "수원KT위즈파크",
        status: "final", inning: "", awayScore: 3, homeScore: 7, runnersOn: RUNNERS_NONE,
      },
    },
    {
      label: "일반 · scheduled",
      game: {
        id: "20260815HHHH0", awayTeamId: 1, homeTeamId: 9, time: "18:30", stadium: "광주기아챔피언스필드",
        status: "scheduled", inning: "", awayScore: null, homeScore: null, runnersOn: RUNNERS_NONE,
      },
    },
  ];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { default: Card } = await import("@/components/game/CompactGameCard");

  // ── 실제 globals.css 를 Tailwind 로 컴파일 (목업 CSS 아님)
  const postcss = (await import("postcss")).default;
  const tw = (await import("@tailwindcss/postcss")).default;
  const cssSrc = readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8");

  const TEAMS: Array<{ id: number; key: string; label: string }> = [
    { id: 5, key: "kt", label: "KT(어두운 팀색)" },
    { id: 7, key: "hanwha", label: "한화(가장 밝은 팀색)" },
  ];
  const WIDTHS = [320, 390];
  const MODES: Array<"light" | "dark"> = ["light", "dark"];

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const measurements: Record<string, unknown> = {};

  try {
    for (const team of TEAMS) {
      const body = rows(team.id)
        .map((r) => {
          const html = renderToStaticMarkup(
            React.createElement(Card, {
              game: r.game, featured: r.featured, myTeamId: r.myTeamId,
            } as never),
          );
          return `<div class="cap-row"><div class="cap-label">${r.label}</div>${html}</div>`;
        })
        .join("\n");

      // Tailwind v4 는 소스 스캔이 필요하다 — 생성된 마크업을 @source 로 직접 물린다.
      const scanFile = resolve(OUT, `_scan-${team.key}.html`);
      writeFileSync(scanFile, body, "utf8");
      const compiled = await postcss([tw()]).process(
        `@source "${scanFile}";\n@source "${resolve(ROOT, "src/components/game/CompactGameCard.tsx")}";\n${cssSrc}`,
        { from: resolve(ROOT, "src/styles/globals.css") },
      );

      for (const mode of MODES) {
        const page = `<!doctype html><html class="${mode === "dark" ? "dark" : ""}"><head><meta charset="utf-8">
<style>${compiled.css}</style>
<style>
  body { margin:0; padding:8px; background: var(--bg-primary, ${mode === "dark" ? "#0A0A0B" : "#FFFFFF"}); }
  .cap-row { margin-bottom: 10px; }
  .cap-label { font-size: 9px; opacity: .55; margin-bottom: 3px; font-family: system-ui; color: var(--text-primary); }
</style></head><body>${body}</body></html>`;

        for (const width of WIDTHS) {
          const file = resolve(OUT, `${mode}-${team.key}-${width}.png`);
          const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
          await p.setContent(page, { waitUntil: "load" });
          await p.screenshot({ path: file, fullPage: true });

          // 정렬·오버플로 실측: 카드별 로고 x, 스코어 중심, 가로 overflow
          const m = await p.evaluate(() => {
            const out: Array<Record<string, number | string | boolean>> = [];
            document.querySelectorAll(".cap-row").forEach((row) => {
              const label = row.querySelector(".cap-label")?.textContent ?? "";
              const imgs = [...row.querySelectorAll("img")].filter((i) => (i as HTMLImageElement).width > 0);
              const logos = imgs.map((i) => Math.round(i.getBoundingClientRect().left));
              // 카드 루트는 Link(a) 안의 rounded-xl 박스다.
              // ⚠︎ `div > div` 로 잡으면 캘처 라벨(.cap-label)이 먼저 매치되어
              //   높이 14px 짜리 라벨을 카드로 측정하게 된다(오버플로 0 · gap -1 의 false-green 원인).
              const card = row.querySelector("a div.rounded-xl") as HTMLElement | null;
              if (!card) throw new Error(`카드 루트(a div.rounded-xl)를 못 찾음 :: ${label}`);
              const overflow = card.scrollWidth - card.clientWidth;
              // 구장명(행1 마지막 span) 오버플로 실측 — 시각 검수가 320px 에서
              // "인천SSG랜더스필드가 우측과 거의 닿는다"고 지적한 축이다.
              // whitespace-nowrap 이라 잘리는 대신 이웃을 밀거나 패딩을 침범할 수 있다.
              const row1 = card.querySelector("div.flex.items-center") as HTMLElement | null;
              const spans = row1 ? [...row1.querySelectorAll(":scope > span")] : [];
              const stadium = spans[spans.length - 1] as HTMLElement | undefined;
              if (!stadium) throw new Error(`구장명 span 을 못 찾음 :: ${label}`);
              let stadiumGapRight = -1;
              let stadiumGapLeft = -1;
              let stadiumClipped = false;
              {
                const s = stadium.getBoundingClientRect();
                const cr = card.getBoundingClientRect();
                const padRight = parseFloat(getComputedStyle(card).paddingRight) || 0;
                // 반올림하지 않는다 — 서브픽셀 0.5px 를 Math.round 하면 멀줦한 레이아웃이
                // 일괄 -1px 로 찍혀 전수 false-RED 가 된다(실측 확인됨).
                stadiumGapRight = Number((cr.right - padRight - s.right).toFixed(2));
                const prev = stadium.previousElementSibling as HTMLElement | null;
                stadiumGapLeft = prev ? Math.round(s.left - prev.getBoundingClientRect().right) : 999;
                stadiumClipped = stadium.scrollWidth - stadium.clientWidth > 1;
              }
              out.push({
                label,
                logoLeft: logos.length ? logos[logos.length >= 2 ? logos.length - 2 : 0] : -1,
                logoRight: logos.length >= 2 ? logos[logos.length - 1] : -1,
                overflowPx: overflow,
                heightPx: Math.round(card.getBoundingClientRect().height),
                stadiumText: stadium.textContent ?? "",
                stadiumGapRight,
                stadiumGapLeft,
                stadiumClipped,
              });
            });
            return out;
          });
          measurements[`${mode}-${team.key}-${width}`] = m;
          await p.close();
          console.log(`  saved ${mode}-${team.key}-${width}.png`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(resolve(OUT, "measurements.json"), JSON.stringify(measurements, null, 2), "utf8");

  // 판정: 가로 오버플로 0 · 로고 x 좌표 수렴 · 구장명 잘림/간격
  let bad = 0;
  for (const [k, v] of Object.entries(measurements)) {
    const list = v as Array<Record<string, number | string | boolean>>;
    for (const r of list) {
      if ((r.overflowPx as number) > 0) { console.error(`  ❌ overflow ${k} :: ${r.label} = ${r.overflowPx}px`); bad++; }
      if (r.stadiumClipped === true) { console.error(`  ❌ 구장명 잘림 ${k} :: ${r.label}`); bad++; }
      const gapL = r.stadiumGapLeft as number;
      if (typeof gapL === "number" && gapL >= 0 && gapL < 4) {
        console.error(`  ❌ 구장명 앞 요소와 간격 부족 ${k} :: ${r.label} = ${gapL}px`); bad++;
      }
      const gapR = r.stadiumGapRight as number;
      // 서브픽셀 렌더링 오차를 감안해 -1px 미만만 침범으로 본다(1px 이내는 육안 무변별).
      if (typeof gapR === "number" && gapR < -1) {
        console.error(`  ❌ 구장명이 카드 우측 패딩 침범 ${k} :: ${r.label} = ${gapR}px`); bad++;
      }
    }
    // 로고 x 좌표는 카드가 달라도 단일 값으로 수렴해야 한다(하린아빠 "정확히 align").
    for (const key of ["logoLeft", "logoRight"] as const) {
      const set = [...new Set(list.map((r) => r[key]).filter((x) => (x as number) >= 0))];
      if (set.length > 1) { console.error(`  ❌ ${key} 미정렬 ${k} :: ${set.join(",")}`); bad++; }
    }
  }
  console.log(bad === 0
    ? "\n✓ 오버플로 0 · 로고 x 수렴 · 구장명 잘림/간격 이상 없음 — 전 8조합"
    : `\n✗ 결함 ${bad}건`);
  if (bad > 0) process.exit(1);
}

main().catch((e) => { console.error("✗ ERROR:", e); process.exit(1); });
