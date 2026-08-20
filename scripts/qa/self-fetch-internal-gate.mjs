#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUTATION_TARGETS } from "./self-fetch-mutation-targets.mjs";

/**
 * 외부 cleanup selftest 전용 프로브 모드(--cleanup-probe=<throw|exit|sigint|sigterm>).
 * 변이를 적용한 직후 해당 경로로 강제 이탈해, 부모 프로세스가
 * "이탈 후 전 대상 byte-identical"을 검증할 수 있게 한다.
 */
const CLEANUP_PROBE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--cleanup-probe="));
  return arg ? arg.slice("--cleanup-probe=".length) : null;
})();

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

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
  // 변이 대상 파일은 전부 백업 목록에 있어야 한다. 하나라도 빠지면 selftest 종료 후
  // 변이가 워킹트리에 남고, 그대로 커밋되어 프로덕션 응답계약이 깨진다(#1257 실제 사고).
  // 목록은 SSOT 한 곳(self-fetch-mutation-targets.mjs)에서만 온다 — 외부 cleanup selftest 와
  // 따로 적으면 list drift 가 생기고, 그 drift 가 정확히 이번 사고의 형태다.
  const targets = MUTATION_TARGETS;
  const backupDir = mkdtempSync(join(tmpdir(), "self-fetch-internal-gate-"));
  const backups = new Map();
  for (const file of targets) {
    const backup = join(backupDir, file.replaceAll("/", "__"));
    copyFileSync(file, backup);
    backups.set(file, backup);
  }

  // 복원은 "바이트가 실제로 같아졌는가"까지 확인해야 성공이다. copyFileSync 가 예외 없이
  // 돌아왔다는 사실만으로는 부족하다(부분 복원·디스크 오류).
  const restoreAll = () => {
    const unrestored = [];
    for (const [file, backup] of backups) {
      try {
        copyFileSync(backup, file);
      } catch (error) {
        unrestored.push(`${file} (copy 실패: ${error?.message ?? error})`);
        continue;
      }
      if (readFileSync(file, "utf8") !== readFileSync(backup, "utf8")) {
        unrestored.push(`${file} (바이트 불일치)`);
      }
    }
    return unrestored;
  };

  const mutateFile = (file, from, to, label) => {
    if (!backups.has(file)) {
      throw new Error(`${label}: ${file} 이 백업 목록(targets)에 없다 — 변이가 워킹트리에 남는다`);
    }
    const source = readFileSync(file, "utf8");
    if (!source.includes(from)) {
      throw new Error(`${label}: mutation anchor not found in ${file}`);
    }
    writeFileSync(file, source.replace(from, to));
  };

  // ── 잔재 방지 계약 ──
  // 변이는 tracked source 를 직접 쓴다. 복원이 **정상 종료 경로에만** 있으면
  // runGate 예외·Ctrl-C(SIGINT)·SIGTERM 에서 변이가 워킹트리에 그대로 남고,
  // 그대로 커밋되어 프로덕션 응답계약이 깨진다(#1257 실제 사고).
  // → 모든 이탈 경로에서 idempotent 로 복원한다.
  // cleanedUp 은 **복원 성공 + byte 검증 통과** 뒤에만 세운다. 실패했는데 완료로 찍으면
  // 이후 exit/uncaught 재시도가 전부 no-op 이 되어 잔재가 그대로 남는다(false-green).
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return true;
    let unrestored = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        unrestored = restoreAll();
      } catch (error) {
        unrestored = [`restoreAll 예외: ${error?.message ?? error}`];
      }
      if (unrestored.length === 0) {
        cleanedUp = true;
        try {
          rmSync(backupDir, { recursive: true, force: true });
        } catch {
          /* temp 정리 실패는 잔재 판정과 무관 */
        }
        return true;
      }
      console.error(`CLEANUP RETRY ${attempt}/3 — 미복원 ${unrestored.length}건`);
    }
    // fail-close: 완료로 찍지 않는다(다음 이탈 경로가 다시 시도할 수 있어야 한다).
    for (const item of unrestored) console.error(`  CLEANUP FAILED — ${item}`);
    console.error(`  백업 원본은 남겨둔다(수동 복구용): ${backupDir}`);
    return false;
  };
  const onSignal = (signal) => {
    const ok = cleanup();
    // 복원 실패는 신호 기본 코드로 덮지 않는다 — 잔재가 남았음을 종료코드로 드러낸다.
    if (!ok) process.exit(1);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("exit", () => {
    // 'exit' 핸들러에서는 종료코드를 바꿀 수 없다 → 실패 사실만 남긴다(부모 selftest 가 잔재로 잡는다).
    cleanup();
  });
  process.on("uncaughtException", (error) => {
    cleanup();
    console.error(`UNCAUGHT — ${error?.stack ?? error}`);
    process.exit(1);
  });

  // 외부 selftest(--selftest-cleanup) 전용 강제 이탈 프로브.
  // 변이를 적용한 직후 각 이탈 경로를 실제로 타워서, 부모가 "전 대상 byte-identical"을 검증한다.
  // 적용 사실을 해시로 출력해 — 변이가 실제로 일어난 뒤 죽었음을 증명한다(공허한 통과 방지).
  if (CLEANUP_PROBE) {
    // restore-fail: 복원 실패 시 fail-close 계약(삼순 #1257 5차 잔여 조건) 외부 검증용.
    // tracked source 는 건드리지 않는다 — temp sandbox 파일을 backup 맵에 등록하고 변이한 뒤,
    // 대상을 디렉토리로 바꿔 copyFileSync 복원을 **결정적으로** 실패시킨다.
    // 기대 계약: cleanup()=false · exit 1 · backupDir(복구 원본) 보존 · tracked 전수 무결.
    if (CLEANUP_PROBE === "restore-fail") {
      const sandboxDir = mkdtempSync(join(tmpdir(), "self-fetch-restore-fail-"));
      const sandboxTarget = join(sandboxDir, "target.txt");
      writeFileSync(sandboxTarget, "original");
      const sandboxBackup = join(backupDir, "sandbox__target.txt");
      copyFileSync(sandboxTarget, sandboxBackup);
      backups.set(sandboxTarget, sandboxBackup);
      writeFileSync(sandboxTarget, "mutated");
      console.log(`PROBE_MUTATED ${sha256(sandboxTarget)}`);
      // 복원 실패 주입: 파일 → 디렉토리 (copyFileSync EISDIR, 권한·OS 무관 결정적)
      rmSync(sandboxTarget);
      mkdirSync(sandboxTarget);
      const ok = cleanup();
      console.log(
        `RESTORE_FAIL_PROBE cleanedUp=${ok} backupDirPreserved=${existsSync(backupDir)} ` +
        `backupIntact=${existsSync(sandboxBackup) && readFileSync(sandboxBackup, "utf8") === "original"}`,
      );
      // 검증 후 sandbox 잔재는 직접 정리(부모가 backupDir 보존을 확인한 뒤 부모가 삭제).
      rmSync(sandboxDir, { recursive: true, force: true });
      process.exit(ok ? 0 : 1);
    }
    const probeFile = "src/app/api/stats/route.ts";
    mutateFile(probeFile, "    headers: result.headers,", "    headers: undefined,", "PROBE");
    console.log(`PROBE_MUTATED ${sha256(probeFile)}`);
    if (CLEANUP_PROBE === "sigint" || CLEANUP_PROBE === "sigterm") {
      // 신호 대기(Ctrl-C 재현). try/finally 밖이라 복원은 신호 핸들러만이 할 수 있다.
      setInterval(() => {}, 1000);
      return;
    }
    if (CLEANUP_PROBE === "exit") {
      // process.exit 은 finally 를 건너뛴다 — 'exit' 핸들러만이 복원할 수 있다.
      process.exit(3);
    }
    // "throw": try/finally 경로
    try {
      throw new Error("forced failure after mutation (cleanup contract probe)");
    } finally {
      cleanup();
    }
  }

  try {
    runMutations();
  } finally {
    // 삼순 #1257 4차 ③: 복원 실패 시 backupDir 는 유일한 복구 원본이다 — 무조건 삭제 금지.
    // 성공 경로의 temp 삭제는 cleanup() 내부(byte 검증 통과 후)가 담당한다.
    if (!cleanup()) process.exitCode = 1;
  }

  function runMutations() {
  const runGate = () => check();
  const base = runGate();
  if (base.length > 0) {
    console.error("BASE NOT GREEN:");
    for (const failure of base) console.error("  " + failure);
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
    [
      "M9 W축 widget/player-card service 호출 제거 (player-stats)",
      () => mutateFile(
        "src/app/api/widget/player-card/route.ts",
        "        const result = await getPlayerStatsRouteResult(kboId, pos);",
        "        const result = await __removedStatsResult(kboId, pos);",
        "M9",
      ),
      "[W]",
    ],
    [
      "M10 W축 widget/player-card service 호출 제거 (player-today-game)",
      () => mutateFile(
        "src/app/api/widget/player-card/route.ts",
        "        const result = await getPlayerTodayGameRouteResult({",
        "        const result = await __removedTodayResult({",
        "M10",
      ),
      "[W]",
    ],
    [
      "M11 W축 widget/player-card service import 제거 (stats)",
      () => mutateFile(
        "src/app/api/widget/player-card/route.ts",
        "import { getStatsRouteResult } from \"@/lib/services/stats\";",
        "const getStatsRouteResult = async (_: unknown) => ({ body: { stats: [] } });",
        "M11",
      ),
      "[W]",
    ],
    [
      "M12 P축 widget deferred effect 실행 제거",
      () => mutateFile(
        "src/app/api/widget/player-card/route.ts",
        "    scheduleDeferred(() => effect());",
        "    void effect;",
        "M12",
      ),
      "[P]",
    ],
    [
      "M13 P축 player-stats route status 누락(route 래퍼 파손)",
      () => mutateFile(
        "src/app/api/player-stats/route.ts",
        "    status: result.status,",
        "    status: 200,",
        "M13",
      ),
      "[P]",
    ],
    [
      "M14 P축 stats route Cache-Control 누락(route 래퍼 파손)",
      () => mutateFile(
        "src/app/api/stats/route.ts",
        "    headers: result.headers,",
        "    headers: undefined,",
        "M14",
      ),
      "[P]",
    ],
    [
      "M15 P축 player-game-logs route body 변조(route 래퍼 파손)",
      () => mutateFile(
        "src/app/api/player-game-logs/route.ts",
        "  return NextResponse.json(result.body, {",
        "  return NextResponse.json({ ...result.body, __injected: true }, {",
        "M15",
      ),
      "[P]",
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

  // 복원 검증은 cleanup() 안에 있다(restoreAll 이 byte 대조해 미복원 목록을 돌려준다).
  // 여기서 따로 백업본을 읽지 않는다 — 성공 시 temp 는 이미 지워졌기 때문이다.
  if (!cleanup()) {
    console.error("RESTORE FAILED — 변이 잔재가 워킹트리에 남았다");
    ok = false;
  }
  process.exit(ok ? 0 : 1);
  }
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
