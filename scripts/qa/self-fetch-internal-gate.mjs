#!/usr/bin/env node
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
];

const SELF_FETCH_TARGETS = [
  "src/lib/services/player-today-game.ts",
  "src/app/api/widget/player-card/route.ts",
];

const PURITY_TARGETS = [
  "src/lib/services/game-detail.ts",
  "src/lib/services/player-stats.ts",
  "src/lib/services/player-game-logs.ts",
  "src/lib/services/stats.ts",
  "src/lib/services/player-today-game.ts",
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
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") mode = "code";
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
    const hasApiPath = /\/api\/[a-z0-9/-]+/i.test(call);
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

function checkParity(source) {
  const failures = [];
  if (/\bNextResponse\b/.test(source)) {
    failures.push("NextResponse token 잔존");
  }
  if (/return\s+HIDDEN\s*\(/.test(source)) {
    failures.push("순수 구조 래퍼(result/body) 없이 HIDDEN 직접 반환");
  }
  if (!/function\s+result\s*\(/.test(source)) {
    failures.push("순수 응답 래퍼 result() 누락");
  }
  if (!/return\s+result\s*\(/.test(source)) {
    failures.push("result(...) 반환 분기 누락");
  }
  return failures;
}

function check({ mutate } = {}) {
  const failures = [];

  for (const [rel, regexes] of WIRING_CONTRACTS) {
    const source = readSource(rel, mutate);
    for (const re of regexes) {
      if (!re.test(source)) failures.push(`[W] ${rel}: 필수 wiring 누락 ${re}`);
    }
  }

  for (const rel of SELF_FETCH_TARGETS) {
    const source = readSource(rel, mutate);
    for (const call of selfFetchMatches(source)) {
      failures.push(`[H] ${rel}: same-origin self-fetch 잔존 → ${call}`);
    }
  }

  for (const rel of PURITY_TARGETS) {
    const source = readSource(rel, mutate);
    if (/from\s+["']@\/app\/api\//.test(source)) {
      failures.push(`[S] ${rel}: @/app/api import 금지`);
    }
    if (/from\s+["']next\/server["']/.test(source)) {
      failures.push(`[S] ${rel}: next/server import 금지`);
    }
    if (/\bexport\s+(?:async\s+)?function\s+GET\b/.test(source) || /\bexport\s*\{\s*GET\b/.test(source)) {
      failures.push(`[S] ${rel}: GET export 금지`);
    }
  }

  const paritySource = readSource("src/lib/services/player-today-game.ts", mutate);
  for (const msg of checkParity(paritySource)) {
    failures.push(`[P] src/lib/services/player-today-game.ts: ${msg}`);
  }

  return failures;
}

if (process.argv.includes("--selftest")) {
  const mutations = [
    [
      "M1 H축 player-today-game self-fetch 주입",
      (rel, source) =>
        rel === "src/lib/services/player-today-game.ts"
          ? `${source}\nconst __mut1 = () => fetch(\"https://keubo.fan/api/game-detail?gameId=20260101LGOB0\");\n`
          : source,
      "[H]",
    ],
    [
      "M2 H축 widget self-fetch 주입",
      (rel, source) =>
        rel === "src/app/api/widget/player-card/route.ts"
          ? `${source}\nconst __mut2 = () => fetch(\"/api/player-stats?id=x&pos=%ED%83%80%EC%9E%90\");\n`
          : source,
      "[H]",
    ],
    [
      "M3 S축 purity 위반 재주입",
      (rel, source) =>
        rel === "src/lib/services/player-stats.ts"
          ? `${source}\nexport { GET } from \"@/app/api/player-stats/route\";\n`
          : source,
      "[S]",
    ],
    [
      "M4 P축 NextResponse 분기 재주입",
      (rel, source) =>
        rel === "src/lib/services/player-today-game.ts"
          ? `${source}\nimport { NextResponse } from \"next/server\";\nasync function __mut4(){ return NextResponse.json({ ok: true }); }\n`
          : source,
      "[P]",
    ],
    [
      "M5 W축 service 호출 제거",
      (rel, source) =>
        rel === "src/app/api/player-today-game/route.ts"
          ? source.replace("getPlayerTodayGameRouteResult(", "__removedRouteResult(")
          : source,
      "[W]",
    ],
  ];

  let ok = true;
  for (const [name, mutate, prefix] of mutations) {
    const failures = check({ mutate });
    const red = failures.some((line) => line.startsWith(prefix));
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
console.log("self-fetch-internal-gate PASS — wiring(W) · self-fetch(H) · purity(S) · parity(P) 충족");
