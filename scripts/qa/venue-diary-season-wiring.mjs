#!/usr/bin/env node
/**
 * 직관 다이어리 "지난 경기 추가" 시즌 배선 게이트 (삼순 #1083 NO-GO 보완).
 *
 * 왜 필요한가 — 기존 회귀가 false-green 이었다:
 *   VenueDiaryAddGameSheet 의 일정 조회 한 줄(`${season}-MM` → `2026-MM`)을 되돌려도
 *   venue-diary-media / venue-diary-view / result-tone / tsc / eslint 가 전부 exit 0 이었다.
 *   그 상태는 2025 칩은 남아있지만 2026 일정을 받아 2025 필터에 전멸 → 경기 0건, 즉
 *   원 제보(2025 선택지 없음)가 그대로 재발하는 상태다.
 *   counts fetch 를 addSeason → CURRENT_SEASON 으로 되돌려도 마찬가지로 전부 초록이었다.
 *   helper 단위 mutation 은 통과해도 정작 유저를 고치는 client call-site 가 무방비였다.
 *
 * 이 게이트가 보는 것 (전부 실제 컴포넌트가 실제로 날린 HTTP 요청 + 실제 DOM):
 *   1) 기본(2026) 시트 — team-schedule?month=2026-MM · venue-diary/media?season=2026
 *   2) 2025 칩 클릭   — team-schedule?month=2025-MM · venue-diary/media?season=2025
 *   3) 시즌 전환 첫 렌더는 counts 미확정 → 전 경기 선택 비활성(fail-closed)
 *   4) 2025 counts 도착 후 2025 의 10/10 경기가 실제 DOM 에서 잠김(Lock, disabled)
 *   5) 2026 으로 되돌아가면 다시 2026 일정/ counts 를 요청
 *
 * mutation RED (이 게이트가 진짜 잡는지 증명):
 *   DIARY_SEASON_MUTATE=schedule  일정 조회에서 season 전달 제거 → FAIL 이어야 한다
 *   DIARY_SEASON_MUTATE=counts    counts fetch 에서 addSeason 전달 제거 → FAIL 이어야 한다
 *
 * CI(VENUE_DIARY_SEASON_REQUIRE_BROWSER=1)에선 chromium 부재도 fail-closed(exit 1).
 * 그 외(로컬/Vercel prebuild)에선 graceful skip(exit 0).
 *
 * 실행: npm run qa:venue-diary-season
 */
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import playwright from "playwright";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = process.cwd();
const REQUIRE_BROWSER =
  process.env.VENUE_DIARY_SEASON_REQUIRE_BROWSER === "1" ||
  process.env.DIARY_CONTRAST_REQUIRE_BROWSER === "1" ||
  process.env.RESULT_TONE_REQUIRE_BROWSER === "1";
const MUTATE = process.env.DIARY_SEASON_MUTATE ?? "";
const SELF_GUARD = process.env.DIARY_SEASON_SELF_GUARD === "1";

let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok" : "FAIL"} - ${msg}`);
  if (cond) pass += 1;
  else fail += 1;
};

