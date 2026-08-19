/**
 * 마스코트 **실렌더** 게이트 — Playwright 로 실제 브라우저에서 확인한다 (삼순 #1228 P0-③).
 *
 * 왜 별도 게이트인가:
 *   기존 `qa:genius-reply-mascot-browser` 는 Supabase + 로컬 서버가 필요해 **prebuild 에
 *   결속할 수 없다**(Vercel 빌드 컨테이너에 DB 가 없다). 그래서 "브라우저에서 실제로
 *   무엇이 로드되는가"가 CI 어디에서도 검증되지 않고 있었다.
 *
 *   이 게이트는 **DB 없이** 같은 질문에 답한다: 배포 컴포넌트가 만든 실제 markup 을
 *   렌더하고, 브라우저가 고른 자산(`currentSrc`)과 **네트워크 요청**을 직접 읽는다.
 *   자산과 컴포넌트만 있으면 되므로 prebuild 에 결속된다.
 *
 * 검사 축:
 *   ① `currentSrc` — 일반: 애니메이션 클립 / reduced-motion: poster. `<source media>` 가
 *      실제로 먹는지는 **브라우저만** 안다(JSDOM 은 media query 를 평가하지 않는다).
 *   ② network — reduced-motion 에서 **애니메이션 파일을 받지 않는다**. 받아놓고 안 쓰면
 *      데이터를 버리는 것이고, 저사양·데이터 절약 사용자에게 그대로 비용이다.
 *   ③ 13종 × 3배경 실제 캡처 — 말풍선/화이트/다크에서 픽셀을 읽어 확인한다.
 *
 * 실행: npx tsx scripts/qa/genius-mascot-render-gate.mjs [--selftest] [--emit-capture]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import playwright from "playwright";

const { chromium } = playwright;
const SELFTEST = process.argv.includes("--selftest");
const ROOT = process.cwd();
// 캡처는 항상 남긴다 — 삼순 요구(생성만 하지 말고 저장·판정).
const CAPTURE_DIR = process.env.MASCOT_CAPTURE_DIR ?? resolve(ROOT, ".qa-artifacts/mascot");

// ⚠️ Vercel 빌드 컨테이너에는 Playwright 브라우저가 없다(실측: `chrome-headless-shell`
//    없음 → prebuild 전체 실패). repo 의 다른 브라우저 게이트(players-sort·venue-stats-s2·
//    post-detail-header)와 **같은 패턴**을 쓴다: 브라우저가 없으면 SKIP 하되,
//    `MASCOT_RENDER_REQUIRE_BROWSER=1` 이면 SKIP 을 금지해 fail-close 한다.
//    → Vercel 에서는 SKIP, GitHub Actions 워크플로에서는 강제 실행.
//    SKIP 이 false-green 이 되지 않도록 **자산·매핑 정합은 브라우저 없이도 검사**한다(아래).
const REQUIRE_BROWSER = process.env.MASCOT_RENDER_REQUIRE_BROWSER === "1";
const chromiumPath = chromium.executablePath();
const HAS_BROWSER = Boolean(chromiumPath) && existsSync(chromiumPath);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 배포 SSOT 로드 ────────────────────────────────────────────────────────────
// 매핑·경로를 여기서 재구현하면, 배포가 바뀌어도 게이트는 조용히 GREEN 이 된다.
const {
  GENIUS_MOTION_CLIPS, GENIUS_MASCOT_HEIGHT_PX, GENIUS_MASCOT_IMG_CLASS,
  geniusMotionClipFor, geniusMotionSrc, geniusMotionPosterSrc,
} = await import("../../src/lib/constants/baseball-genius.ts");

// ⚠️ 이 게이트는 Tailwind 빌드 없이 markup 만 렌더한다. 그래서 `h-24` 같은 유틸리티가
//    먹지 않아 이미지가 **자연 크기(192px)** 로 그려진다 — 첫 실행에서 실제로 그렇게
//    FAIL 났다. 그건 제품 결함이 아니라 **게이트 환경 결함**이다.
//
//    임계값을 192 로 풀면 "96px 규격"을 검증하지 않는 게이트가 된다. 대신
//    **SSOT 클래스에서 높이 유틸리티를 파싱해** 그에 해당하는 CSS 만 주입한다.
//    클래스가 h-24→h-16 으로 바뀌면 주입 CSS 도 따라 바뀌고, 아래 규격 검사가
//    `GENIUS_MASCOT_HEIGHT_PX` 와 어긋나는 순간 RED 가 된다.
const heightUtil = /(?:^|\s)h-(\d+)(?:\s|$)/.exec(GENIUS_MASCOT_IMG_CLASS);
check("SSOT 클래스가 높이 유틸리티를 갖는다(게이트가 규격을 재구현하지 않는다)",
  heightUtil !== null, GENIUS_MASCOT_IMG_CLASS);
const utilPx = heightUtil ? Number(heightUtil[1]) * 4 : 0;   // Tailwind: 1 unit = 0.25rem = 4px
check(`SSOT 클래스 높이(h-${heightUtil?.[1]} = ${utilPx}px)가 GENIUS_MASCOT_HEIGHT_PX(${GENIUS_MASCOT_HEIGHT_PX})와 일치`,
  utilPx === GENIUS_MASCOT_HEIGHT_PX, `${utilPx} vs ${GENIUS_MASCOT_HEIGHT_PX}`);
const TAILWIND_SHIM = heightUtil
  ? `.h-${heightUtil[1]}{height:${utilPx}px}.w-auto{width:auto}.max-w-none{max-width:none}.object-contain{object-fit:contain}`
  : "";

// 실제 컴포넌트가 뱉는 markup 을 쓴다 — 손으로 <picture> 를 다시 적으면
// 컴포넌트가 바뀌어도 이 게이트는 옛 구조를 계속 통과시킨다.
const { renderToStaticMarkup } = await import("react-dom/server");
const React = (await import("react")).default;
const GeniusMascotImage = (await import("../../src/components/dm/GeniusMascotImage.tsx")).default;

/** 실경로를 그대로 태운 케이스 — 쿨다운 승인/거절을 **둘 다** 넣는다. */
const CASES = [
  { label: "정상답변",                    props: { replyKind: "answer", messageId: 2 } },
  { label: "최애팀 답변(응원)",           props: { replyKind: "answer", messageId: 3, answerTeamId: 1, favoriteTeamId: 1 } },
  { label: "인사(쿨다운 승인)",           props: { replyKind: "ack", messageId: 4, motion: "excited", motionIntent: "excited" } },
  { label: "감사(쿨다운 승인)",           props: { replyKind: "ack", messageId: 5, motion: "headspin", motionIntent: "headspin" } },
  { label: "감사(쿨다운 거절) → 중립",    props: { replyKind: "ack", messageId: 6, motion: null, motionIntent: "headspin" } },
  { label: "인사(쿨다운 거절) → 중립",    props: { replyKind: "ack", messageId: 7, motion: null, motionIntent: "excited" } },
  { label: "범위 안내(쿨다운 무관)",      props: { replyKind: "ack", messageId: 8, motion: null, motionIntent: "bored" } },
  { label: "되묻기",                      props: { replyKind: "picker", messageId: 9 } },
  { label: "답변 불가",                   props: { replyKind: "unavailable", messageId: 10 } },
  { label: "legacy(payload 없음)",        props: { replyKind: null, messageId: 11 } },
];

