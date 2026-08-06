/**
 * roster 크롤 완주 계약 (삼순 #1098 — `②-b roster/사진/inventory 자동머지 보류` 의 해제 근거).
 *
 * 배경: `crawl-roster-v2.mjs` 는 팀별 필터를 바꿔가며 기록 페이지를 긁는데,
 * 셀렉트 변경이 timeout 되면 `waitForTimeout` 으로 흘러가 *직전 팀 화면* 또는 *빈 표*
 * 를 그대로 스크레이프했다. 그 결과가 조용히 정상 완주로 저장돼 roster 가 오염되거나
 * 특정 팀이 통째로 사라져도 exit 0 이 됐다. 그래서 `roster 변경 = 사람이 봐야 함` 가드가
 * 필요했고, roster 는 콜업·말소로 거의 매일 바뀌므로 자동머지가 구조적으로 멈췄다.
 *
 * ── 2026-08-06 삼순 NO-GO 3건 반영 ─────────────────────────────
 *
 * ① baseline 축 오류 (actual crawl 영구 RED)
 *    이전 판은 *전체 roster 인원*(투수 포함, 미출장 보존분 포함)을 baseline 으로 두고
 *    *타자 phase 수집분*과 비교했다. 축이 다르므로 정상 크롤도 통과할 수 없다.
 *    실측(2026-08-06 저장본): 전체 baseline×0.7 기준으로 10팀 전부 FAIL,
 *    roster 를 phase 로 나눠도 5번 팀이 FAIL(rosterBat 43 vs statBat 26 — 기록 페이지는
 *    *출장 기록이 있는 선수*만 내려주므로 roster 보다 항상 작다).
 *    → baseline 은 같은 축, 즉 **직전 크롤이 저장한 같은 phase 의 팀별 수**로 잡는다.
 *
 * ② select 값만 보고 true (직전 팀 표 통과)
 *    셀렉트 최종값 확인은 "요청이 반영됐다"는 증거일 뿐 "표가 그 팀 것"이라는 증거가 아니다.
 *    KBO 기록 표에는 **팀명 컬럼**이 실재한다(실측 헤더: 순위·선수명·팀명·AVG…).
 *    → 수집한 행의 팀명이 전부 요청 팀인지 **witness** 로 대조한다. 이게 주 판정이고
 *      셀렉트 확인은 보조다.
 *
 * ③ quiet EOF·중복 ID·독립 set 안정성 미검증
 *    → 페이저 완주 여부, 팀 내 playerId 중복(같은 페이지 반복 수집),
 *      독립 재조회 set 동일성을 각각 판정한다.
 *
 * 순수 함수만 두어 실제 크롤 없이 결함주입 테스트가 가능하다.
 */

/** 팀별 최소 인원 — 기록 페이지 기준(출장 기록 보유자). 이보다 적으면 수집 사고로 본다. */
export const TEAM_MIN_PLAYERS = 15;

/** 같은 phase 직전 저장본 대비 허용 감소 비율. */
export const TEAM_MAX_DROP_RATIO = 0.3;

/** 팀 수집 1회 시도의 판정 사유. */
export const TEAM_FAIL_REASONS = {
  SELECT_UNCONFIRMED: "select_unconfirmed",
  WRONG_TEAM: "wrong_team",
  PAGER_INCOMPLETE: "pager_incomplete",
  DUPLICATE_IDS: "duplicate_ids",
  EMPTY: "empty",
  BELOW_FLOOR: "below_floor",
  DROP: "drop",
  UNSTABLE: "unstable",
};

/**
 * 같은 phase 의 직전 저장본에서 팀별 baseline 을 만든다.
 *
 * ⚠︎ roster 전체 인원을 쓰면 안 된다(삼순 NO-GO ①). 기록 페이지는 출장 기록이 있는
 * 선수만 내려주므로 roster(미출장·군 복무 보존분 포함)와 축이 다르다.
 *
 * @param {Array<{kboId:string|number}>} statRows 직전 저장본의 같은 phase 스탯 행
 * @param {Map<string, {teamId:number}>} rosterById kboId → roster 행
 */
export function buildPhaseBaseline(statRows, rosterById) {
  const baseline = new Map();
  for (const row of statRows || []) {
    const player = rosterById.get(String(row?.kboId));
    if (!player || player.teamId == null) continue;
    baseline.set(player.teamId, (baseline.get(player.teamId) || 0) + 1);
  }
  return baseline;
}

/**
 * 팀 1개 수집 결과를 판정한다.
 *
 * @param {object} input
 * @param {boolean} input.selectConfirmed 팀 셀렉트가 요청값으로 반영됐는지 (보조 증거)
 * @param {string} input.requestedTeamName 요청한 팀명
 * @param {string[]} input.observedTeamNames 수집 행에서 읽은 팀명들 (witness)
 * @param {number} input.collected 유효 행 수
 * @param {number} input.uniqueIds 유효 행의 서로 다른 playerId 수
 * @param {boolean} input.pagerComplete 페이저를 끝까지 돌았는지 (quiet EOF 차단)
 * @param {number|undefined} input.baseline 같은 phase 직전 저장본의 이 팀 수
 */