// ── chromium 가용성(fail-closed 분기) ────────────────────────────────────────
let chromiumPath = null;
try {
  chromiumPath = playwright.chromium.executablePath();
} catch {
  chromiumPath = null;
}
if (!chromiumPath || !existsSync(chromiumPath)) {
  const detail = chromiumPath ? `not found at ${chromiumPath}` : "executablePath unavailable";
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium 사용 불가(fail-closed) — ${detail}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${detail}`);
  process.exit(0);
}

const GEN = mkdtempSync(resolve(tmpdir(), "diary-season-"));

/**
 * 실제 소스를 읽어 (필요하면) 한 줄만 변조한 사본을 GEN 에 쓰고 그 경로를 돌려준다.
 * 원본 파일은 절대 건드리지 않는다(작업트리 오염 0).
 */
function sourceEntry(relPath, mutateFn) {
  const abs = resolve(ROOT, relPath);
  const src = readFileSync(abs, "utf8");
  const out = mutateFn ? mutateFn(src) : src;
  if (mutateFn && out === src) {
    console.error(`FAIL: mutation 적용 실패 — ${relPath} 의 대상 패턴을 찾지 못했다`);
    process.exit(1);
  }
  // 같은 디렉터리 상대 import 가 없도록 @/ alias 만 쓰는 파일이어야 한다.
  const name = relPath.replace(/[\\/]/g, "__");
  const dst = resolve(GEN, name);
  writeFileSync(dst, out);
  return dst;
}

const SHEET_REL = "src/components/my/VenueDiaryAddGameSheet.tsx";
const CARD_REL = "src/components/my/VenueDiaryCard.tsx";

// mutation 1: 일정 조회가 선택 시즌을 안 쓰고 2026 고정으로 회귀
const sheetEntry = sourceEntry(
  SHEET_REL,
  MUTATE === "schedule"
    ? (src) =>
        src.replace(
          "const monthStr = `${season}-${String(month).padStart(2, \"0\")}`;",
          "const monthStr = `2026-${String(month).padStart(2, \"0\")}`;",
        )
    : null,
);
// mutation 2: counts fetch 가 선택 시즌을 안 쓰고 최신 시즌 고정으로 회귀
const cardEntry = sourceEntry(
  CARD_REL,
  MUTATE === "counts"
    ? (src) =>
        src.replace(
          "return fetchDiaryMediaAllPages(token, addSeason, signal);",
          "return fetchDiaryMediaAllPages(token, VENUE_DIARY_MANUAL_SEASONS[0], signal);",
        )
    : null,
);

// ── stub: 인증/세션만. 시트·카드는 실제 컴포넌트를 쓴다. ─────────────────────
// user/profile 객체는 반드시 stable identity 여야 한다. 매 렌더 새 객체를 돌려주면
// [user] 를 deps 로 쓰는 effect 가 무한 재실행돼(수백 회 fetch) 관측 자체가 불가능해진다.
// 실제 AuthContext 도 stable value 를 내려주므로 이게 프로덕션에 더 가깝다.
writeFileSync(
  resolve(GEN, "auth.jsx"),
  `import React from "react";
const USER = { id: "qa-season" };
const PROFILE = { team_id: 1 };
const VALUE = { user: USER, profile: PROFILE };
export function AuthProvider({children}){ return React.createElement(React.Fragment,null,children); }
export const useAuth = () => VALUE;
export default { AuthProvider, useAuth };
`,
);
writeFileSync(
  resolve(GEN, "client.js"),
  `export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"x"}}})}};
export async function getSafeSession(){ return { access_token:"x" }; }
`,
);
// 업로더/뷰어는 이 게이트의 관심사가 아니고 포털이 겹치면 DOM 질의가 지저분해진다.
writeFileSync(resolve(GEN, "null.jsx"), `export default function Null(){ return null; }\n`);
writeFileSync(
  resolve(GEN, "entry.jsx"),
  `import React from "react";
import {createRoot} from "react-dom/client";
import VenueDiaryCard from "@/components/my/VenueDiaryCard";
createRoot(document.getElementById("root")).render(React.createElement(VenueDiaryCard));
`,
);

await build({
  entryPoints: [resolve(GEN, "entry.jsx")],
  bundle: true,
  format: "iife",
  outfile: resolve(GEN, "bundle.js"),
  jsx: "automatic",
  absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};' },
  logLevel: "error",
  alias: {
    "@/components/my/VenueDiaryCard": cardEntry,
    "@/components/my/VenueDiaryAddGameSheet": sheetEntry,
    "@/components/my/VenueDiaryUploader": resolve(GEN, "null.jsx"),
    "@/components/my/VenueDiaryViewer": resolve(GEN, "null.jsx"),
    "@/lib/supabase/AuthContext": resolve(GEN, "auth.jsx"),
    "@/lib/supabase/client": resolve(GEN, "client.js"),
  },
});
const bundleJs = readFileSync(resolve(GEN, "bundle.js"), "utf8");

const compiled = await postcss([tailwind]).process(
  readFileSync(resolve(ROOT, "src/styles/globals.css"), "utf8"),
  { from: resolve(ROOT, "src/styles/globals.css") },
);

