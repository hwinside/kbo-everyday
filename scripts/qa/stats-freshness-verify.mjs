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
 *      KBO 가 같은 순간에도 조회마다 다른 행 집합을 준다. 8/4 전다민(54214)은
 *      좌익수/중견수 2행 중 매 조회 하나만 내려왔다(824 ↔ 825 flapping). 그래서
 *      원격 체크는 SUCCESS 인데 같은 커밋을 직접 재조회하면 FAIL 이었다. 체크 한 번이
 *      초록이라는 사실은 정합성의 증거가 되지 못한다.
 *
 * ── 이 스크립트의 계약 ──────────────────────────────────────────
 * 판정 대상은 그대로 `stats-source-truth-verify.mjs`(고정 검증기)다. 이 스크립트는
 * 그 검증기를 **연속 실행해 판독이 재현되는지**만 본다. 검증기를 감싸되 완화하지 않는다.
 *
 *   - 연속 2회 PASS            → GREEN. 우리 스냅샷이 *안정된* 원본과 일치한다.
 *   - 연속 2회 동일 FAIL       → RED(`stats_freshness_mismatch`). 진짜 불일치다.
 *   - 판독이 흔들림           → `stats_source_unstable`. 데이터 판정이 아니라 **보류**다.
 *   - 수집 자체가 불가         → `stats_source_unreachable`. 검증 불가는 통과가 아니다.
 *
 * ⚠︎ 셋 다 exit 1 이다. "불안정"을 exit 0 으로 흘려보내면 그게 곧 false-green 이고,
 * 오늘 우리가 잡아낸 temporal green 을 게이트가 스스로 만들어내는 꼴이 된다.
 * 구분의 가치는 통과 여부가 아니라 **원인 분류**에 있다 — 불일치는 데이터를 고쳐야 하고,
 * 불안정은 원본이 멎을 때까지 기다렸다 다시 뽑아야 한다. 이 둘을 같은 메시지로 보고하면
 * "게이트가 또 빨갛네" 로 뭉개져 결국 아무도 안 본다.
 *
 * ⚠︎ 검증기를 import 하지 않고 **자식 프로세스로 실행**한다. in-process 로 부르면
 * 모듈 캐시·전역 상태가 1회차와 2회차 사이에 공유돼, "두 번 읽었다"는 계약이
 * 사실은 한 번 읽은 결과를 재사용하는 것으로 바뀔 수 있다. 매 회차 fresh process 다.
 */
import { spawn } from "node:child_process";

const VERIFIER = "scripts/qa/stats-source-truth-verify.mjs";
const SEASON = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : "2026";

/** 판독이 흔들릴 때 몇 번까지 다시 볼 것인가. 연속 2회 동일 판독이 나오면 즉시 종료한다. */
const MAX_ATTEMPTS = Number(process.env.STATS_FRESHNESS_MAX_ATTEMPTS ?? 4);
/** 회차 사이 간격 — KBO 쪽 순간 상태가 갱신될 시간을 준다. */
const COOLDOWN_MS = Number(process.env.STATS_FRESHNESS_COOLDOWN_MS ?? 20_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 검증기를 fresh process 로 1회 실행하고 판독(verdict)을 만든다. */
function runVerifierOnce(attempt) {
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
    child.on("close", (code) => resolve(toVerdict(attempt, code, out)));
  });
}

/**
 * 실행 출력에서 판독을 뽑는다.
 *
 * 실패 라인은 검증기가 `  - <label>: <detail>` 형태로 낸다. 그 집합을 정렬해
 * 회차 간 비교 키로 쓴다. 셀 수·행 수 로그처럼 매 회차 달라질 수 있는 값은 키에 넣지 않는다
 * — 그걸 넣으면 모든 회차가 "서로 다른 판독"이 되어 영원히 불안정으로 보고된다.
 */
function toVerdict(attempt, code, output) {
  const unreachable = /source_unreachable|source_incomplete|source_pagination_incomplete/.test(output);
  const failures = [...output.matchAll(/^\s+-\s+(.+?)\s*$/gm)]
    .map((match) => match[1].trim())
    // 요약 라인(`stats_source_truth_mismatch: ... N건 불일치`)은 개별 불일치가 아니라
    // 집계 결과라 회차마다 건수 표기가 달라질 수 있다. 비교 키에서 뺀다.
    .filter((line) => !line.startsWith("stats_source_truth_mismatch:"))
    .sort();

  return {
    attempt,
    ok: code === 0,
    unreachable,
    failures,
    key: code === 0 ? "PASS" : `FAIL:${failures.join("\u0001")}`,
  };
}

function describe(verdict) {
  if (verdict.ok) return "PASS";
  if (verdict.unreachable) return "UNREACHABLE";
  return `FAIL(${verdict.failures.length}건)`;
}

const verdicts = [];
let previous = null;

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

  if (previous && previous.key === verdict.key) {
    // 연속 2회 동일 판독 = 재현됨. 이제서야 데이터 판정을 내린다.
    if (verdict.ok) {
      console.log(
        `\n✅ stats freshness: 연속 2회 동일 PASS — 스냅샷이 안정된 KBO 원본과 전 행·전 필드 일치`,
      );
      process.exit(0);
    }
    console.error(`\n❌ stats_freshness_mismatch: 연속 2회 동일하게 ${verdict.failures.length}건 불일치`);
    console.error("   원본이 흔들린 게 아니라 스냅샷이 실제로 다르다 — 데이터를 다시 뽑아야 한다.");
    for (const line of verdict.failures.slice(0, 20)) console.error("   - " + line);
    if (verdict.failures.length > 20) {
      console.error(`   ... 외 ${verdict.failures.length - 20}건`);
    }
    process.exit(1);
  }

  if (previous) {
    console.log(`   ⚠︎ 직전 판독(${describe(previous)})과 다르다 — 원본이 흔들리는 중`);
  }
  previous = verdict;
  if (attempt < MAX_ATTEMPTS) await sleep(COOLDOWN_MS);
}

/* 여기까지 왔다는 건 어떤 판독도 연속으로 재현되지 않았다는 뜻이다.
 * 우리 데이터가 틀렸다고 단정할 수 없고, 맞다고도 할 수 없다. 그래서 보류다. */
console.error(`\n❌ stats_source_unstable: ${MAX_ATTEMPTS}회 조회에서 동일 판독이 연속 재현되지 않았다`);
console.error("   KBO 원본이 조회마다 다른 값을 준다 = 지금은 정합성을 확정할 수 없다(보류).");
console.error("   데이터 오염 판정이 아니다. 원본이 안정된 뒤 스냅샷을 다시 뽑아 재검증할 것.");
for (const verdict of verdicts) {
  console.error(`   - 판독 ${verdict.attempt}: ${describe(verdict)}`);
  for (const line of verdict.failures.slice(0, 5)) console.error(`       ${line}`);
}
process.exit(1);