export function evaluateTeamCollection({
  selectConfirmed,
  requestedTeamName,
  observedTeamNames,
  collected,
  uniqueIds,
  pagerComplete,
  baseline,
  minPlayers = TEAM_MIN_PLAYERS,
  maxDropRatio = TEAM_MAX_DROP_RATIO,
}) {
  if (!selectConfirmed) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.SELECT_UNCONFIRMED,
      detail: "팀 셀렉트가 요청값으로 반영되지 않음",
    };
  }

  // ⚠︎ 순서 주의 — 진단이 가려지면 안 된다.
  // 종전에는 EMPTY 를 먼저 봐서, 실제 원인이 "페이저 미완주"여도 `empty` 로 보고됐다.
  // full dry-run 에서 KT 가 `empty` 로 찍혔지만 진짜 원인은 페이지 인덱스 오염이었고,
  // 그 때문에 원인 추적이 뒤늬다. 수집이 끝나지 않았다면 그걸 먼저 말한다.
  if (pagerComplete !== true) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.PAGER_INCOMPLETE,
      detail: "페이저를 끝까지 돌지 못함 — 부분 페이지만 수집됐다",
    };
  }

  if (!Number.isFinite(collected) || collected <= 0) {
    return { ok: false, reason: TEAM_FAIL_REASONS.EMPTY, detail: "수집 0명" };
  }

  // ── 팀명 witness ──────────────────────────────────────────
  // 셀렉트 값이 바뀌어도 표가 아직 직전 팀 것일 수 있다. 표 자체가 증인이다.
  const names = observedTeamNames || [];
  if (names.length === 0) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.WRONG_TEAM,
      detail: "행에서 팀명을 읽지 못함 — witness 없이 통과시키지 않는다",
    };
  }
  const foreign = [...new Set(names.filter((n) => n !== requestedTeamName))];
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.WRONG_TEAM,
      detail: `요청 ${requestedTeamName} 인데 표에 다른 팀 존재: ${foreign.join(",")}`,
    };
  }

  // ── 중복 ID (같은 페이지 반복 수집) ────────────────────────
  if (Number.isFinite(uniqueIds) && uniqueIds !== collected) {
    return {
      ok: false,
      reason: TEAM_FAIL_REASONS.DUPLICATE_IDS,
      detail: `행 ${collected}개 중 고유 ID ${uniqueIds}개 — 같은 페이지를 반복 수집했다`,
    };
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
        detail: `수집 ${collected}명 < 허용 하한 ${allowed}명 (직전 저장본 ${baseline}, 허용 감소 ${Math.round(maxDropRatio * 100)}%)`,
      };
    }
  }

  return { ok: true, reason: null, detail: `수집 ${collected}명` };
}

/**
 * 독립 재조회 2회의 playerId 집합이 동일한지 판정한다.
 * KBO 는 같은 순간에도 조회마다 다른 행 집합을 주는 일이 있다(#1103 전다민 flapping).
 * 흔들리는 판독을 정상 완주로 저장하면 그게 곧 오염이다.
 */
export function evaluateSetStability(firstIds, secondIds) {
  const a = new Set(firstIds || []);
  const b = new Set(secondIds || []);
  const onlyA = [...a].filter((id) => !b.has(id));
  const onlyB = [...b].filter((id) => !a.has(id));
  if (onlyA.length === 0 && onlyB.length === 0) {
    return { ok: true, reason: null, detail: `재조회 동일 (${a.size}명)` };
  }
  const diff = [
    onlyA.length > 0 ? `1회차만 ${onlyA.slice(0, 5).join(",")}` : "",
    onlyB.length > 0 ? `2회차만 ${onlyB.slice(0, 5).join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  return {
    ok: false,
    reason: TEAM_FAIL_REASONS.UNSTABLE,
    detail: `재조회 집합 불일치 — ${diff}`,
  };
}

/**
 * 전 팀 판정을 모아 완주 여부를 결정한다.
 * 한 팀이라도 실패하면 완주가 아니다 (fail-close).
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

/**
 * `endRequest` 응답 하나를 "재조회 증거로 썩는가"로 판정한다.
 *
 * 브라우저 안에서 돌던 판정을 **순수 함수로 뽑아낸** 이유:
 * 페이지 컨텍스트 안에만 있으면 게이트가 소스 문자열만 보게 돼 실제 행동을
 * 검증하지 못한다. 실제로 6차 NO-GO 가 그렇게 난 것이다 — 문자열로는
 * "fail-close 한다"고 쓰여 있었지만 `args?.get_error?.()` 는 args 나 메서드가
 * 없을 때 throw 가 아니라 `undefined` 를 돌려서 `undefined != null` → `false`,
 * 즉 **성공으로 샐다**(fail-open).
 *
 * 행동 계약(삼순 확정 매트릭스):
 *   get_error() === null / undefined → 성공   (success +1)
 *   get_error() 가 Error         → 실패   (error +1)
 *   args 가 없음               → 판단불가 → 실패
 *   get_error 가 함수가 아님    → 판단불가 → 실패
 *   get_error() 가 throw         → 판단불가 → 실패
 *
 * @returns {"success"|"error"}
 */
export function classifyEndRequest(args) {
  // ⚠︎ 프로퍼티 접근까지 try 안에 두어야 한다.
  // `typeof args.get_error` 를 try 밖에 두면 **throwing getter** 에서 예외가
  // 그대로 전파돼 endRequest 핸들러 밖으로 터진다(오류 응답이 집계도 안 된다).
  // 이건 mutation U3 를 돌려보다 발견했다 — 변이본이 원본보다 안전해서 잡혔다.
  try {
    if (args === null || args === undefined) return "error";
    if (typeof args.get_error !== "function") return "error";
    const err = args.get_error();
    return err === null || err === undefined ? "success" : "error";
  } catch {
    return "error"; // 판단 불가는 실패 취급(fail-close)
  }
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
