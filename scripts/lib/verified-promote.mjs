/**
 * "검증되지 않은 산출물은 promote 될 수 없다" 를 **구조로** 강제한다.
 *
 * ── 배경(2026-08-04, 삼순 최종 지적 + merged main 재현) ──
 * 지금까지의 게이트는 전부 "크롤러 소스 문자열"을 봤다. 그래서 caller 한 줄만 바꾸면
 * 전 게이트가 GREEN 인 우회가 계속 나왔다. merged main 에서도 재현했다.
 *
 *   - `false && await assertSourceTruth({...})`  → focused gates 전부 GREEN
 *   - `defenseRuns: readPrevious(defenseRunsPath, {})` (옛 스냅샷 검증) → GREEN
 *
 * 문자열 검사를 아무리 촘촘히 해도 같은 의미를 다르게 쓰는 방법은 무한하다.
 * 그래서 검사 대상을 바꾼다 — **promote 되는 payload 그 자체**를 검증한다.
 *
 * 계약:
 *  1) promote 대상 산출물은 이 함수를 통해서만 나간다.
 *  2) 검증 입력은 caller 가 따로 주는 게 아니라 **promote payload 에서 파생**된다.
 *     → 옛 스냅샷을 검증하거나 빈 값을 넘기는 우회가 구조적으로 불가능하다.
 *  3) 검증이 실행되지 않았으면 promote 하지 않는다(호출 누락도 실패).
 */
import { promoteAtomically } from "./atomic-promote.mjs";

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
 * 산출물을 검증한 뒤에만 promote 한다.
 *
 * @param {object} options
 * @param {Array<{path: string, body: string}>} options.artifacts promote 대상
 * @param {(input: object) => Promise<void>} options.verify 검증기(assertSourceTruth 등)
 * @param {object} options.context 네트워크·시즌 등 검증기에 필요한 부가 입력
 */
export async function verifyThenPromote({ artifacts, verify, context }) {
  if (typeof verify !== "function") {
    throw new Error("verified_promote_missing_verifier: 검증기 없이 promote 할 수 없다");
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

  // ⚠︎ caller 가 payload 키를 context 로 넘기려는 것 자체를 거부한다.
  // 단순히 `{...context, ...payload}` 순서로 덮어쓰면 "조용히 무시"라
  // caller 는 자기 의도가 먹힌 줄 알고, 리뷰어도 그 줄만 보면 검증되는 것처럼 보인다.
  // 명시적으로 던져서 우회 시도를 드러낸다.
  const shadowed = Object.keys(payload).filter((key) => key in (context ?? {}));
  if (shadowed.length) {
    throw new Error(
      `verified_promote_context_shadow: ${shadowed.join(", ")} 는 promote payload 에서 파생된다 — `
      + "context 로 덮어쓰면 검증 대상과 실제 쓰는 값이 달라진다",
    );
  }

  // 검증 입력은 payload 에서만 나온다.
  await verify({ ...context, ...payload });
  promoteAtomically(artifacts);
}
