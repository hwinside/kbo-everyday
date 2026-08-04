/**
 * freshness **래퍼 행동** 게이트 — 결정론적.
 *
 * ── 왜 필요한가(2026-08-05 삼순 P0) ─────────────────────────────
 * `stats-freshness-verify.mjs` 는 live KBO 를 타므로 데이터 무변경 PR 에서는 돌지 않는다
 * (paths 로 SKIP). 그런데 그 상태에서 래퍼를 `process.exit(0)` 한 줄로 바꾸거나
 * package alias 를 `echo ok` 로 만들어도, contract 게이트는 **alias 존재·문자열**만
 * 확인하므로 GREEN 이었다. 그 PR 이 머지된 뒤에는 데이터 PR 이 freshness 를 돌려도
 * 이미 무력화된 래퍼가 통과시킨다 — live equality 가 **0회** 수행된다.
 *
 * 즉 종전 분업에는 구멍이 있었다:
 *   contract = "래퍼가 존재한다"  /  freshness = "래퍼가 동작한다"
 * 이고, 후자는 데이터 PR 에서만 실행되므로 **코드 PR 은 아무도 안 본다.**
 *
 * 이 스모크가 그 자리를 메운다. live 네트워크 없이, 래퍼의 **판정 로직 자체**를
 * 스텁 검증기로 행동 검증한다. contract 게이트에 실려 모든 PR 에서 돈다.
 *
 * ── 검증 방식 ──────────────────────────────────────────────────
 * 래퍼는 검증기를 **상대경로로 spawn** 한다. 그래서 임시 작업트리에 같은 상대경로로
 * 스텁 검증기를 두고 cwd 를 옮겨 실행하면, 프로덕션 코드에 테스트 seam 을 뚫지 않고도
 * 원하는 시나리오(PASS/FAIL/flap/unreachable)를 그대로 재현할 수 있다.
 *
 * ⚠︎ 테스트 대상 파일은 **package.json alias 에서 해석**한다. 하드코딩하면
 * alias 를 no-op 으로 바꾼 변경을 이 스모크가 놓친다(그게 삼순이 지적한 경로 중 하나다).
 *   package alias → 실제 파일 → 그 파일의 행동
 * 이 사슬을 전부 결속한다.
 *
 * ── 2026-08-05 삼순 2차 NO-GO 반영 ──────────────────────────
 *
 * **(a) prod-mode bypass** — 종전 시나리오는 전부 seam=1 로만 돌았고, floor 테스트는
 * config 라인만 읽었다. 그래서 config 출력 직후 `if (!CONTRACT_TEST) process.exit(0)`
 * 한 줄이면 운영에서 검증기를 **0회** 실행하면서 모든 assertion 이 GREEN 이었다.
 * → prod 모드(seam 꺼진 상태)에서 검증기가 **실제로 spawn 되는지**를 marker 파일로
 *   직접 관측한다. 3분을 기다리지 않고 첫 회차 spawn 만 확인한 뒤 종료시킨다.
 *
 * **(b) decoy alias** — 종전엔 워크플로·RED proof 가 이 스모크를 npm alias 로 불렀고
 * trigger 는 alias 존재만 봤다. 그래서 mutation 을 인지하는 decoy alias 하나면
 * 실제 스모크를 0회 실행하고도 전체 GREEN 이 가능했다.
 * → 워크플로가 이 파일을 **경로로 직접 호출**하고(alias 경유 금지),
 *   alias ↔ 파일 경로를 **양방향 exact** 로 고정한다(trigger 스모크).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ALIAS = "qa:stats-freshness";
const VERIFIER_REL = "scripts/qa/stats-source-truth-verify.mjs";
const FRESHNESS_WORKFLOW = ".github/workflows/stats-freshness-gate.yml";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const results = [];
const check = (label, fn) => {
  fn();
  results.push(label);
};

/* ══ 1) actual binding — alias 가 실제 node 스크립트를 가리켜야 한다 ══
 *
 * `echo ok` 같은 no-op alias 는 여기서 죽는다. 종전 contract 게이트는
 * `pkg.scripts[name]` 존재만 봤기 때문에 no-op 을 통과시켰다. */
