/**
 * 게이트 **trigger 커버리지** 스모크.
 *
 * ── 배경(2026-08-04, 삼순 연속 지적 + 하린아빠 결정) ──
 * workflow 에 `paths`/`paths-ignore` 가 있으면, 거기 안 걸리는 변경에서 workflow 가
 * 통째 SKIP 되고 required check 는 "통과"로 보인다 — **trigger 자체가 false-green** 이다.
 *
 * ⚠︎ 직접 파싱은 두 번 뚫렸다(삼순 실증).
 *   1차: `^\s*paths:\s*$` 줄 정규식 → inline flow(`paths: ["docs/**"]`) 통과
 *   2차: 손으로 만든 들여쓰기 파서 → 6칸 indent(`      paths:`)와
 *        quoted key(`"paths":`) 변형 통과. 둘 다 **유효한 YAML** 이다.
 *
 * YAML 은 같은 의미를 표현하는 방법이 너무 많아서 자체 파서로는 못 닫는다.
 * 그래서 **실제 YAML parser** 로 읽는다. parser 를 쓸 수 없으면 SKIP 이 아니라 FAIL 이다
 * (검증 불가를 통과로 취급하면 게이트가 아니다).
 *
 * ── 2026-08-05: 게이트 2분할에 맞춰 계약을 확장 ──────────────────
 * 종전에는 단일 `stats-source-truth-gate.yml` 이 계약 검증과 live 대조를 함께 했고,
 * paths 가 아예 없어야 한다는 계약만 있으면 충분했다. 이제는 성격이 나뉜다.
 *
 *   - stats-contract-gate  : 결정론적. **paths 금지**(모든 PR 에서 돌아야 한다).
 *   - stats-freshness-gate : live KBO 대조. 스냅샷이 바뀔 때만 도는 게 맞으므로
 *                            paths 를 **허용**한다. 대신 그 목록이 검증기가 읽는
 *                            입력을 전부 덮어야 한다 — 하나라도 빠지면 그 파일만
 *                            바뀐 데이터 PR 이 게이트를 SKIP 하고 초록으로 보인다.
 *
 * 즉 freshness 의 paths 는 성능 최적화가 아니라 **정확성 계약**이고, 그래서 여기서
 * 검증기 소스를 직접 읽어 대조한다. 목록을 손으로 적은 상수와 비교하면 그 상수가
 * stale 해지는 순간 같은 구멍이 다시 열리므로, 실제 검증기 코드를 오라클로 쓴다.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// ⚠︎ minimatch 는 CJS 라 named import 가 안 된다(Node 24 에서 SyntaxError).
// glob 매칭을 자체 구현하면 `*` 와 `**` 경계에서 또 뚫리므로 검증된 구현을 쓴다.
import minimatchPkg from "minimatch";
const minimatch = minimatchPkg.minimatch ?? minimatchPkg;

const CONTRACT_WORKFLOW = ".github/workflows/stats-contract-gate.yml";
const FRESHNESS_WORKFLOW = ".github/workflows/stats-freshness-gate.yml";
const VERIFIER = "scripts/qa/stats-source-truth-verify.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/* ── 실제 YAML parser 로 읽는다 ──────────────────────────────────
 * `on` 은 YAML 1.1 에서 boolean true 로 파싱된다 — 그 함정까지 parser 가 처리한다. */
