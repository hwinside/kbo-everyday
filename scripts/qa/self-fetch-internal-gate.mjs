#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const DEFERRED_ROUTE_CONTRACTS = [
  [
    "src/app/api/game-detail/route.ts",
    [
      /import\s+\{\s*NextRequest,\s*NextResponse,\s*after\s*\}\s+from\s+"next\/server"/,
      /function\s+scheduleDeferred\s*\(/,
      /after\(\(\)\s*=>\s*effect\(\)\)/,
      /onDeferredEffect:\s*\(effect\)\s*=>\s*\{\s*scheduleDeferred\(\(\)\s*=>\s*effect\(\)\);\s*\}/s,
    ],
  ],
  [
    "src/app/api/player-today-game/route.ts",
    [
      /import\s+\{\s*NextRequest,\s*NextResponse,\s*after\s*\}\s+from\s+"next\/server"/,
      /onDeferredEffect:\s*\(effect\)\s*=>\s*\{\s*scheduleDeferred\(\(\)\s*=>\s*effect\(\)\);\s*\}/s,
    ],
  ],
  [
    "src/app/api/widget/player-card/route.ts",
    [
      /import\s+\{\s*NextRequest,\s*NextResponse,\s*after\s*\}\s+from\s+"next\/server"/,
      /const\s+deferredEffects:\s+Array<\(\)\s*=>\s*Promise<void>>\s*=\s*\[\]/,
      /onDeferredEffect:\s*\(effect\)\s*=>\s*\{\s*deferredEffects\.push\(effect\);\s*\}/s,
      /for\s*\(const\s+effect\s+of\s+deferredEffects\)\s*\{\s*scheduleDeferred\(\(\)\s*=>\s*effect\(\)\);\s*\}/s,
    ],
  ],
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
  let source = readFileSync(rel, "utf8");
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

function runParityHarness() {
  try {
    execFileSync("npx", ["tsx", "scripts/qa/self-fetch-internal-parity.ts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240000,
    });
    return [];
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("[P]"));
  }
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

  for (const [rel, regexes] of DEFERRED_ROUTE_CONTRACTS) {
    const source = readSource(rel, mutate);
    for (const re of regexes) {
      if (!re.test(source)) failures.push(`[P] ${rel}: deferred parity 누락 ${re}`);
    }
  }

  failures.push(...runParityHarness());
  return failures;
}

function runSelfTest() {
  const targets = [
    "src/lib/services/player-today-game.ts",
    "src/app/api/widget/player-card/route.ts",
    "src/lib/services/player-stats.ts",
    "src/app/api/player-today-game/route.ts",
    "src/app/api/game-detail/route.ts",
  ];
  const backupDir = mkdtempSync(join(tmpdir(), "self-fetch-internal-gate-"));
  const backups = new Map();
  for (const file of targets) {
    const backup = join(backupDir, file.replaceAll("/", "__"));
    copyFileSync(file, backup);
    backups.set(file, backup);
  }

  const restoreAll = () => {
    for (const [file, backup] of backups) copyFileSync(backup, file);
  };

  const mutateFile = (file, from, to, label) => {
    const source = readFileSync(file, "utf8");
    if (!source.includes(from)) {
      throw new Error(`${label}: mutation anchor not found in ${file}`);
    }
    writeFileSync(file, source.replace(from, to));
  };

  const runGate = () => check();
  const base = runGate();
  if (base.length > 0) {
    console.error("BASE NOT GREEN:");
    for (const failure of base) console.error("  " + failure);
    restoreAll();
    rmSync(backupDir, { recursive: true, force: true });
    process.exit(1);
  }

  const mutations = [
    [
      "M1 H축 player-today-game self-fetch 주입",
      () => mutateFile(
        "src/lib/services/player-today-game.ts",
        "const HIDDEN = (",
        "const __mut1 = () => fetch(\"https://keubo.fan/api/game-detail?gameId=20260101LGOB0\");\n\nconst HIDDEN = (",
        "M1",
      ),
      "[H]",
    ],
    [
      "M2 H축 widget self-fetch 주입",
      () => mutateFile(
        "src/app/api/widget/player-card/route.ts",
        "function fmtAvg(n: number): string {",
        "const __mut2 = () => fetch(\"/api/player-stats?id=x&pos=%ED%83%80%EC%9E%90\");\n\nfunction fmtAvg(n: number): string {",
        "M2",
      ),
      "[H]",
    ],
    [
      "M3 S축 purity 위반 재주입",
      () => mutateFile(
        "src/lib/services/player-stats.ts",
        "const KBO_BASE = \"https://www.koreabaseball.com\";",
        "import { NextResponse } from \"next/server\";\n\nconst KBO_BASE = \"https://www.koreabaseball.com\";",
        "M3",
      ),
      "[S]",
    ],
    [
      "M4 P축 status 변조",
      () => mutateFile(
        "src/lib/services/player-today-game.ts",
        "        status: game.status,\n        isLive,\n        opponentName,\n        type,\n        batter: {",
        "        status: \"scheduled\",\n        isLive,\n        opponentName,\n        type,\n        batter: {",
        "M4",
      ),
      "[P]",
    ],
    [
      "M5 P축 Cache-Control 변조",
      () => mutateFile(
        "src/lib/services/player-today-game.ts",
        "const okHeaders = { \"Cache-Control\": \"s-maxage=20, stale-while-revalidate=40\" };",
        "const okHeaders = { \"Cache-Control\": \"s-maxage=999, stale-while-revalidate=999\" };",
        "M5",
      ),
      "[P]",
    ],
    [
      "M6 P축 body 구조 변조",
      () => mutateFile(
        "src/lib/services/player-today-game.ts",
        "onBase: row.hits + row.bb,",
        "totalBases: row.hits + row.bb,",
        "M6",
      ),
      "[P]",
    ],
    [
      "M7 P축 game-detail deferred scheduler 제거",
      () => mutateFile(
        "src/app/api/game-detail/route.ts",
        "      scheduleDeferred(() => effect());",
        "      void effect;",
        "M7",
      ),
      "[P]",
    ],
    [
      "M8 W축 player-today-game service 호출 제거",
      () => mutateFile(
        "src/app/api/player-today-game/route.ts",
        "getPlayerTodayGameRouteResult({",
        "__removedRouteResult({",
        "M8",
      ),
      "[W]",
    ],
  ];

  let ok = true;
  for (const [name, mutate, prefix] of mutations) {
    restoreAll();
    mutate();
    const failures = runGate();
    const red = failures.some((line) => line.startsWith(prefix));
    console.log(`${red ? "RED(기대대로 검출)" : "MISS(검출 실패)"} — ${name}`);
    if (!red) {
      ok = false;
      for (const failure of failures) console.log("  " + failure);
    }
  }

  restoreAll();
  rmSync(backupDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  runSelfTest();
} else {
  const failures = check();
  if (failures.length > 0) {
    console.error(`self-fetch-internal-gate FAIL (${failures.length}건)`);
    for (const failure of failures) console.error("  " + failure);
    process.exit(1);
  }
  console.log("self-fetch-internal-gate PASS — wiring(W) · self-fetch(H) · purity(S) · parity(P) 충족");
}
