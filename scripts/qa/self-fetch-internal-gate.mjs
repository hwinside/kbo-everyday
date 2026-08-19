#!/usr/bin/env node
/**
 * self-fetch-internal-gate
 *
 * 계약:
 *  1) self-fetch 소비처 3곳은 service 함수를 실제 import+호출해야 한다.
 *  2) 소비처 구현에 same-origin /api self-fetch가 남아 있으면 안 된다.
 *  3) 주석 속 문자열은 판정에서 제외하되 오프셋은 보존한다.
 *
 * --selftest: 소비처 사본에 self-fetch를 주입해 RED가 나는지 검증한다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL("../..", import.meta.url).pathname);

const WIRING_CONTRACTS = [
  [
    "src/app/api/player-today-game/route.ts",
    [
      /from\s+"@\/lib\/services\/player-today-game"/,
      /getPlayerTodayGameRouteResult\s*\(/,
    ],
  ],
  [
    "src/app/api/widget/player-card/route.ts",
    [
      /from\s+"@\/lib\/services\/player-stats"/,
      /getPlayerStatsRouteResult\s*\(/,
      /from\s+"@\/lib\/services\/player-game-logs"/,
      /getPlayerGameLogsRouteResult\s*\(/,
      /from\s+"@\/lib\/services\/stats"/,
      /getStatsRouteResult\s*\(/,
      /from\s+"@\/lib\/services\/player-today-game"/,
      /getPlayerTodayGameRouteResult\s*\(/,
    ],
  ],
  [
    "src/app/api/cron/game-events-warmup/route.ts",
    [
      /from\s+"@\/lib\/services\/game-events"/,
      /getGameEventsRouteResult\s*\(/,
      /from\s+"@\/lib\/services\/game-relay"/,
      /getGameRelayRouteResult\s*\(/,
    ],
  ],
];

const SELF_FETCH_TARGETS = [
  "src/lib/services/player-today-game.ts",
  "src/app/api/widget/player-card/route.ts",
  "src/app/api/cron/game-events-warmup/route.ts",
];

function blankCommentsPreserveOffsets(source) {
  let out = "";
  let i = 0;
  let mode = "code";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === "code") {
      if (ch === "'" || ch === '"' || ch === "`") {
        mode = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") {
        mode = "line-comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block-comment";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (mode === "line-comment") {
      if (ch === "\n") {
        mode = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }

    if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 2;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    out += ch;
    if (ch === "\\") {
      out += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === mode) mode = "code";
    i += 1;
  }
  return out;
}

function readSource(rel, mutate) {
  const abs = join(ROOT, rel);
  let source = readFileSync(abs, "utf8");
  if (mutate) source = mutate(rel, source);
  return blankCommentsPreserveOffsets(source);
}

function selfFetchMatches(source) {
  const matches = [];
  const re = /fetch\s*\(([\s\S]{0,260}?)\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const call = match[0];
    const hasApiPath = /\/api\/[a-z0-9-]+/i.test(call);
    const hasSelfOriginHint =
      /keubo\.fan|NEXT_PUBLIC_APP_URL|VERCEL_PROJECT_PRODUCTION_URL|VERCEL_URL/.test(call) ||
      /["'`]\/api\//.test(call) ||
      /\$\{(?:baseUrl|PUBLIC_BASE)\}\/api\//.test(call);
    if (hasApiPath && hasSelfOriginHint) {
      matches.push(call.replace(/\s+/g, " ").slice(0, 180));
    }
  }
  return matches;
}

function check({ mutate } = {}) {
  const failures = [];

  for (const [rel, regexes] of WIRING_CONTRACTS) {
    let source;
    try {
      source = readSource(rel, mutate);
    } catch {
      failures.push(`[W] ${rel}: 파일 없음`);
      continue;
    }
    for (const re of regexes) {
      if (!re.test(source)) failures.push(`[W] ${rel}: 필수 wiring 누락 ${re}`);
    }
  }

  for (const rel of SELF_FETCH_TARGETS) {
    let source;
    try {
      source = readSource(rel, mutate);
    } catch {
      failures.push(`[H] ${rel}: 파일 없음`);
      continue;
    }
    const matches = selfFetchMatches(source);
    for (const call of matches) {
      failures.push(`[H] ${rel}: same-origin self-fetch 잔존 → ${call}`);
    }
  }

  return failures;
}

if (process.argv.includes("--selftest")) {
  const mutations = [
    [
      "M1 player-today-game service self-fetch 주입",
      (rel, source) =>
        rel === "src/lib/services/player-today-game.ts"
          ? `${source}\nconst __mut1 = () => fetch("https://keubo.fan/api/game-detail?gameId=20260101LGOB0");\n`
          : source,
    ],
    [
      "M2 widget self-fetch 주입",
      (rel, source) =>
        rel === "src/app/api/widget/player-card/route.ts"
          ? `${source}\nconst __mut2 = () => fetch("/api/player-stats?id=x&pos=%ED%83%80%EC%9E%90");\n`
          : source,
    ],
    [
      "M3 warmup self-fetch 주입",
      (rel, source) =>
        rel === "src/app/api/cron/game-events-warmup/route.ts"
          ? `${source}\nconst __mut3 = () => fetch(\`\${baseUrl}/api/game-events?gameId=20260101LGOB0\`);\n`
          : source,
    ],
  ];

  let ok = true;
  for (const [name, mutate] of mutations) {
    const failures = check({ mutate });
    const red = failures.some((line) => line.startsWith("[H]"));
    console.log(`${red ? "RED(기대대로 검출)" : "MISS(검출 실패)"} — ${name}`);
    if (!red) ok = false;
  }

  const base = check();
  if (base.length > 0) {
    ok = false;
    console.log("BASE NOT GREEN:");
    for (const failure of base) console.log("  " + failure);
  }

  process.exit(ok ? 0 : 1);
}

const failures = check();
if (failures.length > 0) {
  console.error(`self-fetch-internal-gate FAIL (${failures.length}건)`);
  for (const failure of failures) console.error("  " + failure);
  process.exit(1);
}
console.log("self-fetch-internal-gate PASS — wiring 3축 충족 · same-origin /api self-fetch 0");