async function parseOn(path) {
  const source = readFileSync(path, "utf8");
  const errors = [];

  // ① Node 생태계 parser 를 먼저 쓴다(런너 환경 의존이 가장 적다).
  for (const mod of ["yaml", "js-yaml"]) {
    try {
      const lib = await import(mod);
      const api = lib.default ?? lib;
      const doc = api.parse ? api.parse(source) : api.load(source);
      // YAML 1.1 에서 `on:` 은 boolean true 로 온다. 두 표기 모두 받는다.
      const on = doc?.on ?? doc?.[true] ?? doc?.["true"];
      if (on) return { doc, on, source };
      errors.push(`${mod}: on 블록을 찾지 못함`);
    } catch (error) {
      errors.push(`${mod}: ${error.message}`);
    }
  }

  // ② python3 + PyYAML 폴백.
  const script = [
    "import json, sys, yaml",
    'with open(sys.argv[1], encoding="utf-8") as f:',
    "    doc = yaml.safe_load(f)",
    'on = doc.get(True, doc.get("on"))',
    'print(json.dumps({"doc": doc, "on": on}, default=str))',
  ].join("\n");
  try {
    const out = execFileSync("python3", ["-c", script, path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return { doc: parsed.doc, on: parsed.on, source };
  } catch (error) {
    errors.push(`python3: ${error.message}`);
  }

  // ⚠︎ parser 를 못 쓰면 SKIP 이 아니라 FAIL 이다.
  throw new Error(
    `stats_gate_trigger_unparsable: ${path} 를 YAML parser 로 읽지 못했다 — ${errors.join(" | ")}`,
  );
}

/** 게이트가 부르는 npm script 가 package.json 에 실재하는지 확인한다. */
function assertScriptsExist(source, label, minimum) {
  const runSteps = [...source.matchAll(/run:\s*npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]);
  assert.ok(
    runSteps.length >= minimum,
    `${label}: npm script 를 최소 ${minimum}개 실행해야 한다 (actual ${runSteps.length})`,
  );
  for (const name of new Set(runSteps)) {
    assert.ok(
      pkg.scripts[name],
      `${label}: package.json 에 \`${name}\` script 가 없다 — 게이트가 죽은 스텝을 부른다`,
    );
  }
}

/* ══ 1) contract 게이트 — paths 금지, 전 PR·main push 등록 ══════ */
{
  const { doc, on, source } = await parseOn(CONTRACT_WORKFLOW);
  assert.ok(on && typeof on === "object", "contract 게이트의 `on:` 블록을 파싱할 수 있어야 한다");

  const offenders = [];
  for (const [event, spec] of Object.entries(on)) {
    if (!spec || typeof spec !== "object") continue;
    for (const key of Object.keys(spec)) {
      if (/^paths(-ignore)?$/.test(key)) offenders.push(`${event}.${key}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "contract 게이트에 paths/paths-ignore 가 있으면 거기 안 걸리는 변경에서 workflow 가 통째 SKIP 되고"
      + " required check 가 '통과'로 보인다(trigger false-green)."
      + ` 이 게이트는 네트워크를 타지 않아 항상 돌 수 있다. 검출: ${offenders.join(", ")}`,
  );

  assert.ok("pull_request" in on, "contract 게이트에 pull_request 트리거가 있어야 한다");
  assert.ok("push" in on, "contract 게이트에 push 트리거가 있어야 한다");
  const branches = on.push?.branches;
  assert.ok(
    Array.isArray(branches) && branches.includes("main"),
    `contract 게이트의 push 는 main 을 대상으로 해야 한다 (actual: ${JSON.stringify(branches)})`,
  );

  assertScriptsExist(source, "contract 게이트", 3);

  /* ── freshness 래퍼 행동 계약이 여기 실려야 한다 ────────────────
   *
   * ⚠︎ 삼순 P0(2026-08-05): freshness 게이트는 데이터 PR 에서만 돈다. 그래서 코드 PR 에서
   * 래퍼를 `process.exit(0)` 으로 비우거나 alias 를 no-op 으로 바꿔도 아무 게이트도 안 잡았다
   * — alias 존재·문자열 확인만 했기 때문이다. 그 PR 이 머지되면 이후 데이터 PR 은 이미
   * 무력화된 래퍼를 통과시켜 live equality 가 0회 수행된다.
   *
   * 그래서 래퍼의 **판정 행동**을 결정론적으로 검증하는 스모크를 contract 게이트에 싣는다.
   * 이 결속이 빠지면 위 구멍이 그대로 다시 열리므로 여기서 고정한다. */
  /* ⚠︎ 삼순 3차 NO-GO: 문자열/정규식으로 `run: node ...` 포함만 보면 안 된다.
   * 아래는 전부 유효한 YAML 이고 실제 스모크를 0회/실패무시로 만든다:
   *   - run: node ... || true
   *   - run: node ... + if: false
   *   - job 자체 if: false
   *   - continue-on-error: true
   * baseline 이 RED 여도 뒤 mutation proof 는 "expected failure"라 workflow 전체가 GREEN 가능하다.
   *
   * 그래서 실제 YAML 구조를 읽어 **유일한 baseline step** 을 특정하고,
   * run 값 exact·step/job if 없음·continue-on-error 없음·shell override 없음까지 고정한다. */
  const job = doc?.jobs?.["stats-contract"];
  assert.ok(job && typeof job === "object", "stats-contract job 이 있어야 한다");
  assert.ok(
    !("if" in job),
    "stats-contract job 에 if 조건이 있으면 job 전체를 SKIP 해 required check false-green 이 된다",
  );
  assert.ok(
    !("continue-on-error" in job),
    "stats-contract job 에 continue-on-error 가 있으면 baseline RED 를 무시할 수 있다",
  );

  const baselineName = "Freshness wrapper behavior contract (deterministic)";
  const matches = (job.steps ?? []).filter((step) => step?.name === baselineName);
  assert.equal(
    matches.length,
    1,
    `freshness 행동 baseline step 은 정확히 1개여야 한다 (actual ${matches.length})`,
  );
  const baseline = matches[0];
  assert.equal(
    baseline.run,
    "node scripts/qa/stats-freshness-contract-smoke.mjs",
    "freshness 행동 baseline 은 파일 경로를 exact 로 직접 실행해야 한다."
      + " `|| true`, 파이프, 후속 명령, npm alias 는 실패를 숨기거나 decoy 로 우회할 수 있다",
  );
  assert.ok(
    !("if" in baseline),
    "freshness 행동 baseline step 에 if 가 있으면 실제 스모크를 0회 실행하고 GREEN 가능",
  );
  assert.ok(
    !("continue-on-error" in baseline),
    "freshness 행동 baseline step 에 continue-on-error 가 있으면 RED 를 무시 가능",
  );
  assert.ok(
    !("shell" in baseline),
    "freshness 행동 baseline step 의 shell override 는 exit semantics 를 바꿀 수 있어 금지",
  );
}

/* ══ 2) freshness 게이트 — paths 가 검증기 입력을 전부 덮어야 한다 ══ */
{
  const { on, source } = await parseOn(FRESHNESS_WORKFLOW);
  assert.ok(on && typeof on === "object", "freshness 게이트의 `on:` 블록을 파싱할 수 있어야 한다");

  assert.ok("pull_request" in on, "freshness 게이트에 pull_request 트리거가 있어야 한다");
  const paths = on.pull_request?.paths;
  assert.ok(
    Array.isArray(paths) && paths.length > 0,
    "freshness 게이트는 스냅샷이 바뀔 때만 돌아야 하므로 paths 가 있어야 한다"
      + " (없으면 무관한 PR 이 live KBO drift 로 전부 RED 가 된다)",
  );

  /* ── 검증기가 실제로 읽는 파일을 오라클로 뽑는다 ────────────────
   *
   * ⚠︎ 여기서 목록을 손으로 적으면 그 상수가 stale 해지는 순간 같은 구멍이 다시 열린다.
   * 검증기 소스에서 경로 리터럴을 직접 추출해, paths 가 그걸 전부 덮는지 본다. */
  const verifier = readFileSync(VERIFIER, "utf8");

  const required = new Set();
  // `${CONSTANTS}/stats-${SEASON}-batters.json` 같은 템플릿을 glob 으로 정규화한다.
  for (const [, literal] of verifier.matchAll(/`\$\{CONSTANTS\}\/([^`]+)`/g)) {
    required.add(`src/lib/constants/${literal.replace(/\$\{SEASON\}/g, "*")}`);
  }
  assert.ok(
    required.size >= 5,
    `검증기에서 입력 경로를 추출하지 못했다 (actual ${required.size}) — 오라클이 깨졌다.`
      + " 검증기의 파일 읽기 방식이 바뀌었다면 이 추출도 함께 고쳐야 한다.",
  );

  /* ⚠︎ 검증기·대조 로직 같은 **코드 경로는 일부러 넣지 않는다.**
   *
   * 처음엔 "대조 로직이 바뀌면 재확인해야 한다"는 이유로 넣었는데, 그게 곧 이 PR 이
   * 없애려던 증상이었다 — 데이터 무변경 코드 PR 이 live 대조를 타고, 경기 진행으로
   * 원본이 앞서간 분량이 전부 불일치로 잡혀 무조건 RED 가 된다.
   *
   * 대조 로직 약화는 contract 게이트의 mutation RED 가 모든 PR 에서 결정론적으로 잡는다.
   * 여기서 커버해야 할 것은 **스냅샷 산출물**뿐이다. */

  const uncovered = [...required].filter(
    (file) => !paths.some((pattern) => minimatch(file, pattern)),
  );
  assert.deepEqual(
    uncovered,
    [],
    "freshness paths 가 검증기 입력 산출물을 전부 덮지 못한다 — 그 파일만 바뀐 데이터 PR 이"
      + " 게이트를 SKIP 하고 required check 가 초록으로 보인다."
      + ` 미커버: ${uncovered.join(", ")}`,
  );

  /* ── 과잉 차단 — 코드 경로는 freshness trigger 에 들어오면 안 된다 ────
   *
   * 커밋된 스냅샷은 마지막 크롤 시점의 기록이고 live KBO 는 경기가 끝날 때마다
   * 앞서간다. 그래서 데이터를 하나도 건드리지 않은 코드 PR 에서 live 대조를 돌리면
   * `games 52→53` 같은 **정상 진행분**이 전부 불일치로 잡혀 무조건 RED 다.
   * 통과할 수 없는 검사를 돌리는 셈이고, 그게 바로 이 분할이 없애려던 증상이다.
   *
   * ⚠︎ 가설이 아니다. 이 분할을 도입한 PR 자신이 `src/lib/constants/` 변경 0 인데도
   * 초기 paths 에 코드 경로를 넣었다는 이유만으로 게이트가 돌아 투수 20건 불일치로
   * RED 났다(조동욱·김민·김재윤·이승현 등, 전부 경기 진행에 따른 정상 전진).
   *
   * 대조 로직을 약화시키는 코드 변경은 contract 게이트의 mutation RED 증명이 모든
   * PR 에서 결정론적으로 잡는다. 코드 경로를 빼도 검증 커버리지 손실은 없다. */
  {
    for (const pattern of paths) {
      assert.ok(
        pattern.startsWith("src/lib/constants/"),
        "freshness trigger 는 스냅샷 산출물만 대상으로 해야 한다."
          + " 코드 경로가 들어오면 데이터 무변경 PR 이 live KBO 대조를 타고,"
          + " 경기 진행으로 원본이 앞서간 분량이 전부 불일치로 잡혀 무조건 RED 된다"
          + " (2026-08-05 이 분할 PR 자체가 투수 20건으로 재현)."
          + ` actual: ${pattern}`,
      );
    }
  }

  assertScriptsExist(source, "freshness 게이트", 1);
}

/* ══ 3) 두 게이트의 역할이 갈라져 있어야 한다 ═══════════════════
 *
 * contract 게이트가 live 대조를 다시 품으면 분할이 무의미해지고, 무관한 PR 이
 * 또다시 KBO drift 로 RED 가 된다. 반대로 freshness 가 live 대조를 놓치면
 * strict equality 계약 자체가 사라진다. 양쪽을 다 고정한다. */
{
  const contract = readFileSync(CONTRACT_WORKFLOW, "utf8");
  const freshness = readFileSync(FRESHNESS_WORKFLOW, "utf8");

  // ⚠︎ `qa:stats-freshness-contract` 는 네트워크를 타지 않는 결정론적 행동 검증이라 예외다.
  // 경계를 `(?!-)` 로 명시한다 — `\b` 만 쓰면 하이픈 뒤 접미사가 붙은 이름까지 걸려
  // 정상 결속을 금지 위반으로 오판한다.
  assert.ok(
    !/npm run qa:stats-(source-truth|freshness)(?![\w-])/.test(contract),
    "contract 게이트가 live KBO 대조를 부르면 안 된다 —"
      + " 경기 진행만으로 무관한 PR 이 RED 가 되고, mutation RED 증명도 baseline 이"
      + " 이미 RED 라 검증력을 입증하지 못한 채 통과한다(2026-08-04 실측)",
  );
  assert.ok(
    /npm run qa:stats-freshness(?![\w-])/.test(freshness),
    "freshness 게이트는 live 대조를 수행해야 한다(strict equality 계약 유지)",
  );
  assert.ok(
    pkg.scripts["qa:stats-source-truth"],
    "완화 없는 원본 대조 검증기(qa:stats-source-truth)는 그대로 남아 있어야 한다",
  );
}

console.log("stats gate trigger smoke: ALL assertions PASS (contract=no-paths, freshness=covers verifier inputs)");
