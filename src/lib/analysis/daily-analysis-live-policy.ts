// 순위 AI분석 live(당일 즉시 반영) 트리거의 순수 정책 로직 (삼순 PR #690 리뷰 대응).
//
// 3가지 순수 함수 + claim 오케스트레이션:
//  1) evaluateLiveReadiness  — P0①: 원천(순위/타이틀)이 오늘 finals를 반영했는지 gate(+10팀 sanity)
//  2) resolveLiveTarget      — P0②: 자정 넘긴 지연/연장 경기 catch-up 위한 {gameDate, saveDate} 해석
//  3) isAlreadyReflected     — 멱등성: saveDate 행이 이미 gameDate를 반영했는지(하루 1회 저장 보장)
//  4) runLiveAnalysisWithClaim/shouldReleaseAfterRun — P0②(멱등성 race): date-unique claim(CAS+lease)

// ===== 1) readiness gate (P0①) =====

export interface ReadinessStandingRow {
  team_id: number;
  wins: number;
  losses: number;
  draws: number;
}
export interface ReadinessCurrentStanding {
  teamId: number;
  wins: number;
  losses: number;
  draws: number;
}
export interface ReadinessFinalGame {
  awayTeamId: number;
  homeTeamId: number;
}
export interface ReadinessTitleRow {
  category: string;
  rank: number;
  player_name: string;
  value: number;
}
export interface LiveReadinessResult {
  ready: boolean;
  reason: string;
  laggingTeams: number[];
}

/**
 * live 분석을 지금 확정해도 되는지 판정(순수). 모든 게이트 fail-closed(불확실하면 not ready).
 * - sanity: 현재 순위표 고유 팀 수가 expectedTeamCount(기본 10) 미만이면 부분 응답 → not ready
 * - baseline 완전성: baseline 고유 팀 수가 expectedTeamCount 미만이면(누락 팀 0 대체로 false-ready 방지) not ready
 * - 순위표: 팀별 (baseline 누적 경기수 + 오늘 finals) === 현재 누적 경기수 정확 일치
 *   (current<expected=미반영 / current>expected=혼합·과반영 → 둘 다 not ready)
 * - 타이틀 completeness: 현재 원천이 baseline 카테고리/행을 다 커버해야(빈 배열/부분 응답 배제)
 * - 타이틀 settle: 현재 원천이 baseline과 완전 동일하면(= 오늘 미반영) not ready
 */
