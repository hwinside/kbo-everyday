/**
 * `②-b roster/사진/inventory 자동머지 보류` 가드를 **근거에 결속**한다 — 순수 로직.
 *
 * ── 왜 가드를 지우지 않는가 ──────────────────────────────────────
 * 그 가드의 근거는 워크플로 주석에 그대로 적혀 있다:
 *
 *   "roster 크롤러는 아직 완주 계약(bounded retry / quiet EOF 차단)이 없습니다.
 *    roster 경로가 후속 PR 로 닫힐 때까지, 해당 산출물이 바뀌면 사람이 본다."
 *
 * 그 후속 PR 이 #1120(squash `2c391f336`)이고, 2026-08-08 run 31252926120 에서
 * `✅ 수집 완주 계약 통과 — 완주 20/20 슬롯` 이 실제로 찍혔다. 조건은 충족됐다.
 *
 * 그런데 가드를 **삭제**하면 다음에 완주 계약이 무력화될 때(리팩터·예외 경로·env 누락)
 * 자동머지가 조용히 다시 열린다. 근거가 사라졌는데 결론만 남는 상태다.
 * 그래서 삭제가 아니라 조건을 바꾼다 — **완주 계약이 이번 런에서 통과했다는 증거가
 * 있을 때만** roster 범위 변경을 자동머지한다. 증거가 없으면 종전 동작(보류)이다.
 *
 * ── fail-close 축 ─────────────────────────────────────────────
 * 증거 없음 / 파싱 불가 / 미완주 / 다른 런의 증거 / 슬롯 수 불일치 → 전부 **보류**.
 * "판단 불가"를 통과로 취급하지 않는다. 이 가드가 열리는 유일한 길은
 * *이번 런의* 크롤러가 *전 슬롯 완주*를 기록한 경우다.
 *
 * ⚠️ 이 계약이 증명하는 것과 못 하는 것을 분명히 한다.
 *   증명: 이번 런의 roster 크롤이 기대한 전 슬롯을 빠짐없이 수집했다.
 *   미증명: roster **값**이 흔들리는지(flapping). 완주 계약은 "전부 수집했나"만 본다.
 *           그 방어는 여전히 `Δ≤10` 급변 가드 + validate-roster / validate-identity 뿐이다.
 *   미증명: 크롤 이후 단계(reconcile 온보딩·사진 갱신)가 만든 변경. 그건 각자의
 *           게이트(foreign-onboard-photo-gate 등)가 보고, 여기서 대신 보증하지 않는다.
 */

import { buildExpectedSlotKeys } from "./roster-crawl-completion.mjs";

/** 크롤러가 증거를 쓸 경로를 담는 환경변수. 미설정이면 크롤러는 증거를 쓰지 않는다. */
export const EVIDENCE_PATH_ENV = "ROSTER_COMPLETION_EVIDENCE";

/**
 * 증거 스키마 식별자. 필드 의미가 바뀌면 여기를 올린다.
 *
 * ⚠︎ 생산자·소비자가 다른 버전을 보면 같은 필드 이름을 다른 뜻으로 읽는다.
 * 그건 "조용히 통과하는" 부류이므로 모르면 보류한다(삼순 지적 ③).
 */
export const EVIDENCE_SCHEMA = "roster-completion-evidence/1";

/** 보류 사유 — 로그·요약에 그대로 찍혀 원인이 구분된다. */
export const TRUST_DENY_REASONS = {
  EVIDENCE_MISSING: "evidence_missing",
  EVIDENCE_UNPARSABLE: "evidence_unparsable",
  EVIDENCE_STALE: "evidence_stale",
  CRAWL_INCOMPLETE: "crawl_incomplete",
  SLOT_MISMATCH: "slot_mismatch",
  SCHEMA_MISMATCH: "schema_mismatch",
  SLOT_CONTRACT_UNRESOLVED: "slot_contract_unresolved",
};

