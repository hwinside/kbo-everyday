// 종료 알림 연승/연패 표기 정책.
// 배경(#cs 2026-07-18): 종료 알림이 KBO 순위표의 연속기록(continuousGameResult)을 그대로
// 읽는데, 경기 직후엔 순위표가 아직 오늘 결과를 반영하지 않아 같은 방향의 stale 카운트가
// 그대로 나갔다(실제 4연패 → "3연패" 발송). 기존 fail-closed(삼순 #210)는 "승리인데 연패"
// 같은 방향 모순만 차단하고, 같은 방향의 -1 오차는 못 잡는 구조.
// 해법: daily_standings_snapshot(매일 01:00 KST 적재, 오늘 날짜 행 = 어제까지 누적)의
// streak + 이번 경기 결과로 직접 계산 — 순위표 갱신 타이밍과 무관하게 결정적으로 정확.
// 스냅샷 부재(cron 미실행)·더블헤더(오늘 이 팀 final 2경기+, 스냅샷이 1차전을 모름)는
// 기존 라이브 방향일치 로직으로 폴백한다.

export type StreakDir = "승" | "패";

/** 스냅샷 streak "3연패"/"2연승" → { n, dir }. "1무"/파싱 불가 → null */
export function parseSnapshotStreak(s: string | null | undefined): { n: number; dir: StreakDir } | null {
  const m = (s ?? "").match(/^(\d+)연(승|패)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return { n, dir: m[2] as StreakDir };
}

export interface EndStreakInput {
  /** daily_standings_snapshot 오늘(KST) 행의 streak. 행 자체가 없으면 undefined */
  snapshotStreak: string | null | undefined;
  /** 오늘 스냅샷에 이 팀 행이 존재하는가 — false면 폴백 경로 */
  hasSnapshot: boolean;
  /** 이번 경기에서 이 팀의 결과 */
  result: StreakDir;
  /** 오늘 이 팀의 final 경기 수(이번 경기 포함). 2 이상 = 더블헤더 → 폴백 */
  finalsToday: number;
  /** 라이브 순위표 연속기록(폴백용, n>=2만 수록). 미상이면 undefined */
  liveStreak: { n: number; dir: StreakDir } | undefined;
}

/**
 * 표시할 연속 경기 수(>=2) 또는 null(미표시).
 * - 스냅샷 경로: 방향 일치 시 n+1, 불일치·무·파싱불가 시 1(새 streak 시작) → 2 미만 미표시.
 * - 폴백 경로(스냅샷 부재·더블헤더): 라이브 방향 일치 + n>=2일 때만 그대로 노출(기존 동작
 *   유지 — 순위표 갱신 지연 시 -1 오차 가능성이 남지만 방향 모순은 계속 차단).
 */
export function decideEndStreakCount(input: EndStreakInput): number | null {
  if (input.hasSnapshot && input.finalsToday <= 1) {
    const prev = parseSnapshotStreak(input.snapshotStreak);
    const n = prev && prev.dir === input.result ? prev.n + 1 : 1;
    return n >= 2 ? n : null;
  }
  const live = input.liveStreak;
  if (live && live.dir === input.result && live.n >= 2) return live.n;
  return null;
}