const rawCommand = pkg.scripts[SCRIPT_ALIAS];
check(`alias \`${SCRIPT_ALIAS}\` 존재`, () => {
  assert.ok(rawCommand, `package.json 에 \`${SCRIPT_ALIAS}\` 가 없다`);
});

const match = /^node\s+(\S+\.mjs)$/.exec(rawCommand.trim());
check("alias 가 node 스크립트를 실행", () => {
  assert.ok(
    match,
    `\`${SCRIPT_ALIAS}\` 는 node 스크립트를 실행해야 한다.`
      + " echo/true 같은 no-op 으로 바뀌면 데이터 PR 에서 live 대조가 0회 수행된다."
      + ` actual: ${rawCommand}`,
  );
});

const WRAPPER_REL = match[1];
const wrapperSource = readFileSync(WRAPPER_REL, "utf8");

check("freshness 워크플로가 이 alias 를 호출", () => {
  const workflow = readFileSync(FRESHNESS_WORKFLOW, "utf8");
  assert.ok(
    new RegExp(`npm run ${SCRIPT_ALIAS}(?![\\w-])`).test(workflow),
    `${FRESHNESS_WORKFLOW} 가 \`npm run ${SCRIPT_ALIAS}\` 를 호출해야 한다`,
  );
});

check("워크플로가 안정성 파라미터를 env 로 흔들지 않음", () => {
  const workflow = readFileSync(FRESHNESS_WORKFLOW, "utf8");
  assert.ok(
    !/STATS_FRESHNESS_/.test(workflow),
    "워크플로에서 STATS_FRESHNESS_* env 를 설정하면 안정성 계약(안정 window·cooldown)을"
      + " CI 한 줄로 흔들 수 있다. 하한은 코드 상수로만 관리한다.",
  );
});

/* ══ 2) 행동 검증 — 스텁 검증기로 시나리오를 재현한다 ══════════ */

/**
 * 임시 작업트리를 만들고 래퍼를 그대로 복사한 뒤, 스텁 검증기를 심어 실행한다.
 *
 * @param verdicts 회차별 스텁 판독. "PASS" | "FAIL:<label>" | "UNREACHABLE"
 */
