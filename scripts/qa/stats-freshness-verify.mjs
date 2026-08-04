/**
 * 스탯 스냅샷 **신선도(freshness)** 게이트 — live KBO strict equality + 원본 안정성 판정.
 *
 * ── 배경(2026-08-05) ────────────────────────────────────────────
 * `qa:stats-source-truth` 는 저장된 스냅샷을 live KBO 와 전 행·전 필드 대조한다.
 * 그 계약 자체는 옳고 **완화하지 않는다**(삼순 NO-GO: "KBO가 앞서면 통과" 식 완화는
 * row-set 변동·오염을 숨긴다). 문제는 그 게이트를 *언제* 돌리고, live 원본이
 * 흔들릴 때 그 결과를 *어떻게 해석*하느냐였다.
 *
 * 실측된 두 가지 실패 양상:
 *
 *   ① 무관한 PR 이 전부 RED
 *      경기가 진행되면 KBO 원본이 커밋 스냅샷보다 앞서간다. 그래서 스탯을 건드리지도
 *      않은 PR 과 main push 까지 RED 가 됐다(8/4 12:46Z 이후 거의 전부). 게이트가
 *      코드 결함이 아니라 "시간이 흘렀다"를 보고하고 있었다.
 *
 *   ② temporal green / temporal red
 *      KBO 는 같은 순간에도 조회마다 다른 행 집합을 준다. 8/4 전다민(54214)은
 *      좌익수/중견수 2행 중 매 조회 하나만 내려왔다(824 ↔ 825 flapping). 그래서
 *      원격 체크는 SUCCESS 인데 같은 커밋을 재조회하면 FAIL 이었다.
 *
 * ── 이 스크립트의 계약 ──────────────────────────────────────────
 * 판정 대상은 그대로 `stats-source-truth-verify.mjs`(고정 검증기)다. 이 스크립트는
 * 그 검증기를 **반복 실행해 판독이 재현되는지**만 본다. 검증기를 감싸되 완화하지 않는다.
 *
 *   - 동일 판독이 안정 window 이상 재현 + PASS → GREEN
 *   - 동일 판독이 안정 window 이상 재현 + FAIL → RED(`stats_freshness_mismatch`)
 *   - 판독이 흔들림                            → `stats_source_unstable` (보류)
 *   - 수집 자체가 불가                          → `stats_source_unreachable` (검증 불가)
 *
 * ⚠︎ 셋 다 exit 1 이다. "불안정"을 exit 0 으로 흘려보내면 그게 곧 false-green 이고,
 * 우리가 잡아낸 temporal green 을 게이트가 스스로 만들어내는 꼴이 된다.
 * 구분의 가치는 통과 여부가 아니라 **원인 분류**에 있다.
 *
 * ── 2026-08-05 삼순 NO-GO 반영: 2회/20s 로는 부족하다 ────────────
 * #1103 의 전다민(54214) flip 은 **분 단위**로 관측됐다. 20초 간격 2회는 그 주기 안에
 * 통째로 들어가 "안정"으로 오인될 수 있다 — 즉 종전 계약은 temporal green 을 줄였을 뿐
 * 없애지 못했다. 그래서 판정 기준을 횟수가 아니라 **시간 폭(window)** 으로 바꾼다.
 *
 *   동일 판독이 연속 2회 이상 재현되고, 그 연속 구간이 **STABILITY_WINDOW 이상**을
 *   덮을 때만 데이터 판정을 내린다.
 *
 * 그리고 window·cooldown 에는 **코드 상수 하한(floor)** 을 둔다. 환경변수로 늘릴 수는
 * 있어도 줄일 수는 없다. 하한이 없으면 CI 에서 `COOLDOWN=0` 한 줄로 이 계약 전체가
 * 무력화되고, 그건 게이트를 지운 것과 같다.
 *
 * ⚠︎ 검증기를 import 하지 않고 **자식 프로세스로 실행**한다. in-process 로 부르면
 * 모듈 캐시·전역 상태가 회차 간 공유돼, "여러 번 읽었다"는 계약이 사실은 한 번 읽은
 * 결과를 재사용하는 것으로 바뀔 수 있다. 매 회차 fresh process 다.
 */
import { spawn } from "node:child_process";

const VERIFIER = "scripts/qa/stats-source-truth-verify.mjs";
const SEASON = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : "2026";

/* ── 하한(floor) 상수 ──────────────────────────────────────────
 * 환경변수는 이 값을 **늘릴 수만** 있다. 줄이려는 값은 무시된다.
 * 유일한 예외가 아래 계약 테스트 seam 이고, 그 seam 이 워크플로에 새어 들어오지 않는지는
 * `qa:stats-gate-trigger` 가 별도로 고정한다(env 자체를 금지). */
const MIN_STABILITY_WINDOW_MS = 180_000; // 3분 — 전다민 flip 의 관측 주기를 넘긴다
const MIN_COOLDOWN_MS = 15_000;

