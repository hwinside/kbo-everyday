/**
 * 백필 한 회차의 성공 판정.
 *
 * 왜 별도 모듈인가
 *   route 파일 안에 두면 게이트가 이 판정을 **직접 호출할 수 없어** 정규식이나 AST 로
 *   흉내내게 되고, 그러면 판정이 죽어도 GREEN 이 난다(이 PR 에서만 5회 겪은 축).
 *   여기 두면 route 와 게이트가 **같은 함수**를 쓴다.
 *
 * fail-close 원칙
 *   한 칸이라도 못 봤거나 적재가 완전하지 않으면 성공이 아니다. 관대하게 판정하면
 *   "14일 확보" 가 거짓이 되고, 다음 실행이 무엇을 채워야 하는지 알 수 없다.
 */
export interface BackfillCell {
  /** API 결과창 밖이거나 sparse fan-out 이 건너뛴 날짜 — 못 본 칸. */
  apiUnreached?: boolean;
  /** 수집 실패·예산 초과 등으로 시도 자체가 못 끝난 칸. */
  error?: string;
}

export interface BackfillIngestSummary {
  failedRows: number;
  timedOut: boolean;
  /** 커버리지 원장에 실제로 기록된 행 수. */
  coverageWritten: number;
}

export interface BackfillOutcome {
  ok: boolean;
  cells: number;
  coveredCells: number;
  unobservedCells: number;
  failedCells: number;
  ingestFailed: boolean;
  label: "range_covered" | "range_partial";
}

export function judgeBackfillOutcome(
  cells: BackfillCell[],
  ingest: BackfillIngestSummary,
): BackfillOutcome {
  const unobservedCells = cells.filter((c) => c.apiUnreached).length;
  // `collect_failed` 는 apiUnreached 플래그를 달지 않는다. 그것만 세면 수집이 통째로
  // 실패한 팀이 있어도 ok:true 가 나온다(삼순 NO-GO).
  const failedCells = cells.filter((c) => c.error).length;
  // **두 집합은 겹친다.** 예산에 끊긴 팀은 14칸 전부 error 이고 그중 다수는 apiUnreached 이기도 하다.
  // 차감식(cells - unobserved - failed)으로 covered 를 구하면 겹친 칸을 두 번 빼서 음수가 된다
  // (실측 14-13-14 = -13, 삼순 NO-GO). covered 는 **직접 센다** — 파생값을 빼기로 구하지 않는다.
  const coveredCells = cells.filter((c) => !c.apiUnreached && !c.error).length;
  // 적재 쪽 실패 — 행 실패·예산 초과·커버리지 원장 미기록 전부 반영한다.
  // 커버리지는 "실패 사실을 남기는" 장치라, 그게 안 써졌으면 이 회차는 판정 불가다.
  const ingestFailed =
    ingest.failedRows > 0 || ingest.timedOut || ingest.coverageWritten < cells.length;
  // 전 칸이 확인됐고 적재도 완전할 때만 성공. `coveredCells === cells.length` 는
  // unobserved/failed 가 둘 다 0이라는 뜻과 동치이고, 겹침에 영향받지 않는다.
  const ok = coveredCells === cells.length && !ingestFailed;
  return {
    ok,
    cells: cells.length,
    coveredCells,
    unobservedCells,
    failedCells,
    ingestFailed,
    label: ok ? "range_covered" : "range_partial",
  };
}

/**
 * 수집 결과 하나를 **요청 창의 모든 날짜 칸**으로 편다.
 *
 * 왜 route 밖에 두는가
 *   route 안에 인라인으로 두면 게이트가 collector→칸→판정 사슬을 직접 태울 수 없어
 *   "deadlineHit 이 판정 입력에 결속됐는가" 를 정규식으로 흉내내게 된다. 그러면
 *   결속이 끊어져도 GREEN 이 난다(삼순 NO-GO 로 실제 발생). 여기 두면 route 와 게이트가
 *   **같은 함수**를 쓴다.
 */
export interface BackfillCollectResult {
  observedDays: Set<string>;
  reachedApiLimit: boolean;
  oldestReached: string | null;
  queriesUsed: number;
  pagesFetched: number;
  /** 예산이 팀 도중에 끊었는가. true 면 이 팀의 어떤 칸도 "확인 완료" 가 아니다. */
  deadlineHit: boolean;
}

export interface BackfillCellInput<Row> {
  teamId: number;
  windowDates: string[];
  result: BackfillCollectResult;
  /** 날짜별로 이미 매핑된 행. 없는 날짜는 빈 배열로 취급한다. */
  rowsByDate: Map<string, Row[]>;
  /**
   * 예산 초과 사유 문구. 생략하거나 빈 값이면 기본 문구를 쓴다.
   *
   * **문구가 결속을 결정하지 않는다.** 호출측이 빈 문자열을 넘겨도 `deadlineHit` 이 true 면
   * 칸은 반드시 실패로 표시된다 — 사유 텍스트가 마커 역할까지 겸하면, 문구 하나만 비어도
   * 부분 수집이 조용히 완주로 위장된다(M37 로 실측).
   */
  deadlineDetail?: string;
}

/** 호출측이 사유를 안 줬을 때 쓰는 기본 문구. 빈 마커로 결속이 끊기지 않게 한다. */
export const DEFAULT_BACKFILL_DEADLINE_DETAIL = "collect deadline exceeded mid-team";

export interface BackfillCellOutput<Row> extends BackfillCell {
  teamId: number;
  clipDate: string;
  rows: Row[];
  truncated: boolean;
  pagesFetched: number;
  reachedApiLimit: boolean;
  oldestReached: string | null;
  queriesUsed: number;
}

export function buildBackfillCells<Row>(
  input: BackfillCellInput<Row>,
): BackfillCellOutput<Row>[] {
  const { teamId, windowDates, result, rowsByDate, deadlineDetail } = input;
  // 예산이 중간에 끊었으면 그 팀의 창은 **어느 칸도 확인됐다고 말할 수 없다** —
  // 관측한 날짜조차 그 쿼리가 끝까지 안 돌아 부분이기 때문이다.
  // 사유 문구가 비어 있어도 결속은 유지한다(문구는 사람이 읽을 설명일 뿐, 마커가 아니다).
  const partial = result.deadlineHit
    ? (deadlineDetail?.trim() || DEFAULT_BACKFILL_DEADLINE_DETAIL)
    : undefined;

  return windowDates.map((clipDate) => ({
    teamId,
    clipDate,
    // 이미 거둔 기사는 버리지 않는다 — 부분이어도 근거로는 유효하다.
    // 다만 error 로 "이 칸은 확인 완료가 아니다" 를 원장과 판정에 함께 남긴다.
    rows: rowsByDate.get(clipDate) ?? [],
    truncated: result.reachedApiLimit,
    pagesFetched: result.pagesFetched,
    // 이 날짜를 실제로 봤는가. sparse 한 fan-out 은 며칠씩 건너뛰며 과거를 찍는다.
    apiUnreached: !result.observedDays.has(clipDate),
    error: partial,
    reachedApiLimit: result.reachedApiLimit,
    oldestReached: result.oldestReached,
    queriesUsed: result.queriesUsed,
  }));
}