/**
 * production 정본(`src/lib/constants/teams.ts`)에서 팀 id 집합을 **독립으로** 뽑는다.
 *
 * ⚠︎ 이게 없으면 증거가 자기 기대치를 실고 오는 구조라 순환이 된다.
 * 크롤러 `TEAMS` 가 1팀으로 줄어들어도 `expectedSlots=2, observedSlots=2` 로
 * "전 슬롯 완주"가 되어 9팀이 통째로 사라진 PR 이 자동머지된다(삼순 지적 ②).
 * 그래서 소비자는 기대치를 **생산자와 무관하게** 정본에서 재구성해 대조한다.
 */
export function parseProductionTeamIds(teamsSource) {
  if (typeof teamsSource !== "string") return null;
  const ids = [...teamsSource.matchAll(/^\s*id:\s*(\d+),/gm)].map((m) => Number(m[1]));
  const unique = [...new Set(ids)];
  // 파싱이 깨졌거나 중복이 섞였으면 판정 불가 — 통과시키지 않는다.
  if (unique.length !== ids.length || unique.length < 2) return null;
  return unique;
}

/**
 * 기대 슬롯 수를 정본에서 계산한다(팀 × phase).
 *
 * phase 개수를 여기서 하드코딩하지 않는다 — 슬롯 key 생성기와 어긋나면
 * 상수 둘이 엇갈리는 수자 싸움이 된다. 슬롯 key 를 실제로 만들어 센다.
 */
export function resolveExpectedSlotCount(teamsSource) {
  const ids = parseProductionTeamIds(teamsSource);
  if (!ids) return null;
  return buildExpectedSlotKeys(ids).length;
}

/**
 * 크롤러가 남길 증거 payload.
 *
 * `runId`/`runAttempt` 를 박는 이유: 파일만 보고 신뢰하면 **직전 런이 남긴 증거**로
 * 이번 런의 부분 수집이 통과할 수 있다. 러너 temp 는 런마다 새로 뜨지만 그건
 * 실행 환경의 성질이지 우리 계약이 아니다 — 계약으로 박아 둔다.
 */