/* 계약 테스트 seam. 실 운영에서 켜지면 안 되며, 켜지면 stdout 에 크게 남는다.
 * 이 seam 없이는 결정론적 행동 검증(수 초)이 불가능하고, 행동 검증이 없으면
 * 이 파일 전체를 `process.exit(0)` 으로 바꿔도 아무도 못 잡는다.
 *
 * ⚠︎ 2026-08-05 삼순 2차 NO-GO: seam 자체가 새 우회로였다. config 출력 직후
 * `if (!CONTRACT_TEST) process.exit(0)` 한 줄을 넣으면, 시나리오 테스트는 전부 seam=1 이라
 * 정상 통과하고 prod-mode 테스트는 config 라인만 봤으므로 그것도 통과 —
 * 운영에서는 검증기를 **0회** 실행하는데 게이트는 전부 GREEN 이 된다.
 * 그래서 계약 스모크가 prod 모드에서 "검증기가 실제로 spawn 됐는가"를 직접 관측한다. */
const CONTRACT_TEST = process.env.STATS_FRESHNESS_CONTRACT_TEST === "1";

const clamp = (raw, fallback, floor) => {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < 0) return Math.max(fallback, floor);
  return CONTRACT_TEST ? value : Math.max(value, floor);
};

const STABILITY_WINDOW_MS = clamp(
  process.env.STATS_FRESHNESS_STABILITY_WINDOW_MS,
  MIN_STABILITY_WINDOW_MS,
  MIN_STABILITY_WINDOW_MS,
);
const COOLDOWN_MS = clamp(
  process.env.STATS_FRESHNESS_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
);

/* ⚠︎ attempts 하한은 상수가 아니라 window·cooldown 에서 **파생**된다(삼순 P1).
 *
 * 판정은 연속 동일 판독이 STABILITY_WINDOW 를 덮어야 내려진다. 검증기가 빠르면
 * 경과 시간은 사실상 `(attempts-1) × cooldown` 이므로, 그 값이 window 에 못 미치면
 * **안정된 데이터조차 영원히 PASS 할 수 없다**. 종전 고정값 6 은 180s/15s 조합에서
 * 최대 약 75s 밖에 못 덮어 통과 자체가 불가능했다.
 *
 *   필요 회차 = ceil(window / cooldown) + 1
 *
 * 파생으로 두면 window·cooldown 을 바꿔도 이 관계가 저절로 유지된다.
 * (검증기가 느리면 훨씬 적은 회차에서 window 를 덮고 조기 종료한다.) */
const requiredAttempts = Math.ceil(STABILITY_WINDOW_MS / Math.max(COOLDOWN_MS, 1)) + 1;
const MIN_ATTEMPTS = CONTRACT_TEST ? 1 : requiredAttempts;
const MAX_ATTEMPTS = clamp(
  process.env.STATS_FRESHNESS_MAX_ATTEMPTS,
  MIN_ATTEMPTS,
  MIN_ATTEMPTS,
);

if (CONTRACT_TEST) {
  console.log("⚠︎ STATS_FRESHNESS_CONTRACT_TEST=1 — 하한 clamp 해제(계약 테스트 전용)");
}
console.log(
  `stats freshness config: stability window ${STABILITY_WINDOW_MS}ms · `
    + `cooldown ${COOLDOWN_MS}ms · max attempts ${MAX_ATTEMPTS}`
    + ` (window 를 덮는 데 필요한 최소 회차 ${requiredAttempts})`,
);

if (!CONTRACT_TEST && MAX_ATTEMPTS < requiredAttempts) {
  // 도달 불가능한 설정으로는 시작하지 않는다 — 통과할 수 없는 검사를 돌리는 셈이다.
  console.error(
    `\n❌ stats_freshness_misconfigured: attempts ${MAX_ATTEMPTS} 로는`
      + ` 안정 window ${STABILITY_WINDOW_MS}ms 를 덮을 수 없다(필요 ${requiredAttempts})`,
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 검증기를 fresh process 로 1회 실행하고 판독(verdict)을 만든다. */
function runVerifierOnce(attempt) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFIER, "--season", SEASON], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code) => resolve(toVerdict(attempt, code, out, startedAt)));
  });
}

/**
 * 실행 출력에서 판독을 뽑는다.
 *
 * 실패 라인은 검증기가 `  - <label>: <detail>` 형태로 낸다. 그 집합을 정렬해
 * 회차 간 비교 키로 쓴다. 셀 수·행 수 로그처럼 매 회차 달라질 수 있는 값은 키에 넣지 않는다
 * — 그걸 넣으면 모든 회차가 "서로 다른 판독"이 되어 영원히 불안정으로 보고된다.
 */
