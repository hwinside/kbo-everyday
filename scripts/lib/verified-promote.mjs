/**
 * "검증되지 않은 산출물은 promote 될 수 없다" 를 **구조로** 강제한다.
 *
 * ── 배경(2026-08-04, 삼순 연속 지적 + merged main 재현) ──
 * 지금까지의 게이트는 전부 "크롤러 소스 문자열"을 봤다. 그래서 caller 한 줄만 바꾸면
 * 전 게이트가 GREEN 인 우회가 계속 나왔다. merged main 에서도 재현했다.
 *
 *   - `false && await assertSourceTruth({...})`            → 전 게이트 GREEN
 *   - `defenseRuns: readPrevious(defenseRunsPath, {})`     → GREEN (옛 스냅샷을 검증)
 *   - `verify: async () => {}, bindingProof: { verify: ... }` → GREEN (검증 0회 후 promote)
 *
 * 마지막 것이 핵심이다. **verifier 자체가 caller 주입값**이면, 아무리 문자열로
 * "assertSourceTruth 가 결속됐는지" 확인해도 위장 필드 하나로 뚫린다.
 *
 * ── 계약 ──
 * 그래서 stats 산출물 전용 wrapper 를 두고, **verifier 를 내부에 고정**한다.
 * caller 는 검증기를 고를 수 없다. 넘길 수 있는 건 네트워크 핸들·시즌 같은 부가 입력뿐이다.
 *
 *  1) promote 대상 산출물은 이 모듈을 통해서만 나간다.
 *  2) 검증 입력은 caller 가 주는 게 아니라 **promote payload 에서 파생**된다.
 *     → 옛 스냅샷·빈 값을 끼워넣는 우회가 구조적으로 불가능하다.
 *  3) verifier 는 모듈 내부 고정이다. caller 주입 불가.
 *  4) context 가 payload 키를 덮으려 하면 조용히 무시하지 않고 던진다.
 */
import { promoteAtomically } from "./atomic-promote.mjs";
import { assertSourceTruth } from "./stats-source-truth.mjs";

/** promote payload 에서 검증 대상을 뽑아낸다. caller 입력을 신뢰하지 않는다. */
function parsePayload(artifacts) {
  const byName = new Map();
  for (const artifact of artifacts) {
    const name = artifact.path.split("/").pop();
    byName.set(name, artifact.body);
  }
  const readJson = (suffix) => {
    for (const [name, body] of byName) {
      if (name.endsWith(suffix)) return JSON.parse(body);
    }
    return null;
  };
  return {
    batters: readJson("-batters.json"),
    pitchers: readJson("-pitchers.json"),
    defense: readJson("-defense.json"),
    defenseRuns: readJson("player-defense-runs.json"),
  };
}

/**
 * 내부 공통 경로. `verify` 는 **인자로 받지 않는다** — 호출자가 고를 수 없어야 한다.
 * 테스트에서만 `__verifyForTest` 로 대체하며, 그 경로는 stats wrapper 가 쓰지 않는다.
 */
async function runVerifiedPromote(artifacts, context, verify) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("verified_promote_no_artifacts: promote 대상이 없다");
  }

  const payload = parsePayload(artifacts);
  const missing = Object.entries(payload)
    .filter(([, value]) => value === null || (Array.isArray(value) && value.length === 0))
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(
      `verified_promote_payload_incomplete: ${missing.join(", ")} — `
      + "promote payload 에서 검증 대상을 찾지 못했다(검증 없이 write 하지 않는다)",
    );
  }

  // caller 가 payload 키를 context 로 덮으려는 것 자체를 거부한다.
  // 조용히 무시하면 caller 는 자기 의도가 먹힌 줄 알고, 리뷰어도 그 줄만 보면 검증되는 것처럼 보인다.
  const shadowed = Object.keys(payload).filter((key) => key in (context ?? {}));
  if (shadowed.length) {
    throw new Error(
      `verified_promote_context_shadow: ${shadowed.join(", ")} 는 promote payload 에서 파생된다 — `
      + "context 로 덮어쓰면 검증 대상과 실제 쓰는 값이 달라진다",
    );
  }

  await verify({ ...context, ...payload });
  promoteAtomically(artifacts);
}

/**
 * **스탯 산출물 전용 promote.** verifier 는 `assertSourceTruth` 로 고정돼 있다.
 *
 * ⚠︎ verifier 를 파라미터로 열어두면 `verify: async () => {}` 한 줄로 검증 0회가 되고,
 * 문자열 게이트는 위장 필드(`bindingProof`)만 있으면 GREEN 이다(삼순 실증).
 * 그래서 여기서는 **고를 수 없게** 만든다.
 *
 * @param {object} options
 * @param {Array<{path: string, body: string}>} options.artifacts promote 대상
 * @param {object} options.context 검증에 필요한 부가 입력(browser·season·roster 등)
 */
export async function promoteStatsSnapshot({ artifacts, context }) {
  return runVerifiedPromote(artifacts, context, (input) => assertSourceTruth(input));
}

/**
 * 테스트 전용 — 검증 실패/누락 시 promote 되지 않는지 확인하기 위한 주입 경로.
 * 제품 코드(크롤러)는 절대 이걸 쓰지 않는다. 게이트가 그 사실을 검사한다.
 */
export async function __verifiedPromoteForTest({ artifacts, context, verify }) {
  if (typeof verify !== "function") {
    throw new Error("verified_promote_missing_verifier: 검증기 없이 promote 할 수 없다");
  }
  return runVerifiedPromote(artifacts, context, verify);
}