export function buildCompletionEvidence({ completion, expectedSlots, env = process.env }) {
  /* ⚠︎ 미완주에는 증거 자신을 만들지 않는다 — 호출 순서에 의지하지 않기 위해서다.
   *
   * 코드를 "완주 판정 다음에 부른다"로만 지키면, 다음 리펙터가 이 호출을 위로 올리는
   * 삷간 부분 수집이 증거를 남긴다. 그 상태는 소스 순서 검사로도 잡힌다고 봤지만,
   * 상수 이름·변수만 바곴도 그 검사는 무력해진다(실제로 이 게이트의 초안이 그렇게 허새다).
   * 그래서 생산 지점에서 만들 수 없게 한다 — 지킬 수 없는 순서 대신 구조로 막는다. */
  if (completion?.complete !== true) {
    throw new Error(
      `roster_completion_evidence_refused: 미완주 상태로는 증거를 만들지 않는다`
        + ` — ${completion?.summary ?? "(요약 없음)"}`,
    );
  }
  return {
    schema: "roster-completion-evidence/1",
    complete: completion?.complete === true,
    summary: String(completion?.summary ?? ""),
    expectedSlots,
    observedSlots: expectedSlots - (completion?.missingKeys?.length ?? 0),
    failures: completion?.failures?.length ?? 0,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * 증거를 읽고 "roster 범위 변경을 자동머지해도 되는가"를 판정한다.
 *
 * @param {{ evidenceRaw?: string|null, env?: Record<string,string|undefined> }} input
 * @returns {{ trusted: boolean, reason: string|null, detail: string }}
 */
export function decideRosterScopeTrust({ evidenceRaw, env = process.env, expectedSlotCount }) {
  const deny = (reason, detail) => ({ trusted: false, reason, detail });

  // ⚠︎ 정본 기대치를 모르는 상황은 통과시키지 않는다. "모를 때는 증거를 믿는다"로 두면
  // teams.ts 경로가 바뀐 순간 생산자 순환 구조로 조용히 되돌아간다.
  if (!Number.isInteger(expectedSlotCount) || expectedSlotCount < 2) {
    return deny(
      TRUST_DENY_REASONS.SLOT_CONTRACT_UNRESOLVED,
      `production 정본에서 기대 슬롯 수를 해석하지 못했다 — expectedSlotCount=${expectedSlotCount}`,
    );
  }

  if (typeof evidenceRaw !== "string" || evidenceRaw.trim() === "") {
    return deny(
      TRUST_DENY_REASONS.EVIDENCE_MISSING,
      "완주 계약 증거가 없다 — 크롤러가 증거를 쓰지 않았거나 경로 배선이 끊어졌다",
    );
  }

  let evidence;
  try {
    evidence = JSON.parse(evidenceRaw);
  } catch (error) {
    return deny(
      TRUST_DENY_REASONS.EVIDENCE_UNPARSABLE,
      `증거를 파싱할 수 없다 — ${error?.message ?? error}`,
    );
  }
  if (!evidence || typeof evidence !== "object") {
    return deny(TRUST_DENY_REASONS.EVIDENCE_UNPARSABLE, "증거가 객체가 아니다");
  }

  if (evidence.schema !== EVIDENCE_SCHEMA) {
    return deny(
      TRUST_DENY_REASONS.SCHEMA_MISMATCH,
      `증거 스키마가 다르다 — expected ${EVIDENCE_SCHEMA}, actual ${evidence.schema}`,
    );
  }

  // ⚠︎ 런 결속을 먼저 본다. 다른 런의 증거는 내용이 아무리 좋아도 이번 런의 근거가 아니다.
  const runId = env.GITHUB_RUN_ID ?? null;
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? null;
  if (!runId || !runAttempt) {
    return deny(
      TRUST_DENY_REASONS.EVIDENCE_STALE,
      "현재 런 식별자를 알 수 없다 — 증거가 이번 런 것인지 확인 불가",
    );
  }
  if (String(evidence.runId) !== String(runId) || String(evidence.runAttempt) !== String(runAttempt)) {
    return deny(
      TRUST_DENY_REASONS.EVIDENCE_STALE,
      `다른 런의 증거다 — evidence(run=${evidence.runId}, attempt=${evidence.runAttempt})`
        + ` vs 현재(run=${runId}, attempt=${runAttempt})`,
    );
  }

  if (evidence.complete !== true) {
    return deny(
      TRUST_DENY_REASONS.CRAWL_INCOMPLETE,
      `크롤이 완주하지 않았다 — ${evidence.summary || "(요약 없음)"}`,
    );
  }

  // 완주 플래그만 믿지 않는다. 슬롯 수 자체가 근거여야 한다 —
  // `expectedSlots: 0` 이면 "0개 중 0개 완주"로 언제나 참이 되어 계약이 비어버린다.
  const expected = Number(evidence.expectedSlots);
  const observed = Number(evidence.observedSlots);
  if (!Number.isInteger(expected) || expected < 1) {
    return deny(
      TRUST_DENY_REASONS.SLOT_MISMATCH,
      `기대 슬롯 수가 유효하지 않다 — expectedSlots=${evidence.expectedSlots}`,
    );
  }
  // ★ 생산자가 신고한 기대치가 **정본과 같아야** 한다.
  // 이 한 줄이 "슬롯을 줄여서 전부 완주했다고 말하는" 우회를 막는다.
  if (expected !== expectedSlotCount) {
    return deny(
      TRUST_DENY_REASONS.SLOT_MISMATCH,
      `기대 슬롯 수가 production 정본과 다르다 — 증거 ${expected}, 정본 ${expectedSlotCount}`
        + " (크롤 대상 팀이 줄었거나 phase 가 빠졌다)",
    );
  }
  if (observed !== expected) {
    return deny(
      TRUST_DENY_REASONS.SLOT_MISMATCH,
      `수집 슬롯이 기대와 다르다 — ${observed}/${expected}`,
    );
  }
  if (Number(evidence.failures) !== 0) {
    return deny(
      TRUST_DENY_REASONS.CRAWL_INCOMPLETE,
      `팀 단위 실패가 남아 있다 — ${evidence.failures}건`,
    );
  }

  return {
    trusted: true,
    reason: null,
    detail: `이번 런의 roster 크롤이 완주했다 — ${observed}/${expected} 슬롯`,
  };
}