function toVerdict(attempt, code, output, startedAt) {
  const unreachable = /source_unreachable|source_incomplete|source_pagination_incomplete/.test(output);
  const failures = [...output.matchAll(/^\s+-\s+(.+?)\s*$/gm)]
    .map((match) => match[1].trim())
    .filter((line) => !line.startsWith("stats_source_truth_mismatch:"))
    .sort();
  const digest = output.match(/KBO_SOURCE_DIGEST=([a-f0-9]{64})/)?.[1] ?? null;
  // 원본에 도달했는데 digest가 없으면 wrapper/verifier 결속이 끊긴 것이다.
  const digestMissing = !unreachable && !digest;

  return {
    attempt,
    startedAt,
    endedAt: Date.now(),
    ok: code === 0 && !digestMissing,
    unreachable: unreachable || digestMissing,
    failures,
    digest,
    // 원본 안정성은 digest로, 판정 안정성은 outcome으로 함께 고정한다.
    key: digest
      ? `SOURCE:${digest}|OUTCOME:${code === 0 ? "PASS" : `FAIL:${failures.join("\u0001")}`}`
      : "SOURCE:MISSING",
  };
}

function describe(verdict) {
  if (verdict.ok) return "PASS";
  if (verdict.unreachable) return "UNREACHABLE";
  return `FAIL(${verdict.failures.length}건)`;
}

const verdicts = [];
/** 동일 판독이 연속으로 이어진 구간(run). 이 구간이 window 를 덮어야 판정한다. */
let run = null;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`\n── freshness 판독 ${attempt}/${MAX_ATTEMPTS} ─────────────────────────`);
  const verdict = await runVerifierOnce(attempt);
  verdicts.push(verdict);
  console.log(`   판독 ${attempt}: ${describe(verdict)}`);

  // 원본에 도달조차 못하면 재시도로 덮을 문제가 아니다 — 즉시 fail-close.
  if (verdict.unreachable) {
    console.error(
      "\n❌ stats_source_unreachable: KBO 원본 수집에 실패했다 — 검증 불가(통과로 취급하지 않는다)",
    );
    process.exit(1);
  }

  if (run && run.key === verdict.key) {
    run.count += 1;
    run.lastVerdict = verdict;
  } else {
    if (run) {
      console.log(`   ⚠︎ 직전 판독(${describe(run.lastVerdict)})과 다르다 — 원본이 흔들리는 중`);
    }
    run = { key: verdict.key, count: 1, startedAt: verdict.startedAt, lastVerdict: verdict };
  }

  const span = verdict.endedAt - run.startedAt;
  console.log(
    `   연속 동일 판독 ${run.count}회 · 안정 구간 ${Math.round(span / 1000)}s`
      + ` / 요구 ${Math.round(STABILITY_WINDOW_MS / 1000)}s`,
  );

  /* 판정은 **두 조건이 모두** 충족될 때만 내린다.
   *   ① 동일 판독이 연속 2회 이상 재현
   *   ② 그 연속 구간이 안정 window 이상을 덮음
   * ②가 없으면 flip 주기(분 단위) 안쪽에서 두 번 읽고 "안정"이라 부르게 된다. */
  if (run.count >= 2 && span >= STABILITY_WINDOW_MS) {
    if (verdict.ok) {
      console.log(
        `\n✅ stats freshness: ${run.count}회 연속 동일 PASS 가 ${Math.round(span / 1000)}s 구간을 덮었다`
          + " — 스냅샷이 안정된 KBO 원본과 전 행·전 필드 일치",
      );
      process.exit(0);
    }
    console.error(
      `\n❌ stats_freshness_mismatch: ${Math.round(span / 1000)}s 구간에서 동일하게 ${verdict.failures.length}건 불일치`,
    );
    console.error("   원본이 흔들린 게 아니라 스냅샷이 실제로 다르다 — 데이터를 다시 뽑아야 한다.");
    for (const line of verdict.failures.slice(0, 20)) console.error("   - " + line);
    if (verdict.failures.length > 20) {
      console.error(`   ... 외 ${verdict.failures.length - 20}건`);
    }
    process.exit(1);
  }

  if (attempt < MAX_ATTEMPTS) await sleep(COOLDOWN_MS);
}

/* 여기까지 왔다는 건 어떤 판독도 안정 window 를 덮으며 재현되지 않았다는 뜻이다.
 * 우리 데이터가 틀렸다고 단정할 수 없고, 맞다고도 할 수 없다. 그래서 보류다. */
console.error(
  `\n❌ stats_source_unstable: ${MAX_ATTEMPTS}회 조회에서 동일 판독이 `
    + `${Math.round(STABILITY_WINDOW_MS / 1000)}s 안정 구간을 덮으며 재현되지 않았다`,
);
console.error("   KBO 원본이 조회마다 다른 값을 준다 = 지금은 정합성을 확정할 수 없다(보류).");
console.error("   데이터 오염 판정이 아니다. 원본이 안정된 뒤 스냅샷을 다시 뽑아 재검증할 것.");
for (const verdict of verdicts) {
  console.error(`   - 판독 ${verdict.attempt}: ${describe(verdict)}`);
  for (const line of verdict.failures.slice(0, 5)) console.error(`       ${line}`);
}
process.exit(1);
