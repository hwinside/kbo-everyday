/**
 * roster 크롤 완주 계약 (삼순 #1098 — `②-b roster/사진/inventory 자동머지 보류` 의 해제 근거).
 *
 * 배경: `crawl-roster-v2.mjs` 는 팀별 필터를 바꿔가며 기록 페이지를 긁는데,
 * 셀렉트 변경이 timeout 되면 `waitForTimeout` 으로 흘러가 *직전 팀 화면* 또는 *빈 표*
 * 를 그대로 스크레이프했다. 그 결과가 조용히 정상 완주로 저장돼 roster 가 오염되거나
 * 특정 팀이 통째로 사라져도 exit 0 이 됐다. 그래서 `roster 변경 = 사람이 봐야 함` 가드가
 * 필요했고, roster 는 콜업·말소로 거의 매일 바뀌므로 자동머지가 구조적으로 멈췄다.
 *
 * 이 모듈은 "수집이 완주했는가" 를 값이 아니라 *불변식*으로 판정한다.
 * 순수 함수만 두어 실제 크롤 없이 결함주입 테스트가 가능하다.
 */

/** 팀별 최소 인원 — 1군+육성 합산 기록 페이지 기준. 이보다 적으면 수집 사고로 본다. */
export const TEAM_MIN_PLAYERS = 15;

/** 팀별 baseline 대비 허용 감소 비율. 트레이드·대량 말소를 넘어서는 급락을 차단한다. */
export const TEAM_MAX_DROP_RATIO = 0.3;

/** 팀 수집 1회 시도의 판정 사유. */
export const TEAM_FAIL_REASONS = {
  SELECT_UNCONFIRMED: "select_unconfirmed",
  EMPTY: "empty",
  BELOW_FLOOR: "below_floor",
  DROP: "drop",
};

/**
 * 기존 roster 에서 팀별 인원 baseline 을 만든다.
 * baseline 이 없는 팀(첫 실행)은 undefined 로 남겨 drop 판정에서 제외한다.
 */
export function buildTeamBaseline(existingRoster) {
  const baseline = new Map();
  for (const p of existingRoster || []) {
    if (p?.teamId == null) continue;
    baseline.set(p.teamId, (baseline.get(p.teamId) || 0) + 1);
  }
  return baseline;
}

/**
 * 팀 1개 수집 결과를 판정한다.
 * @param {object} input
 * @param {boolean} input.selectConfirmed 팀 셀렉트가 요청값으로 실제 반영됐는지
 * @param {number} input.collected 이번 수집에서 이 팀으로 잡힌 선수 수
 * @param {number|undefined} input.baseline 기존 roster 의 이 팀 인원 (없으면 undefined)
 * @returns {{ ok: boolean, reason: string|null, detail: string }}
 */
export function evaluateTeamCollection({
  selectConfirmed,
  collected,
  baseline,
  minPlayers = TEAM_MIN_PLAYERS,
  maxDropRatio = TEAM_MAX_DROP_RATIO,
}) {
  if (!selectConfirmed) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.SELECT_UNCONFIRMED,
      detail: "팀 셀렉트가 요청값으로 반영되지 않음 — 직전 팀 화면을 긁었을 수 있음",
    };
  }
  if (!Number.isFinite(collected) || collected <= 0) {
    return { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" };
  }
  if (collected < minPlayers) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.BELOW_FLOOR,
      detail: `수집 ${collected}명 < 최소 ${minPlayers}명`,
    };
  }
  if (Number.isFinite(baseline) && baseline > 0) {
    const allowed = Math.floor(baseline * (1 - maxDropRatio));
    if (collected < allowed) {
      return {
        ok: false,
        reason: TEAM_FAIL_REASONS.DROP,
        detail: `수집 ${collected}명 < 허용 하한 ${allowed}명 (baseline ${baseline}, 허용 감소 ${Math.round(maxDropRatio * 100)}%)`,
      };
    }
  }
  return { ok: true, reason: null, detail: `수집 ${collected}명` };
}

/**
 * 전 팀 판정을 모아 완주 여부를 결정한다.
 * 한 팀이라도 실패하면 완주가 아니다 (fail-close).
 * @param {Array<{ teamName: string, phase: string, result: {ok:boolean, reason:string|null, detail:string}, attempts:number }>} teamOutcomes
 * @param {number} expectedTeamSlots 기대 슬롯 수 (팀 수 × phase 수)
 */
export function evaluateRosterCompletion(teamOutcomes, expectedTeamSlots) {
  const failures = teamOutcomes.filter((o) => !o.result.ok);
  const missing = expectedTeamSlots - teamOutcomes.length;
  const complete = failures.length === 0 && missing === 0;
  return {
    complete,
    failures,
    missingSlots: missing > 0 ? missing : 0,
    summary: complete
      ? `완주 ${teamOutcomes.length}/${expectedTeamSlots} 슬롯`
      : `미완주 — 실패 ${failures.length}건, 미실행 ${Math.max(missing, 0)}슬롯`,
  };
}

/** 완주 실패를 사람이 읽을 수 있는 리포트로 만든다. */
export function formatCompletionFailure(evaluation) {
  const lines = ["❌ roster_crawl_incomplete — 수집이 완주하지 않아 저장하지 않는다", ""];
  lines.push(evaluation.summary);
  for (const f of evaluation.failures) {
    lines.push(`  - ${f.phase}/${f.teamName}: ${f.result.reason} (${f.result.detail}, 시도 ${f.attempts}회)`);
  }
  if (evaluation.missingSlots > 0) {
    lines.push(`  - 미실행 슬롯 ${evaluation.missingSlots}개 — 루프가 중간에 끊겼다`);
  }
  return lines.join("\n");
}