export function evaluateLiveReadiness(params: {
  baselineStandings: ReadinessStandingRow[];
  currentStandings: ReadinessCurrentStanding[];
  todayFinalGames: ReadinessFinalGame[];
  baselineStats: ReadinessTitleRow[];
  currentStats: ReadinessTitleRow[];
  expectedTeamCount?: number;
  // 기대 타이틀 카테고리 권위 집합(core가 전달). baseline이 이 중 하나라도 빠지면
  // baseline 자체가 부분 응답이므로 fail-closed. 미지정 시 baseline 보유 카테고리로 폴백.
  expectedTitleCategories?: string[];
  // 카테고리당 기대 '유효·고유' 행 수(core가 전달, 기본 10). baseline/current 어느 쪽이든
  // 이 수를 못 채우면(부분 snapshot·빈 선수명·중복 행) fail-closed → stale 마커 고착 방지.
  expectedTitleRowsPerCategory?: number;
}): LiveReadinessResult {
  const { baselineStandings, currentStandings, todayFinalGames, baselineStats, currentStats } = params;
  const expectedTeamCount = params.expectedTeamCount ?? 10;

  // sanity: 순위표 원천이 부분 응답이면(고유 팀 수 부족) 판정 보류.
  const currentTeamIds = new Set(currentStandings.map((s) => s.teamId));
  if (currentTeamIds.size < expectedTeamCount) {
    return {
      ready: false,
      reason: `standings partial response: ${currentTeamIds.size}/${expectedTeamCount} teams`,
      laggingTeams: [],
    };
  }

  // baseline 완전성 — 누락 팀 baseline을 0으로 대체하면 그 팀이 항상 통과(false-ready)하므로
  //   baseline도 완전(고유 팀 수 = expected)해야 함. 스냅샷 부분 저장/혼합 날짜 방어.
  const baselineTeamIds = new Set(baselineStandings.map((s) => s.team_id));
  if (baselineTeamIds.size < expectedTeamCount) {
    return {
      ready: false,
      reason: `baseline incomplete: ${baselineTeamIds.size}/${expectedTeamCount} teams`,
      laggingTeams: [],
    };
  }

  const gp = (w: number, l: number, d: number) => w + l + d;
  const baseGames = new Map<number, number>();
  for (const s of baselineStandings) baseGames.set(s.team_id, gp(s.wins, s.losses, s.draws));
  const curGames = new Map<number, number>();
  for (const s of currentStandings) curGames.set(s.teamId, gp(s.wins, s.losses, s.draws));

  const finalsByTeam = new Map<number, number>();
  for (const g of todayFinalGames) {
    for (const tid of [g.awayTeamId, g.homeTeamId]) {
      if (tid > 0) finalsByTeam.set(tid, (finalsByTeam.get(tid) ?? 0) + 1);
    }
  }

  // 팀별 경기수: baseline + 오늘 finals === 현재 누적 (정확 일치 fail-closed).
  const laggingTeams: number[] = [];
  for (const [teamId, finals] of finalsByTeam) {
    const base = baseGames.get(teamId);
    const current = curGames.get(teamId);
    if (base === undefined || current === undefined || current !== base + finals) {
      laggingTeams.push(teamId);
    }
  }
  if (laggingTeams.length > 0) {
    const sorted = laggingTeams.sort((a, b) => a - b);
    return { ready: false, reason: `standings not settled: teams ${sorted.join(",")}`, laggingTeams: sorted };
  }

  // 타이틀 completeness + settle (모두 fail-closed).
  //   행 수만 상대 비교(c >= b)하면 부분 snapshot(카테고리당 1행)이 임계치를 1로 낮추거나,
  //   KBO 마크업 드리프트가 만든 '빈 선수명 10행'/중복 행이 유효로 통과해 stale 마커가 고착된다.
  //   → baseline/current 모두 기대 9종 각 expectedRows(기본 10) '유효·고유 선수'를 정확히 강제.
  //     유효 = player_name 비어있지 않음 + rank/value finite.
  //     고유 = 카테고리 내 trim(player_name) 기준(같은 선수의 rank/value만 바꿔 중복하는 것도 차단).
  //   (baseline이 못 채우면 01:00 scheduled 백스톱이 보정)
  if (baselineStats.length === 0) {
    return { ready: false, reason: "baseline titles empty", laggingTeams: [] };
  }
  const expectedRows = params.expectedTitleRowsPerCategory ?? 10;
  // 기대 카테고리: core가 전달한 권위 집합(baseline 부분 카테고리 감지). 미지정 시 baseline 보유 카테고리.
  const expectedCats =
    params.expectedTitleCategories ?? [...new Set(baselineStats.map((r) => r.category))];
  const inspectCategory = (rows: ReadinessTitleRow[], category: string) => {
    const categoryRows = rows.filter((r) => r.category === category);
    const validRows = categoryRows.filter(
      (r) =>
        typeof r.player_name === "string" &&
        r.player_name.trim() !== "" &&
        Number.isFinite(r.rank) &&
        Number.isFinite(r.value),
    );
    return {
      rows: categoryRows.length,
      validRows: validRows.length,
      uniquePlayers: new Set(validRows.map((r) => r.player_name.trim())).size,
    };
  };
  for (const cat of expectedCats) {
    const baseline = inspectCategory(baselineStats, cat);
    if (baseline.rows !== expectedRows) {
      return {
        ready: false,
        reason: `baseline titles invalid: ${cat} ${baseline.rows}/${expectedRows} rows`,
        laggingTeams: [],
      };
    }
    if (baseline.validRows !== expectedRows) {
      return {
        ready: false,
        reason: `baseline titles invalid: ${cat} ${baseline.validRows}/${expectedRows} valid rows`,
        laggingTeams: [],
      };
    }
    if (baseline.uniquePlayers !== expectedRows) {
      return {
        ready: false,
        reason: `baseline titles invalid: ${cat} ${baseline.uniquePlayers}/${expectedRows} unique players`,
        laggingTeams: [],
      };
    }
    const current = inspectCategory(currentStats, cat);
    if (current.rows !== expectedRows) {
      return {
        ready: false,
        reason: `titles invalid: ${cat} ${current.rows}/${expectedRows} rows`,
        laggingTeams: [],
      };
    }
    if (current.validRows !== expectedRows) {
      return {
        ready: false,
        reason: `titles invalid: ${cat} ${current.validRows}/${expectedRows} valid rows`,
        laggingTeams: [],
      };
    }
    if (current.uniquePlayers !== expectedRows) {
      return {
        ready: false,
        reason: `titles invalid: ${cat} ${current.uniquePlayers}/${expectedRows} unique players`,
        laggingTeams: [],
      };
    }
  }
  // settle: 현재 원천이 baseline과 완전 동일하면 아직 미반영으로 간주(별도 안전장치).
  const norm = (rows: ReadinessTitleRow[]) =>
    rows.map((r) => `${r.category}|${r.rank}|${r.player_name}|${r.value}`).sort().join("\n");
  if (norm(currentStats) === norm(baselineStats)) {
    return { ready: false, reason: "titles not settled (identical to baseline)", laggingTeams: [] };
  }

  return { ready: true, reason: "ready", laggingTeams: [] };
}

// ===== 2) 타깃 해석 (P0②: 자정 넘긴 경기 catch-up) =====