// ── 정적 서버 (public/) ───────────────────────────────────────────────────────
const MIME = { ".webp": "image/webp", ".html": "text/html; charset=utf-8", ".png": "image/png" };
let pageHtml = "";
let coverageHtml = "";
const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(pageHtml);
    return;
  }
  if (url === "/coverage") {
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(coverageHtml);
    return;
  }
  const file = resolve(ROOT, "public", url.replace(/^\//, ""));
  if (!file.startsWith(resolve(ROOT, "public")) || !existsSync(file)) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 각 케이스를 **한 화면에 하나씩** 격리해 그린다. 여러 개를 한 컨테이너에 몰아넣으면
// "어느 마스코트가 어느 케이스인지"가 DOM 순서에 의존하고, 하나가 안 그려져도 통과한다.
const BACKGROUNDS = [
  ["bubble", "#1C1C1E"],
  ["white", "#FFFFFF"],
  ["dark", "#0A0A0B"],
];
pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#333}
.bg{display:flex;align-items:center;gap:12px;padding:8px}
.case{display:flex;flex-direction:column;align-items:center}
${TAILWIND_SHIM}
</style></head><body>${
  BACKGROUNDS.map(([bgName, bg]) => `<div class="bg" data-bg="${bgName}" style="background:${bg}">${
    CASES.map((c, i) => `<div class="case" data-case="${i}" data-bg="${bgName}">${
      renderToStaticMarkup(React.createElement(GeniusMascotImage, {
        ...c.props, testId: `m-${bgName}-${i}`,
      }))
    }</div>`).join("")
  }</div>`).join("")
}</body></html>`;

// ⚠️ 커버리지 행은 **별도 페이지**다. 케이스 페이지에 섞으면 raw <img> 가 애니메이션
//    클립을 직접 받아 "reduced-motion 에서 애니메이션을 받지 않는다" 계약을 스스로
//    깨뜨린다(실측으로 그 FAIL 을 봤다). 페이지를 나누면 두 계약이 서로 간섭하지 않는다.
//    케이스 10개로는 클립 7/13 만 화면에 도달해, 나머지 6종의 404·깨짐·잘림을
//    아무도 못 본다 — 그래서 전수 행이 필요하다(삼순 요구 ②).
coverageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#333}
/* 13종 총 폭이 viewport를 넘더라도 locator screenshot이 자식 overflow를 자르지 않게
   coverage 행 자체를 content width로 만든다. (v1 복구에서 1280px 초과 → 마지막 crop width 음수 실측) */
.bg{display:flex;align-items:flex-end;gap:10px;padding:8px;width:max-content;min-width:100%;box-sizing:border-box}
${TAILWIND_SHIM}
</style></head><body>${
  BACKGROUNDS.map(([bgName, bg]) => `<div class="bg" data-bg="${bgName}" style="background:${bg}">${
    GENIUS_MOTION_CLIPS.map((clip) =>
      `<img class="${GENIUS_MASCOT_IMG_CLASS}" data-clip="${clip}" ` +
      `src="${geniusMotionSrc(clip)}" alt="">`).join("")
  }</div>`).join("")
}</body></html>`;

// ── 브라우저 없이도 반드시 도는 검사 ──────────────────────────────────────────
// SKIP 이 통째로 false-green 이 되지 않도록, 브라우저가 필요 없는 축은 여기서 닫는다.
{
  const missing = GENIUS_MOTION_CLIPS.filter((c) =>
    !existsSync(resolve(ROOT, "public", geniusMotionSrc(c).replace(/^\//, ""))) ||
    !existsSync(resolve(ROOT, "public", geniusMotionPosterSrc(c).replace(/^\//, ""))));
  check(`전 ${GENIUS_MOTION_CLIPS.length}종 클립 + poster 자산이 존재한다`,
    missing.length === 0, missing.join(", "));
  // 케이스가 도달하는 클립이 전부 실재하는가 (매핑에만 있고 파일이 없으면 런타임 404)
  const reached = new Set(CASES.map((c) =>
    geniusMotionClipFor(c.props.replyKind, c.props.messageId, c.props)));
  check("케이스가 도달하는 클립이 전부 폐쇄집합 안에 있다",
    [...reached].every((c) => GENIUS_MOTION_CLIPS.includes(c)),
    [...reached].filter((c) => !GENIUS_MOTION_CLIPS.includes(c)).join(", "));
}

if (!HAS_BROWSER) {
  // Vercel 빌드 컨테이너에는 브라우저가 없다. CI 워크플로에서는 REQUIRE_BROWSER=1 로
  // 강제 실행하므로, 여기서 SKIP 해도 브라우저 축이 검증되지 않는 상태로 남지 않는다.
  console.log(`${REQUIRE_BROWSER ? "  ❌ FAIL" : "  ⏭️  SKIP"}: playwright chromium 사용 불가` +
    `${REQUIRE_BROWSER ? " (REQUIRE_BROWSER=1 이므로 fail-close)" : " — 브라우저 축은 CI 워크플로가 강제 실행한다"}`);
  server.close();
  if (REQUIRE_BROWSER || failures.length > 0) process.exit(1);
  console.log(`\n✅ genius mascot render: ${pass} PASS (자산·매핑 정합 / 브라우저 축 SKIP)`);
  process.exit(0);
}

const browser = await chromium.launch();
try {
  for (const reduce of [false, true]) {
    const ctx = await browser.newContext({ reducedMotion: reduce ? "reduce" : "no-preference" });
    const page = await ctx.newPage();
    const requested = new Set();
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/mascot/motion/")) requested.add(u.pathname);
    });
    await page.goto(BASE, { waitUntil: "networkidle" });

    const observed = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(".case")) {
        const img = el.querySelector("img");
        out.push({
          caseIndex: Number(el.getAttribute("data-case")),
          bg: el.getAttribute("data-bg"),
          clip: img?.getAttribute("data-clip") ?? null,
          currentSrc: img ? new URL(img.currentSrc).pathname : null,
          natural: img ? [img.naturalWidth, img.naturalHeight] : null,
          box: img ? (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(img.getBoundingClientRect()) : null,
        });
      }
      return out;
    });

    const mode = reduce ? "reduced-motion" : "일반";

    // ① 클립 선택이 배포 SSOT 와 일치하는가 — 케이스별로 **개별** 판정한다.
    for (let i = 0; i < CASES.length; i += 1) {
      const c = CASES[i];
      const expected = geniusMotionClipFor(c.props.replyKind, c.props.messageId, c.props);
      const rows = observed.filter((o) => o.caseIndex === i);
      check(`[${mode}] ${c.label} → ${expected} (배경 3종 모두)`,
        rows.length === BACKGROUNDS.length && rows.every((r) => r.clip === expected),
        rows.map((r) => `${r.bg}=${r.clip}`).join(" "));
    }

    // ② 브라우저가 실제로 고른 자산 — `<source media>` 평가는 브라우저만 한다.
    const wantSuffix = reduce ? "-poster.webp" : ".webp";
    check(`[${mode}] currentSrc 가 ${reduce ? "정지 poster" : "애니메이션 클립"} 이다`,
      observed.length > 0 && observed.every((o) =>
        o.currentSrc === (reduce ? geniusMotionPosterSrc(o.clip) : geniusMotionSrc(o.clip))),
      observed.filter((o) => o.currentSrc !== (reduce ? geniusMotionPosterSrc(o.clip) : geniusMotionSrc(o.clip)))
        .map((o) => `${o.clip}→${o.currentSrc}`).slice(0, 4).join(", "));

    // ③ network — 안 쓰는 자산을 받지 않는다(데이터 낭비 + 저사양 부담).
    const unwanted = [...requested].filter((p) =>
      reduce ? !p.endsWith("-poster.webp") : p.endsWith("-poster.webp"));
    check(`[${mode}] 선택되지 않은 자산은 네트워크에서 받지도 않는다`,
      SELFTEST ? false : unwanted.length === 0, unwanted.slice(0, 5).join(", "));

    // ④ 로드 성공 + 렌더 높이 규격
    check(`[${mode}] 전 케이스 자산이 실제 로드됨(404 아님)`,
      observed.length > 0 && observed.every((o) => (o.natural?.[0] ?? 0) > 0),
      observed.filter((o) => !(o.natural?.[0] > 0)).map((o) => o.clip).join(", "));
    check(`[${mode}] 렌더 높이가 ${GENIUS_MASCOT_HEIGHT_PX}px 로 통일`,
      observed.every((o) => o.box?.height === GENIUS_MASCOT_HEIGHT_PX),
      [...new Set(observed.map((o) => o.box?.height))].join(","));

    if (!reduce) {
      // ⑤ 13종 전수 × 3배경 실제 캡처 — **저장하고 픽셀로 판정**한다.
      //
      // 🔴 종전에는 캡처 후 `check("배경 3종 실제 캡처 성공", true)` 였다. 리터럴 true 는
      //    무엇도 검증하지 않는다 — 캡처가 새까맣게 나와도 GREEN 이다(삼순 지적).
      //    이제 캡처 PNG 를 디코딩해 배경별로 실제 픽셀을 읽는다.
      mkdirSync(CAPTURE_DIR, { recursive: true });
      const sharp = (await import("sharp")).default;
      const cov = await ctx.newPage();
      await cov.goto(`${BASE}/coverage`, { waitUntil: "networkidle" });
      for (const [bgName, bgHex] of BACKGROUNDS) {
        const shot = await cov.locator(`.bg[data-bg="${bgName}"]`).screenshot();
        const file = resolve(CAPTURE_DIR, `mascot-${bgName}.png`);
        writeFileSync(file, shot);

        const { data, info } = await sharp(shot).ensureAlpha().raw()
          .toBuffer({ resolveWithObject: true });
        const bgRgb = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
        // 배경과 다른 픽셀 = 실제로 그려진 마스코트 픽셀.
        let drawn = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.max(Math.abs(data[i] - bgRgb[0]), Math.abs(data[i + 1] - bgRgb[1]),
                       Math.abs(data[i + 2] - bgRgb[2])) > 12) drawn += 1;
        }
        const drawnPct = (drawn / (info.width * info.height)) * 100;
        // 13종이 나란히 그려지면 캔버스의 상당 부분이 채워진다. 새까만/빈 캡처는 여기서 죽는다.
        check(`[${bgName}] 캡처에 마스코트가 실제로 그려졌다 (${drawnPct.toFixed(1)}% 채움, 저장: ${file})`,
          SELFTEST ? false : drawnPct > 5, `${drawnPct.toFixed(2)}%`);

        // 🔴 **자산별** 판정 (삼순 2026-08-16 ②). 행 전체 채움률만 보면 자산 1개가
        //    완전투명·깨짐이어도 나머지 12개가 채워서 PASS 한다 — 실제로 그랬다.
        //    각 클립의 DOM 박스로 **crop 해서 그 자산만** 픽셀을 센다. 13종 × 3배경 = 39 판정.
        const boxes = await cov.evaluate((bg) => [...document.querySelectorAll(`.bg[data-bg="${bg}"] [data-clip]`)]
          .map((el) => {
            const r = el.getBoundingClientRect();
            const p = el.closest(".bg").getBoundingClientRect();
            return { clip: el.getAttribute("data-clip"),
                     x: Math.round(r.left - p.left), y: Math.round(r.top - p.top),
                     w: Math.round(r.width), h: Math.round(r.height) };
          }), bgName);
        const weak = [];
        for (const b of boxes) {
          if (!(b.w > 0 && b.h > 0)) { weak.push(`${b.clip}(box 0)`); continue; }
          // screenshot 경계와 교집합을 명시적으로 구한다. 종전 `min(b.w, width-b.x)`는
          // 자산이 viewport 밖에 있으면 음수 width를 sharp.extract에 넘겨 예외로 죽었다.
          // 교집합이 없으면 SKIP/예외가 아니라 해당 자산을 weak로 판정해 fail-close한다.
          const left = Math.max(0, b.x), top = Math.max(0, b.y);
          const right = Math.min(info.width, b.x + b.w);
          const bottom = Math.min(info.height, b.y + b.h);
          if (!(right > left && bottom > top)) {
            weak.push(`${b.clip}(capture 밖)`);
            continue;
          }
          const { data: cd, info: ci } = await sharp(shot)
            .extract({ left, top, width: right - left, height: bottom - top })
            .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          let d2 = 0;
          for (let i = 0; i < cd.length; i += 4) {
            if (Math.max(Math.abs(cd[i] - bgRgb[0]), Math.abs(cd[i + 1] - bgRgb[1]),
                         Math.abs(cd[i + 2] - bgRgb[2])) > 12) d2 += 1;
          }
          const pct = (d2 / (ci.width * ci.height)) * 100;
          // 캐릭터가 제대로 그려지면 자기 박스의 상당 부분을 채운다. 완전투명·깨진 자산은 0 에 가깝다.
          if (!(pct > 15)) weak.push(`${b.clip}=${pct.toFixed(1)}%`);
        }
        check(`[${bgName}] 자산별 판정 ${boxes.length}종 — 각 클립이 자기 박스를 채운다(단일 투명·깨짐도 RED)`,
          SELFTEST ? false : (boxes.length === GENIUS_MOTION_CLIPS.length && weak.length === 0),
          weak.length ? weak.join(", ") : `${boxes.length}종`);
      }
      // 13종이 **전부** 화면에 도달했는가 — 케이스 10개로는 일부 클립이 안 그려진다.
      const covRows = await cov.evaluate(() => [...document.querySelectorAll("[data-clip]")]
        .map((el) => ({ clip: el.getAttribute("data-clip"),
                        w: el.naturalWidth, h: Math.round(el.getBoundingClientRect().height) })));
      const shown = new Set(covRows.map((r) => r.clip));
      check(`13종 전수가 실제 화면에 도달했다 (${shown.size}/${GENIUS_MOTION_CLIPS.length})`,
        GENIUS_MOTION_CLIPS.every((c) => shown.has(c)),
        GENIUS_MOTION_CLIPS.filter((c) => !shown.has(c)).join(", "));
      // 전수가 실제로 **로드**되고 규격대로 그려졌는가 — 도달만으로는 404 를 못 본다.
      check("13종 전수가 404 없이 로드되고 96px 규격으로 그려진다",
        covRows.length > 0 && covRows.every((r) => r.w > 0 && r.h === GENIUS_MASCOT_HEIGHT_PX),
        covRows.filter((r) => !(r.w > 0 && r.h === GENIUS_MASCOT_HEIGHT_PX))
          .map((r) => `${r.clip}(w=${r.w},h=${r.h})`).join(", "));
      await cov.close();
    }
    await ctx.close();
  }

} finally {
  await browser.close();
  server.close();
}

if (SELFTEST) {
  const ok = failures.length >= 2;
  console.log(ok
    ? `\n✅ selftest: 기대 반전으로 ${failures.length}축 RED — 검출력 확인`
    : `\n❌ selftest: RED ${failures.length}축뿐`);
  process.exit(ok ? 0 : 1);
}
console.log(failures.length === 0
  ? `\n✅ genius mascot render: ${pass} PASS (currentSrc + network + 배경 3종 실캡처)`
  : `\n❌ genius mascot render FAIL: ${failures.length}건`);
process.exit(failures.length === 0 ? 0 : 1);