// ── fixture ─────────────────────────────────────────────────────────────────
// 시즌마다 gameId·경기 내용이 달라야 한다. 같은 fixture 를 두 시즌에 돌려주면
// 어느 시즌 데이터를 받았는지 DOM 으로 구분할 수 없어 게이트가 무력해진다.
const GAME_2026 = "20260801LGSS0";
const GAME_2025 = "20250801LGSS0";
const scheduleDay = (season, gameId) => ({
  day: 1,
  date: `${season}0801`,
  gameId,
  opponent: { id: 8, slug: "samsung", shortName: "삼성", name: "삼성 라이온즈" },
  home: false,
  status: "final",
  result: "W",
  score: { for: season === 2026 ? 7 : 4, against: 2 },
  stadium: "대구",
  time: "18:30",
});
// 두 시즌 모두 "이미 10/10 꽉 찬 경기" 를 둔다 → counts 시즌이 어긋나면 0/10(선택가능)으로
// 보이는 fail-open 이 실제 DOM 에서 드러난다.
const mediaGroup = (season, gameId) => ({
  gameId,
  gameDate: `${season}-08-01`,
  stadiumName: "대구",
  counts: { image: 10, video: 0, total: 10 },
  thumbnails: [],
});

const seen = { schedule: [], media: [], attendance: [] };
/** counts 응답 지연(ms) — 전환 첫 렌더의 fail-closed 상태를 관측하기 위해. */
let mediaDelayMs = 0;