function runWrapper(verdicts, env = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "freshness-contract-"));
  try {
    mkdirSync(path.join(root, "scripts", "qa"), { recursive: true });
    copyFileSync(WRAPPER_REL, path.join(root, WRAPPER_REL));

    const statePath = path.join(root, "attempt.json");
    writeFileSync(statePath, "0");
    writeFileSync(
      path.join(root, VERIFIER_REL),
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `const verdicts = ${JSON.stringify(verdicts)};`,
        `const statePath = ${JSON.stringify(statePath)};`,
        "const i = Number(readFileSync(statePath, 'utf8'));",
        "writeFileSync(statePath, String(i + 1));",
        "const verdict = verdicts[Math.min(i, verdicts.length - 1)];",
        "if (verdict === 'PASS') { console.log('stub: ok'); process.exit(0); }",
        "if (verdict === 'UNREACHABLE') {",
        "  console.error('  - source_unreachable: stub');",
        "  process.exit(1);",
        "}",
        "console.error('  - ' + verdict.slice(5));",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [WRAPPER_REL], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, STATS_FRESHNESS_CONTRACT_TEST: "1", ...env },
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 계약 테스트용 짧은 파라미터. 하한 clamp 는 CONTRACT_TEST 로만 해제된다. */
const FAST = {
  STATS_FRESHNESS_COOLDOWN_MS: "120",
  STATS_FRESHNESS_STABILITY_WINDOW_MS: "200",
  STATS_FRESHNESS_MAX_ATTEMPTS: "6",
};

check("안정 PASS → exit 0", () => {
  const run = runWrapper(["PASS", "PASS", "PASS", "PASS"], FAST);
  assert.equal(run.status, 0, `안정된 PASS 는 통과해야 한다\n${run.output}`);
});

check("안정 FAIL → exit 1 + stats_freshness_mismatch", () => {
  const run = runWrapper(
    ["FAIL:pitcher 곽빈: era 1.00 != 2.00", "FAIL:pitcher 곽빈: era 1.00 != 2.00", "FAIL:pitcher 곽빈: era 1.00 != 2.00"],
    FAST,
  );
  assert.equal(run.status, 1, `재현된 불일치는 RED 여야 한다\n${run.output}`);
  assert.match(run.output, /stats_freshness_mismatch/, "진짜 불일치로 분류해야 한다");
});

check("판독 flap → exit 1 + stats_source_unstable (통과 아님)", () => {
  const run = runWrapper(
    ["PASS", "FAIL:defense 전다민: 좌익수 누락", "PASS", "FAIL:defense 전다민: 좌익수 누락", "PASS", "FAIL:defense 전다민: 좌익수 누락"],
    FAST,
  );
  assert.equal(run.status, 1, `흔들리는 판독을 통과시키면 안 된다(temporal green)\n${run.output}`);
  assert.match(run.output, /stats_source_unstable/, "불안정으로 분류해야 한다");
});

check("수집 불가 → exit 1 + stats_source_unreachable", () => {
  const run = runWrapper(["UNREACHABLE", "PASS", "PASS", "PASS"], FAST);
  assert.equal(run.status, 1, `검증 불가를 통과로 취급하면 안 된다\n${run.output}`);
  assert.match(run.output, /stats_source_unreachable/, "수집 불가로 분류해야 한다");
});

/* ── 안정 window 계약 ────────────────────────────────────────
 * #1103 전다민 flip 은 분 단위였다. 20초 간격 2회는 그 주기 안에 통째로 들어가
 * "안정"으로 오인될 수 있다. 그래서 판정은 횟수가 아니라 **시간 폭**으로 한다.
 * 여기서는 짧은 cooldown 으로 시도 전체가 window 를 못 덮게 만들고,
 * 그때 PASS 가 연달아 나와도 통과하지 않는지 본다. */
check("연속 PASS 라도 안정 window 미달이면 통과하지 않음", () => {
  const run = runWrapper(["PASS", "PASS", "PASS"], {
    STATS_FRESHNESS_COOLDOWN_MS: "0",
    STATS_FRESHNESS_STABILITY_WINDOW_MS: "600000",
    STATS_FRESHNESS_MAX_ATTEMPTS: "3",
  });
  assert.equal(
    run.status,
    1,
    "안정 window 를 덮지 못한 연속 PASS 는 보류여야 한다 — 이게 없으면"
      + ` 짧은 2회 판독이 flip 주기 안에 들어가 temporal green 이 된다\n${run.output}`,
  );
  assert.match(run.output, /stats_source_unstable/);
});

/* ── 하한(floor) 계약 ────────────────────────────────────────
 * CONTRACT_TEST 없이 env 로 값을 줄이려 하면 코드 상수 하한으로 clamp 돼야 한다.
 * 하한이 없으면 CI 에서 `COOLDOWN=0` 한 줄로 이 계약 전체가 무력화된다. */
check("env 로 안정성 파라미터를 낮출 수 없음(floor clamp)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "freshness-floor-"));
  try {
    mkdirSync(path.join(root, "scripts", "qa"), { recursive: true });
    copyFileSync(WRAPPER_REL, path.join(root, WRAPPER_REL));
    // 즉시 종료하는 스텁 — config 라인만 보고 판단하므로 실행 시간은 짧다.
    writeFileSync(
      path.join(root, VERIFIER_REL),
      "console.error('  - source_unreachable: stub'); process.exit(1);",
    );
    const run = spawnSync(process.execPath, [WRAPPER_REL], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        STATS_FRESHNESS_CONTRACT_TEST: "",
        STATS_FRESHNESS_COOLDOWN_MS: "0",
        STATS_FRESHNESS_STABILITY_WINDOW_MS: "1",
        STATS_FRESHNESS_MAX_ATTEMPTS: "1",
      },
      timeout: 60_000,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const config = /stability window (\d+)ms · cooldown (\d+)ms · max attempts (\d+)/.exec(output);
    assert.ok(config, `config 라인을 찾지 못했다 — 파라미터를 관측할 수 없다\n${output}`);
    const [, window, cooldown, attempts] = config.map(Number);
    assert.ok(
      window >= 180_000,
      `안정 window 하한(180000ms)이 env 로 뚫렸다 — actual ${window}ms`,
    );
    assert.ok(cooldown >= 15_000, `cooldown 하한(15000ms)이 env 로 뚫렸다 — actual ${cooldown}ms`);
    // attempts 하한은 고정값이 아니라 window/cooldown 에서 파생된다(삼순 P1).
    const needed = Math.ceil(window / cooldown) + 1;
    assert.ok(
      attempts >= needed,
      `attempts 하한이 env 로 뚫렸다 — actual ${attempts}, 필요 ${needed}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── seam 이 프로덕션 경로로 새지 않는지 ───────────────────────── */
/* ══ self-binding — 이 스모크가 decoy 로 갈려달 수 없게 ══════════
 *
 * ⚠︎ 삼순 2차 NO-GO(b): 종전엔 워크플로·RED proof 가 이 스모크를 npm alias 로 불렀고
 * trigger 는 alias 존재만 봤다. 그래서 mutation 을 인지하는 decoy alias 하나면
 * 실제 스모크를 0회 실행하고도 전체 GREEN 이 가능했다.
 *
 * 이제 워크플로는 이 파일을 **경로로 직접** 부르고, alias 는 유지하되 그 alias 가
 * 정확히 이 파일을 가리키는지를 **양방향 exact** 로 고정한다. 자기 자신을 직접
 * 검사하므로 decoy 로 바꾸는 순간 이 assertion 이 죽는다. */
const SELF_REL = path.relative(process.cwd(), fileURLToPath(import.meta.url));
const CONTRACT_ALIAS = "qa:stats-freshness-contract";
const CONTRACT_WORKFLOW = ".github/workflows/stats-contract-gate.yml";

check(`alias \`${CONTRACT_ALIAS}\` ↔ 이 파일 exact 양방향 결속`, () => {
  const alias = pkg.scripts[CONTRACT_ALIAS];
  assert.ok(alias, `package.json 에 \`${CONTRACT_ALIAS}\` 가 없다`);
  const aliasMatch = /^node\s+(\S+\.mjs)$/.exec(alias.trim());
  assert.ok(
    aliasMatch,
    `\`${CONTRACT_ALIAS}\` 는 node 스크립트를 실행해야 한다 (actual: ${alias})`,
  );
  assert.equal(
    path.normalize(aliasMatch[1]),
    path.normalize(SELF_REL),
    `\`${CONTRACT_ALIAS}\` 가 이 스모크(${SELF_REL})를 가리키지 않는다 —`
      + " decoy alias 로 갈려놓고 실제 검증을 0회 실행할 수 있다",
  );
});

check("contract 게이트가 이 스모크를 경로로 직접 호출(alias 경유 금지)", () => {
  const workflow = readFileSync(CONTRACT_WORKFLOW, "utf8");
  assert.ok(
    workflow.includes(`node ${SELF_REL}`),
    `${CONTRACT_WORKFLOW} 가 \`node ${SELF_REL}\` 를 직접 호출해야 한다 —`
      + " npm alias 경유로 부르면 decoy alias 하나로 전체를 우회할 수 있다",
  );
  assert.ok(
    !new RegExp(`npm run ${CONTRACT_ALIAS}(?![\\w-])`).test(workflow),
    `${CONTRACT_WORKFLOW} 가 이 스모크를 npm alias 로 부르면 안 된다(decoy 우회 경로)`,
  );
});

check("CONTRACT_TEST seam 은 래퍼 안에서만 참조", () => {
  assert.ok(
    /STATS_FRESHNESS_CONTRACT_TEST/.test(wrapperSource),
    "계약 테스트 seam 이 사라졌다 — 결정론적 행동 검증이 불가능해진다",
  );
  const workflows = [FRESHNESS_WORKFLOW, CONTRACT_WORKFLOW];
  for (const file of workflows) {
    assert.ok(
      !/STATS_FRESHNESS_CONTRACT_TEST/.test(readFileSync(file, "utf8")),
      `${file} 이 CONTRACT_TEST seam 을 켜면 안 된다`,
    );
  }
});

/* ══ 3) prod-mode bypass — seam 이 꺼졌을 때 검증기가 실제로 도는가 ══
 *
 * ⚠︎ 삼순 2차 NO-GO 의 핵심. 위 시나리오는 전부 seam=1 로 돌았고 floor 테스트는
 * config 라인만 읽었다. 그래서 config 출력 직후 `if (!CONTRACT_TEST) process.exit(0)`
 * 한 줄이면 전부 통과하고, 운영에서는 live equality 가 **0회** 수행된다.
 *
 * 여기서는 seam 을 **비운 채**(= 운영과 동일) 래퍼를 띄우고, 검증기가 spawn 되면
 * marker 파일을 쓰게 해 그 흔적을 직접 관측한다. 안정 window(3분)를 다 기다리지 않고
 * **첫 회차 spawn** 만 확인한 뒤 종료시킨다. */
check("prod 모드에서 검증기가 실제로 실행됨(seam bypass 차단)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "freshness-prod-"));
  try {
    mkdirSync(path.join(root, "scripts", "qa"), { recursive: true });
    copyFileSync(WRAPPER_REL, path.join(root, WRAPPER_REL));

    const marker = path.join(root, "verifier-invoked.marker");
    writeFileSync(
      path.join(root, VERIFIER_REL),
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(marker)}, 'invoked\\n');`,
        "console.log('stub: ok');",
        "process.exit(0);",
      ].join("\n"),
    );

    const child = spawnSync(process.execPath, [WRAPPER_REL], {
      cwd: root,
      encoding: "utf8",
      // seam 을 명시적으로 비운다 = 운영과 동일한 경로.
      env: { ...process.env, STATS_FRESHNESS_CONTRACT_TEST: "" },
      // 안정 window 를 다 기다리지 않는다 — 첫 spawn 만 보면 충분하다.
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;

    assert.ok(
      existsSync(marker),
      "prod 모드에서 검증기가 한 번도 실행되지 않았다 — seam 이 꺼졌을 때"
        + " 조기 종료하는 우회로가 있으면 운영에서 live equality 가 0회 수행된다"
        + `\n${output}`,
    );
    assert.ok(
      !/CONTRACT_TEST=1/.test(output),
      `seam 을 비워도 계약테스트 모드로 동작했다\n${output}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ══ 4) 도달 가능성 — 안정된 데이터가 실제로 PASS 할 수 있는가 ══
 *
 * 삼순 P1: 고정 attempts 6 은 180s/15s 에서 경과시간 최대 약 75s 밖에 안 돼
 * **안정된 데이터조차 영원히 PASS 불가**였다. 통과 불가능한 게이트는
 * 사실상 데이터 PR 을 영구 차단한다. attempts 를 window/cooldown 에서 파생시켜
 * 그 관계가 유지되는지 prod 설정 config 로 확인한다. */
check("prod 설정이 안정 window 에 도달 가능(attempts 파생)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "freshness-reach-"));
  try {
    mkdirSync(path.join(root, "scripts", "qa"), { recursive: true });
    copyFileSync(WRAPPER_REL, path.join(root, WRAPPER_REL));
    writeFileSync(
      path.join(root, VERIFIER_REL),
      "console.error('  - source_unreachable: stub'); process.exit(1);",
    );
    const child = spawnSync(process.execPath, [WRAPPER_REL], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, STATS_FRESHNESS_CONTRACT_TEST: "" },
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    const config = /stability window (\d+)ms · cooldown (\d+)ms · max attempts (\d+)/.exec(output);
    assert.ok(config, `config 라인을 찾지 못했다\n${output}`);
    const [, window, cooldown, attempts] = config.map(Number);
    const needed = Math.ceil(window / cooldown) + 1;
    assert.ok(
      attempts >= needed,
      `attempts ${attempts} 로는 안정 window ${window}ms 를 덮을 수 없다(필요 ${needed}).`
        + " 안정된 데이터조차 PASS 불가능해져 데이터 PR 이 영우히 머지되지 않는다",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`stats freshness contract smoke: ${results.length} assertions PASS`);
for (const label of results) console.log(`  ✓ ${label}`);
