/**
 * retention cron 경기일 수집·targetDate 정책 (2026-07-21, PR #736 삼순 리뷰 반영)
 *
 * ① targetDate: 기본 오늘(KST). `?date=YYYY-MM-DD`로 과거 소급(backfill) 허용 —
 *    형식·실존 달력일·미래 금지·최대 60일 lookback 검증(fail-close).
 * ② 경기일 수집: 10개 배치 병렬 + 실패 날짜 bounded retry(2회 추가 패스) +
 *    잔여 실패 시 호출측 fail-close(불완전 gameDates로 gameday upsert 금지).
 */

export const LOOKBACK_DAYS = 60;
export const BATCH_SIZE = 10;
export const MAX_RETRY_PASSES = 2;
export const MAX_BACKFILL_DAYS = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * targetDate 기준 최근 days+1개 날짜, 오래된 날짜부터 오름차순.
 * ⚠️ baseline 보존: 기존 route와 동일하게 KST 자정을 toISOString(UTC)으로 슬라이스하므로
 * 실제 범위는 [targetDate-days-1 .. targetDate-1] — 결과 동일성 유지를 위해 의도적으로 유지
 * (gameday 지표는 종료 경기 기준이라 당일 제외가 자연스럽고, 변경 시 기존 행과 정합 깨짐).
 */
export function buildDateRange(targetDate: string, days: number = LOOKBACK_DAYS): string[] {
  const baseMs = new Date(targetDate + "T00:00:00+09:00").getTime();
  const dates: string[] = [];
  for (let i = days; i >= 0; i--) {
    dates.push(new Date(baseMs - i * 86400000).toISOString().slice(0, 10));
  }
  return dates;
}

export type TargetDateResult =
  | { ok: true; date: string }
  | { ok: false; error: string };

/**
 * cron/수동 트리거의 targetDate 해석.
 * raw가 null/빈값이면 todayKst. 그 외엔 YYYY-MM-DD 형식 + 실존 달력일 +
 * 미래 금지 + todayKst 기준 MAX_BACKFILL_DAYS 이내만 허용.
 */
export function resolveTargetDate(raw: string | null, todayKst: string): TargetDateResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, date: todayKst };
  if (!DATE_RE.test(trimmed)) {
    return { ok: false, error: `invalid date format: ${trimmed} (expected YYYY-MM-DD)` };
  }
  // 실존 달력일 검증 (2026-02-30 등 거부): UTC round-trip이 입력과 일치해야 함
  const parsed = new Date(trimmed + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    return { ok: false, error: `invalid calendar date: ${trimmed}` };
  }
  if (trimmed > todayKst) {
    return { ok: false, error: `future date not allowed: ${trimmed} (today ${todayKst})` };
  }
  const diffDays = Math.round(
    (new Date(todayKst + "T00:00:00Z").getTime() - parsed.getTime()) / 86400000,
  );
  if (diffDays > MAX_BACKFILL_DAYS) {
    return {
      ok: false,
      error: `date too old: ${trimmed} (max backfill ${MAX_BACKFILL_DAYS} days)`,
    };
  }
  return { ok: true, date: trimmed };
}

/**
 * backfill(과거 소급) 실행 여부. (2026-07-21 삼순 리뷰 계약 확정)
 * funnel 축은 profiles.team_id/favorite_players 등 mutable 현재 상태에 의존해
 * 과거 시점의 exact 복원이 불가능 → backfill 실행에서는 funnel을 제외한다
 * (근사치로 과거 행을 조작하는 것보다 결측이 정직. funnel은 as-of 누적 스냅샷이라
 * 당일 행이 현재 진실을 대변 — 일별 결측 무해). 나머지 4축은 timestamped
 * 이벤트 기반(KST 일말 상한 포함)이라 소급 안전.
 */
export function isBackfill(targetDate: string, todayKst: string): boolean {
  return targetDate < todayKst;
}

export interface CollectGameDatesResult {
  /** 경기 있는 날짜, 입력 순서(오름차순) 보존 */
  gameDates: string[];
  /** bounded retry 후에도 실패한 날짜 — 있으면 호출측 fail-close 필수 */
  failedDates: string[];
  /** 총 fetch 시도 횟수 (관측용) */
  fetchAttempts: number;
}

/**
 * 날짜별 경기 존재 여부를 배치 병렬 수집.
 * - 결과 순서는 입력 dates 순서 보존
 * - 실패 날짜는 최대 MAX_RETRY_PASSES회 추가 재시도(같은 배치 정책)
 * - 잔여 실패는 failedDates로 반환 — 무경기 취급 금지, 호출측에서 fail-close
 */
export async function collectGameDates(
  dates: string[],
  fetchHasGames: (date: string) => Promise<boolean>,
  opts: { batchSize?: number; maxRetryPasses?: number } = {},
): Promise<CollectGameDatesResult> {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxRetryPasses = opts.maxRetryPasses ?? MAX_RETRY_PASSES;

  const hasGames = new Map<string, boolean>();
  let fetchAttempts = 0;

  async function runPass(targets: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let start = 0; start < targets.length; start += batchSize) {
      const batch = targets.slice(start, start + batchSize);
      await Promise.all(
        batch.map(async (d) => {
          fetchAttempts++;
          try {
            hasGames.set(d, await fetchHasGames(d));
          } catch {
            failed.push(d);
          }
        }),
      );
    }
    return failed;
  }

  let pending = await runPass(dates);
  for (let pass = 0; pass < maxRetryPasses && pending.length > 0; pass++) {
    pending = await runPass(pending);
  }

  return {
    gameDates: dates.filter((d) => hasGames.get(d) === true),
    failedDates: dates.filter((d) => pending.includes(d)),
    fetchAttempts,
  };
}