const server = createServer(async (req, res) => {
  const [path, qs] = req.url.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (path === "/api/team-schedule") {
    seen.schedule.push(req.url);
    const month = params.get("month") ?? "";
    const season = Number(month.slice(0, 4));
    const gameId = season === 2025 ? GAME_2025 : GAME_2026;
    // 8월만 경기가 있는 fixture. 다른 달을 물어보면 빈 목록.
    const days = month.endsWith("-08") ? [scheduleDay(season, gameId)] : [];
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ team: "lg", month, summary: {}, days }));
  }
  if (path === "/api/me/venue-diary/media") {
    seen.media.push(req.url);
    const season = Number(params.get("season") ?? 0);
    if (mediaDelayMs > 0) await new Promise((r) => setTimeout(r, mediaDelayMs));
    const gameId = season === 2025 ? GAME_2025 : GAME_2026;
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        season,
        games: [mediaGroup(season, gameId)],
        nextCursor: null,
        hasMore: false,
      }),
    );
  }
  if (path === "/api/me/venue-attendance") {
    seen.attendance.push(req.url);
    const season = Number(params.get("season") ?? 0);
    const summary = {
      attendanceCount: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      finalCount: 1,
      winRate: 1,
    };
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        season,
        summary,
        overallSummary: summary,
        diaryGameCount: 1,
        games: [],
      }),
    );
  }
  if (path === "/app.css")
    return res.writeHead(200, { "content-type": "text/css" }).end(compiled.css);
  if (path === "/bundle.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleJs);
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<!doctype html><html class="dark"><head><meta charset="utf8">` +
      `<link rel="stylesheet" href="/app.css"></head>` +
      `<body class="bg-bg-primary" style="margin:0"><div id="root"></div>` +
      `<script src="/bundle.js"></script></body></html>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const scheduleMonths = () =>
  seen.schedule.map((u) => new URLSearchParams(u.split("?")[1]).get("month"));
const mediaSeasons = () =>
  seen.media.map((u) => new URLSearchParams(u.split("?")[1]).get("season")).filter(Boolean);

// 시트는 포털로 body 직하에 붙고, 카드에도 동명의 시즌 세그먼트(2026/2025/전체)가 있다.
// 카드 쪽 버튼을 잡으면 전혀 다른 것(조회 시즌 탭)을 클릭하게 되므로 반드시 시트로 스코프한다.
const SHEET = '.z-\\[54\\]';
const sheet = (page) => page.locator(SHEET);

/**
 * 시트 목록이 안정될 때까지 대기. 시즌 배선이 깨지면 해당 날짜 라벨이 안 나오거나
 * "이 달에 종료된 경기가 없어요" 가 뜨는데, 둘 다 허용하고 단언은 뒤에서 따로 한다.
 * (여기서 fail-fast 하면 mutation 시 체크 집계 없이 예외로 죽어 원인 파악이 어렵다.)
 */
/** counts 확정(‘확인 중…’ 사라짐) 대기 — 잠김 상태를 판정하려면 확정 이후여야 한다. */
async function waitCountsSettled(page) {
  try {
    await page.waitForFunction(
      (sel) => !/확인 중/.test(document.querySelector(sel)?.innerText || ""),
      SHEET,
      { timeout: 10000 },
    );
  } catch {
    console.log("  (warn) counts 확정 대기 timeout");
  }
  await page.waitForTimeout(200);
}

async function waitRows(page, dateLabel) {
  try {
    await page.waitForFunction(
      ({ label, sel }) => {
        const root = document.querySelector(sel);
        if (!root) return false;
        const text = root.innerText || "";
        return text.includes(label) || /경기가 없어요/.test(text);
      },
      { label: dateLabel, sel: SHEET },
      { timeout: 10000 },
    );
  } catch {
    console.log(`  (warn) 목록 대기 timeout — ${dateLabel}`);
  }
  await page.waitForTimeout(300);
}

let browser;
try {
  browser = await playwright.chromium.launch();
} catch (e) {
  const line = e.message.split("\n")[0];
  server.close();
  rmSync(GEN, { recursive: true, force: true });
  if (REQUIRE_BROWSER) {
    console.error(`FAIL: playwright chromium launch 실패(fail-closed) — ${line}`);
    process.exit(1);
  }
  console.log(`SKIP: playwright chromium 사용 불가 — ${line}`);
  process.exit(0);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/my`, { waitUntil: "load" });
  await page.waitForFunction(() => /인증 직관/.test(document.body.innerText), null, {
    timeout: 10000,
  });

  // ── 1) 기본(2026) 시트 ────────────────────────────────────────────────────
  seen.schedule.length = 0;
  seen.media.length = 0;
  await page.getByRole("button", { name: /지난 경기 추가하기/ }).click();
  await page.waitForSelector(SHEET, { timeout: 10000 });
  await page.waitForFunction(
    (sel) => /종료 경기/.test(document.querySelector(sel)?.innerText || ""),
    SHEET,
    { timeout: 10000 },
  );
  // 8월 칩을 눌러 fixture 가 있는 달로 확정한다(현재 KST 월에 의존하지 않게).
  await sheet(page).getByRole("button", { name: "8월", exact: true }).click();
  // gameId 는 React key 로만 쓰이고 DOM 에 나오지 않는다 — 날짜 라벨로 판정한다.
  await waitRows(page, "2026.08.01");
  await waitCountsSettled(page);

  check(
    scheduleMonths().some((m) => m === "2026-08"),
    `기본 시트가 2026 일정 조회 (months=${scheduleMonths().join(",") || "none"})`,
  );
  check(
    mediaSeasons().includes("2026"),
    `기본 시트가 2026 counts 조회 (seasons=${mediaSeasons().join(",") || "none"})`,
  );

  // 경기 행만 골라낸다 — 팀 칩("삼성")도 같은 글자를 담으므로 날짜 라벨(YYYY.MM.DD) 유무로 구분.
  const rowState = async () =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return [];
      const rows = [...root.querySelectorAll("button")].filter((b) =>
        /\d{4}\.\d{2}\.\d{2}/.test(b.textContent || ""),
      );
      return rows.map((b) => ({
        text: (b.textContent || "").replace(/\s+/g, " ").trim(),
        disabled: b.disabled,
      }));
    }, SHEET);

  const r2026 = await rowState();
  check(r2026.length === 1, `2026 목록에 fixture 경기 1건 (got ${r2026.length})`);
  check(
    r2026[0]?.text.includes("10/10") && r2026[0]?.disabled === true,
    `2026 10/10 경기는 잠김 (${r2026[0]?.text ?? "none"} disabled=${r2026[0]?.disabled})`,
  );
  // 시즌 배선이 깨지면 표시 자체가 상대 시즌 데이터가 된다 — 점수로 구분한다(2026=7:2, 2025=4:2).
  check(r2026[0]?.text.includes("7 : 2"), `2026 행이 2026 fixture 점수 (${r2026[0]?.text})`);

  // ── 2·3) 2025 전환: 첫 렌더 fail-closed → counts 도착 후 잠김 ──────────────
  seen.schedule.length = 0;
  seen.media.length = 0;
  mediaDelayMs = 900; // counts 를 늦춰 전환 직후의 미확정 상태를 관측
  await sheet(page).getByRole("button", { name: "2025", exact: true }).click();
  // 전환 직후: counts 미확정이므로 어떤 경기도 선택 불가여야 한다.
  // 예외로 죽이지 않고 check 로 집계한다 — 일정 배선이 깨진 mutation 에서는 목록이 0건이라
  // ‘확인 중…’ 배너 자체가 안 뜨는데, 그때도 이후 목록/counts 단언이 전부 찍혀야 원인이 보인다.
  let sawPending = true;
  try {
    await page.waitForFunction(
      (sel) => /확인 중/.test(document.querySelector(sel)?.innerText || ""),
      SHEET,
      { timeout: 5000 },
    );
  } catch {
    sawPending = false;
  }
  const pending = await rowState();
  check(
    sawPending,
    `시즌 전환 직후 counts 미확정 구간 관측됨(‘확인 중…’, rows=${pending.length})`,
  );
  check(
    pending.length > 0 && pending.every((r) => r.disabled),
    `시즌 전환 첫 구간은 전 경기 선택 비활성 (rows=${pending.length}, enabled=${pending.filter((r) => !r.disabled).length})`,
  );

  mediaDelayMs = 0;
  await waitCountsSettled(page);
  await waitRows(page, "2025.08.01");

  check(
    scheduleMonths().some((m) => m === "2025-08"),
    `2025 선택 시 2025 일정 조회 (months=${scheduleMonths().join(",") || "none"})`,
  );
  check(
    !scheduleMonths().some((m) => m?.startsWith("2026")),
    `2025 선택 후 2026 일정 재조회 없음 (months=${scheduleMonths().join(",") || "none"})`,
  );
  check(
    mediaSeasons().includes("2025"),
    `2025 선택 시 2025 counts 조회 (seasons=${mediaSeasons().join(",") || "none"})`,
  );
  check(
    !mediaSeasons().includes("2026"),
    `2025 선택 후 2026 counts 조회 없음 (seasons=${mediaSeasons().join(",") || "none"})`,
  );

  const r2025 = await rowState();
  check(r2025.length === 1, `2025 목록에 fixture 경기 1건 (got ${r2025.length})`);
  check(
    r2025[0]?.text.includes("4 : 2"),
    `2025 행이 2025 fixture 점수 (${r2025[0]?.text ?? "none"})`,
  );
  // ── 4) 시즌 정합 counts — 2025 의 10/10 이 실제로 잠겨야 한다 ──────────────
  check(
    r2025[0]?.text.includes("10/10") && r2025[0]?.disabled === true,
    `2025 10/10 경기 잠김 (${r2025[0]?.text ?? "none"} disabled=${r2025[0]?.disabled})`,
  );

  // ── 5) 2026 복귀 ──────────────────────────────────────────────────────────
  seen.schedule.length = 0;
  seen.media.length = 0;
  await sheet(page).getByRole("button", { name: "2026", exact: true }).click();
  await waitRows(page, "2026.08.01");
  await waitCountsSettled(page);
  check(
    scheduleMonths().some((m) => m === "2026-08") && mediaSeasons().includes("2026"),
    `2026 복귀 시 2026 일정·counts 재조회 (months=${scheduleMonths().join(",")} seasons=${mediaSeasons().join(",")})`,
  );

  await ctx.close();
} finally {
  await browser.close();
  server.close();
  rmSync(GEN, { recursive: true, force: true });
}

console.log(
  `\nvenue-diary season wiring gate${MUTATE ? ` [mutate=${MUTATE}]` : ""}: pass=${pass} fail=${fail}`,
);

if (fail === 0 && !MUTATE && SELF_GUARD) {
  for (const mutation of ["schedule", "counts"]) {
    const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      cwd: ROOT,
      env: {
        ...process.env,
        DIARY_SEASON_MUTATE: mutation,
        DIARY_SEASON_SELF_GUARD: "0",
        VENUE_DIARY_SEASON_REQUIRE_BROWSER: "1",
      },
      encoding: "utf8",
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    const red = child.status !== 0 && /FAIL/.test(output);
    check(red, `mutation RED — ${mutation} call-site 회귀를 실제 Card→Sheet 브라우저가 차단`);
    if (!red) process.stdout.write(output);
  }
}

process.exit(fail === 0 ? 0 : 1);