export interface SlateState {
  hasGames: boolean;
  allTerminal: boolean; // 모든 경기가 final/cancelled
  finalCount: number;
}
export interface LiveTarget {
  gameDate: string; // 분석 대상 경기일
  saveDate: string; // daily_analysis 저장 날짜(=표시일)
}

/**
 * 지금 처리할 {gameDate, saveDate}를 해석(순수).
 * - 정상(저녁): 오늘 경기가 전부 종료(≥1 final)면 gameDate=saveDate=오늘
 * - catch-up(자정 이후): 오늘 슬레이트가 아직(진행중/미개시)이고 어제 슬레이트가 전부 종료면
 *   gameDate=어제, saveDate=오늘 (지연/연장 경기가 자정 넘겨 종료된 케이스)
 * - 그 외: null(처리 대상 없음)
 * 날짜 규약: saveDate 저장은 scheduled(01:00 백스톱)와 동일(어제→오늘 저장)이라 멱등.
 */
export function resolveLiveTarget(params: {
  todayISO: string;
  yesterdayISO: string;
  today: SlateState;
  yesterday: SlateState;
}): LiveTarget | null {
  const { todayISO, yesterdayISO, today, yesterday } = params;
  if (today.hasGames && today.allTerminal && today.finalCount >= 1) {
    return { gameDate: todayISO, saveDate: todayISO };
  }
  if (yesterday.hasGames && yesterday.allTerminal && yesterday.finalCount >= 1) {
    return { gameDate: yesterdayISO, saveDate: todayISO };
  }
  return null;
}

// ===== 3) 멱등성 판정 =====

export interface ExistingAnalysisMeta {
  sameDayLive?: boolean;
  lastUpdated?: string;
}

/**
 * saveDate 행이 이미 gameDate를 반영했는지(순수). true면 skip(하루 1회 저장 보장).
 * - gameDate===saveDate(정상 당일): live 마커(sameDayLive && lastUpdated===gameDate)일 때만 반영됨.
 *   (scheduled가 남긴 어제분석은 오늘을 반영하지 않으므로 skip 아님)
 * - gameDate===saveDate-1(catch-up): saveDate 행은 관례상 saveDate-1을 반영하므로
 *   scheduled/live 무엇이든 행이 존재하면 이미 반영됨.
 */
export function isAlreadyReflected(
  gameDate: string,
  saveDate: string,
  existing: ExistingAnalysisMeta | null | undefined,
): boolean {
  if (!existing) return false;
  if (gameDate === saveDate) {
    return existing.sameDayLive === true && existing.lastUpdated === gameDate;
  }
  // catch-up: saveDate 행이 존재하면(scheduled 또는 이전 catch-up) 이미 gameDate 반영.
  return true;
}

// ===== 3b) route DB/RPC 결과 해석 (fail-closed) =====
// 조회/claim 오류(마이그 누락/권한)를 미반영/contention으로 축약하면 200 skip으로 숨어 영구
// 미실행을 관제에서 놓친다. route가 이 순수 함수를 그대로 사용해 error 분기를 스모크가 실제 검증.

/** claim RPC 결과 해석: 오류는 throw(route가 5xx). 정상 contention(data!==true)만 false. */
export function interpretClaimRpc(result: { data: unknown; error: { message: string } | null }): boolean {
  if (result.error) throw new Error(`claim rpc failed: ${result.error.message}`);
  return result.data === true;
}

/** 조회 결과 오류면 throw(route가 5xx). 미반영으로 축약 금지. */
export function assertLookupOk(result: { error: { message: string } | null }, label: string): void {
  if (result.error) throw new Error(`${label} lookup failed: ${result.error.message}`);
}

// ===== 4) 원자적 claim 오케스트레이션 (P0②: 멱등성 race) =====

export interface LiveClaimOutcome {
  status: number;
  body: Record<string, unknown>;
}
export interface LiveClaimDeps {
  claim: () => Promise<boolean>;
  release: () => Promise<void>;
  run: () => Promise<LiveClaimOutcome>;
}

/** 생성 결과가 "마커 없이 다음 tick 재시도" 대상인지(not-ready 또는 서버 오류). */
export function shouldReleaseAfterRun(outcome: LiveClaimOutcome): boolean {
  if (outcome.status >= 500) return true;
  return outcome.body?.skipped === "not_ready";
}

export async function runLiveAnalysisWithClaim(deps: LiveClaimDeps): Promise<LiveClaimOutcome> {
  const claimed = await deps.claim();
  if (!claimed) {
    return { status: 200, body: { ok: true, skipped: "claim held by concurrent run" } };
  }
  let outcome: LiveClaimOutcome;
  try {
    outcome = await deps.run();
  } catch (e) {
    await deps.release();
    throw e;
  }
  if (shouldReleaseAfterRun(outcome)) {
    await deps.release();
  }
  return outcome;
}
