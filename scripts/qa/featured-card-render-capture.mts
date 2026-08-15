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
/** 본문 텍스트 AA 기준. 카드 전경은 9.5~20px 로 large 예외(3:1) 적용 대상이 아니다. */
const AA_TEXT = 4.5;
/**
 * fixture 가 의도한 문자열이 실제 카드에 렌더되는지 고정한다.
 * 직전까지 fixture 가 awayStarterName 을 썼는데 카드는 awayStarter 를 읽어
 * "긴 선발명 검증"이 실제로는 '미정' 렌더를 캡처하고 있었다(삼순 P1).
 */
const EXPECT_TEXT: Record<string, string[]> = {
  "featured · live · 두자리점수 · 긴이름 · lastPlay 有": ["12", "10", "에르난데스", "김민우준"],
  "featured · live · lastPlay 無 · 상세 degrade(준비 중)": ["실시간 상세 준비 중"],
  "featured · final · 12 : 10": ["12", "10", "종료"],
  "featured · cancelled": ["취소"],
  "featured · scheduled · 긴 선발명": ["네일에르난데스", "폰세알칸타라"],
};

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
        // ⚠︎ 카드가 읽는 필드는 awayStarter/homeStarter 다. 직전까지 API 필드명인
        // awayStarterName 을 써서 긴 선발명이 실제로는 '미정'으로 렌더됐다(삼순 P1).
        awayStarter: "알칸타라", homeStarter: "후라도",
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
        awayStarter: "네일에르난데스", homeStarter: "폰세알칸타라",
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
  const teams = await import("@/lib/constants/teams");

  // ⚠︎ 팀 id 를 상수로 박지 않는다 — 직전까지 id:5=KT, id:7=한화 로 추정해 박았다가
  // 실제로는 5=NC·7=롯데를 캡처해 "KT/한화 8장"이 거짓이 됐다(삼순 P1).
  // production 상수에서 logoPath slug 로 찾고, 찾은 팀의 신원을 assert 한다.
  const bySlug = (slug: string, expectShortName: string) => {
    const t = teams.TEAMS.find((x: { logoPath: string }) => x.logoPath === `/logos/${slug}.svg`);
    if (!t) throw new Error(`팀 미발견: /logos/${slug}.svg`);
    if (t.shortName !== expectShortName) {
      throw new Error(`팀 신원 불일치: ${slug} → ${t.shortName} (기대 ${expectShortName})`);
    }
    return t;
  };
  const ktTeam = bySlug("kt", "KT");
  const hanwhaTeam = bySlug("hanwha", "한화");
  // 대비 극단값 검증: KT 는 가장 어두운(#000000), 한화는 가장 밝은(#FF6600) 팀색이어야 한다.
  const lumOf = (h: string) => {
    const [r, g2, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
  };
  const lums = teams.TEAMS.map((t: { colorPrimary: string }) => lumOf(t.colorPrimary));
  if (Math.abs(lumOf(ktTeam.colorPrimary) - Math.min(...lums)) > 1e-9) throw new Error("KT 가 최암 팀색이 아니다");
  if (Math.abs(lumOf(hanwhaTeam.colorPrimary) - Math.max(...lums)) > 1e-9) throw new Error("한화가 최명 팀색이 아니다");
  console.log(`  팀 신원 확인: KT id=${ktTeam.id} ${ktTeam.colorPrimary}(최암) · 한화 id=${hanwhaTeam.id} ${hanwhaTeam.colorPrimary}(최명)`);

  const TEAMS: Array<{ id: number; key: string; label: string }> = [
    { id: ktTeam.id, key: "kt", label: `KT(어두운 팀색 ${ktTeam.colorPrimary})` },
    { id: hanwhaTeam.id, key: "hanwha", label: `한화(가장 밝은 팀색 ${hanwhaTeam.colorPrimary})` },
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
        const pageHtml = `<!doctype html><html class="${mode === "dark" ? "dark" : ""}"><head><meta charset="utf-8">
<style>${compiled.css}</style>
<style>
  body { margin:0; padding:8px; background: var(--bg-primary, ${mode === "dark" ? "#0A0A0B" : "#FFFFFF"}); }
  .cap-row { margin-bottom: 10px; }
  .cap-label { font-size: 9px; opacity: .55; margin-bottom: 3px; font-family: system-ui; color: var(--text-primary); }
</style></head><body>${body}</body></html>`;

        // 로고는 root-relative(/logos/*.svg) 라 setContent 문서에는 base URL 이 없어
        // 네트워크 요청 자체가 안 나간다 → 좌표만 맞고 그림은 빈 칸(naturalWidth=0).
        // public/ 의 실제 SVG 를 data URI 로 인라인해 진짜 자산이 그려지게 한다.
        const pageWithLogos = pageHtml.replace(/\/logos\/([\w-]+\.svg)/g, (whole, name: string) => {
          try {
            const svg = readFileSync(resolve(ROOT, "public/logos", name));
            return `data:image/svg+xml;base64,${svg.toString("base64")}`;
          } catch {
            return whole;
          }
        });

        for (const width of WIDTHS) {
          const file = resolve(OUT, `${mode}-${team.key}-${width}.png`);
          const p = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
          await p.setContent(pageWithLogos, { waitUntil: "load" });
          // 로고 디코딩 완료까지 기다린다(naturalWidth 가 0 이면 측정 무의미).
          await p.evaluate("Promise.all([...document.images].map(i => i.complete ? null : i.decode().catch(() => null)))");
          await p.screenshot({ path: file, fullPage: true });

          // 정렬·오버플로 실측: 카드별 로고 x, 스코어 중심, 가로 overflow
          // tsx(esbuild) 는 keepNames 때문에 함수 선언을 __name(...) 으로 감싸서 내보낸다.
          // 그 헬퍼는 Node 쪽에만 있고 브라우저 컨텍스트에는 없어 evaluate 가 ReferenceError 로 죽는다.
          // 문자열 evaluate 는 컴파일되지 않으므로 이걸로 shim 을 먼저 심는다.
          await p.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; }");
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
              // ── 색·대비를 geometry 와 함께 재다(삼순 P1: geometry 만 재면
              //    color:#fff 제거·콜론 회귀가 green 으로 통과한다).
              //    computed 스타일을 그대로 읽어 카드 배경과의 대비를 계산한다.
              // ⚠︎ Chromium 은 Tailwind v4 의 투명도 modifier 를 oklab(... / .8) 로 돌려준다.
              // regex 로 rgb 만 받으면 파싱 실패해 검정(0,0,0)으로 잡히고, 멀줦한 콜론이
              // 2.68:1 로 찍혀 false-RED 가 된다(실측 확인됨). canvas 로 브라우저에게
              // 직접 해석시켜 어떤 색 표기법이든 실제 rgba 로 받는다.
              const cx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
              const parseRgb = (v: string): [number, number, number, number] => {
                const m = /rgba?\(([^)]+)\)/.exec(v);
                if (m && !v.includes("oklab") && !v.includes("color(")) {
                  const p = m[1].split(",").map((x) => parseFloat(x));
                  return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
                }
                cx.clearRect(0, 0, 1, 1);
                cx.fillStyle = "#000";
                cx.fillStyle = v;
                cx.fillRect(0, 0, 1, 1);
                const d = cx.getImageData(0, 0, 1, 1).data;
                // getImageData 는 이미 straight(un-premultiplied) RGBA 를 돌려준다.
                // 직전 버전은 여기서 다시 α 로 나누는 이중 un-premultiply 를 해
                // white/80 채널이 318.75 까지 부풀었다(삼순 P1). 그대로 쓴다.
                return [d[0], d[1], d[2], d[3] / 255];
              };
              // 색 파서 calibration — 기준색 3종이 허용오차(채널 ±3 · α ±0.02) 밖이면
              // 측정 전체를 신뢰할 수 없으므로 그 자리에서 죽는다(fail-close).
              {
                const calib: Array<[string, [number, number, number, number]]> = [
                  ["rgb(140, 56, 0)", [140, 56, 0, 1]],
                  ["rgba(255, 255, 255, 0.8)", [255, 255, 255, 0.8]],
                  ["oklab(0.999994 0.0000455677 0.0000200868 / 0.8)", [255, 255, 255, 0.8]],
                ];
                for (const [input, want] of calib) {
                  const got = parseRgb(input);
                  const chOk = [0, 1, 2].every((i) => Math.abs(got[i] - want[i]) <= 3);
                  const aOk = Math.abs(got[3] - want[3]) <= 0.02;
                  if (!chOk || !aOk) {
                    throw new Error(`색 파서 calibration 실패: ${input} → [${got.map((x) => x.toFixed(1)).join(",")}] (기대 [${want.join(",")}])`);
                  }
                }
              }
              const srgb = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
              const lum = (c: [number, number, number]) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
              const ratio = (a: [number, number, number], b: [number, number, number]) => {
                const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
                return (hi + 0.05) / (lo + 0.05);
              };
              // 카드 실배경: gradient 시작색(가장 밝은 지점) 또는 background-color.
              const cardStyle = getComputedStyle(card);
              const gradStart = /rgba?\([^)]+\)/.exec(cardStyle.backgroundImage || "");
              const cardBgRaw = gradStart ? gradStart[0] : cardStyle.backgroundColor;
              let cardBg = parseRgb(cardBgRaw);
              if (cardBg[3] < 1) {
                // 투명하면 body 배경과 합성해서 실제 보이는 색을 만든다.
                const bodyBg = parseRgb(getComputedStyle(document.body).backgroundColor);
                cardBg = [
                  cardBg[0] * cardBg[3] + bodyBg[0] * (1 - cardBg[3]),
                  cardBg[1] * cardBg[3] + bodyBg[1] * (1 - cardBg[3]),
                  cardBg[2] * cardBg[3] + bodyBg[2] * (1 - cardBg[3]),
                  1,
                ];
              }
              const bg3: [number, number, number] = [cardBg[0], cardBg[1], cardBg[2]];
              const measureText = (el: Element | null | undefined) => {
                if (!el) return { ratio: -1, color: "", text: "" };
                const cs = getComputedStyle(el as HTMLElement);
                const c = parseRgb(cs.color);
                const eff: [number, number, number] = c[3] < 1
                  ? [c[0] * c[3] + bg3[0] * (1 - c[3]), c[1] * c[3] + bg3[1] * (1 - c[3]), c[2] * c[3] + bg3[2] * (1 - c[3])]
                  : [c[0], c[1], c[2]];
                // WCAG 1.4.3 large text = 24px 이상, 또는 18.66px 이상 + bold(700↑) → 임계 3:1.
                // 그 외는 4.5:1. 임계를 요소별로 산출해야 점수(20px extrabold, large)와
                // 콜론(12px, 본문)을 같은 잣대로 재는 오판을 피한다.
                const fs = parseFloat(cs.fontSize) || 0;
                const fw = parseInt(cs.fontWeight, 10) || 400;
                const isLarge = fs >= 24 || (fs >= 18.66 && fw >= 700);
                return {
                  ratio: Number(ratio(eff, bg3).toFixed(2)),
                  need: isLarge ? 3 : 4.5,
                  color: cs.color, text: (el.textContent ?? "").trim(),
                };
              };
              // 점수 숫자는 tabular-nums 클래스를 가진 span, 콜론은 그 사이 span.
              const scoreEls = [...card.querySelectorAll("span.tabular-nums")];
              const colonEl = [...card.querySelectorAll("span")].find((s) => (s.textContent ?? "").trim() === ":");
              const scoreM = scoreEls.map((e) => measureText(e));
              const colonM = measureText(colonEl);
              // 로고가 실제로 로드됐는지(root-relative 경로라 미로드면 좌표만 맞고 빈 칸이다).
              const logoNatural = imgs.map((i) => (i as HTMLImageElement).naturalWidth);
              out.push({
                label,
                logoLeft: logos.length ? logos[logos.length >= 2 ? logos.length - 2 : 0] : -1,
                logoRight: logos.length >= 2 ? logos[logos.length - 1] : -1,
                logoCount: imgs.length,
                logoNaturalMin: logoNatural.length ? Math.min(...logoNatural) : -1,
                overflowPx: overflow,
                heightPx: Math.round(card.getBoundingClientRect().height),
                stadiumText: stadium.textContent ?? "",
                stadiumGapRight,
                stadiumGapLeft,
                stadiumClipped,
                cardBg: cardBgRaw,
                scoreRatios: scoreM.map((s) => s.ratio),
                scoreNeeds: scoreM.map((s) => s.need),
                scoreTexts: scoreM.map((s) => s.text),
                colonRatio: colonM.ratio,
                colonNeed: colonM.need,
                colonText: colonM.text,
                cardText: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
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

      // ── 색·대비 판정 (삼순 P1: geometry 만 재면 color:#fff 제거가 green 이다)
      for (const [i, ratio] of ((r.scoreRatios as number[]) ?? []).entries()) {
        const need = ((r.scoreNeeds as number[]) ?? [])[i] ?? AA_TEXT;
        if (ratio >= 0 && ratio < need) {
          console.error(`  ❌ 점수 대비 미달 ${k} :: ${r.label} [${(r.scoreTexts as string[])?.[i]}] = ${ratio}:1 (필요 ${need})`); bad++;
        }
      }
      const colon = r.colonRatio as number;
      const colonNeed = (r.colonNeed as number) ?? AA_TEXT;
      if (typeof colon === "number" && colon >= 0 && colon < colonNeed) {
        console.error(`  ❌ 콜론 대비 미달 ${k} :: ${r.label} = ${colon}:1 (필요 ${colonNeed})`); bad++;
      }
      // 로고 실재 증명 — 직전에는 이미지 0개일 때 logoNaturalMin=-1 이 통과해
      // "로고 검증"이 빈 카드에서 헛돌았다(삼순 P1). 양팀 로고 ≥2 + 전부 디코딩되어야 한다.
      const cnt = r.logoCount as number;
      if (typeof cnt !== "number" || cnt < 2) {
        console.error(`  ❌ 팀 로고 부족(${cnt ?? "없음"}개 < 2) ${k} :: ${r.label}`); bad++;
      }
      const nat = r.logoNaturalMin as number;
      if (typeof nat !== "number" || nat <= 0) {
        console.error(`  ❌ 로고 미로드(naturalWidth=${nat}) ${k} :: ${r.label}`); bad++;
      }
      // fixture 가 의도한 문자열이 실제로 렌더됐는가(필드명 불일치 방지)
      const want = EXPECT_TEXT[r.label as string];
      if (want) {
        for (const w of want) {
          if (!String(r.cardText ?? "").includes(w)) {
            console.error(`  ❌ 기대 문자열 미렌더 ${k} :: ${r.label} ← "${w}"`); bad++;
          }
        }
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
