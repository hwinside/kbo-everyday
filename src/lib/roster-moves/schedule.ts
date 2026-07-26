const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_RUN_MINUTE = 10 * 60;
const RUN_WINDOW_MINUTES = 30;
// 경기 전 실행 리드타임(분) — 첫 경기 2시간 전 + 1시간 전 각각 30분 윈도우.
const PREGAME_LEAD_MINUTES_LIST = [2 * 60, 1 * 60];

export interface RosterScheduleGame {
  time: string;
  status?: string;
}

export type PregameRunDecision =
  | { run: true; reason: "pregame"; firstGameTime: string; targetTime: string; targetTimes: string[] }
  | { run: false; reason: "no-games" }
  | { run: false; reason: "outside-pregame-window"; firstGameTime: string; targetTimes: string[] };

function kstMinuteOfDay(now: Date): number {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatTime(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 매일 10:00 KST 기본 실행. Vercel 지연을 고려해 30분 윈도우로 판정한다. */
export function isDailyRosterMovesWindow(now: Date): boolean {
  const minute = kstMinuteOfDay(now);
  return minute >= DAILY_RUN_MINUTE && minute < DAILY_RUN_MINUTE + RUN_WINDOW_MINUTES;
}

/**
 * 취소되지 않은 당일 첫 경기 기준으로, 시작 2시간 전 또는 1시간 전 30분 윈도우인지 판정한다.
 * 리드타임 중 하나라도 현재 30분 윈도우에 걸리면 run:true(가장 이른 매칭 targetTime 보고).
 */
export function getPregameRosterMovesDecision(
  games: RosterScheduleGame[],
  now: Date,
): PregameRunDecision {
  const firstGameMinute = games
    .filter((game) => game.status !== "cancelled")
    .map((game) => ({ time: game.time, minute: parseTime(game.time) }))
    .filter((game): game is { time: string; minute: number } => game.minute !== null)
    .sort((a, b) => a.minute - b.minute)[0];

  if (!firstGameMinute) return { run: false, reason: "no-games" };

  const currentMinute = kstMinuteOfDay(now);
  // 리드타임별 목표 시각(분). 음수(자정 이전) 목표는 제외한다.
  const targetMinutes = PREGAME_LEAD_MINUTES_LIST.map((lead) => firstGameMinute.minute - lead)
    .filter((minute) => minute >= 0)
    .sort((a, b) => a - b);
  const targetTimes = targetMinutes.map(formatTime);

  const matched = targetMinutes.find(
    (target) => currentMinute >= target && currentMinute < target + RUN_WINDOW_MINUTES,
  );

  if (matched !== undefined) {
    return {
      run: true,
      reason: "pregame",
      firstGameTime: firstGameMinute.time,
      targetTime: formatTime(matched),
      targetTimes,
    };
  }

  return {
    run: false,
    reason: "outside-pregame-window",
    firstGameTime: firstGameMinute.time,
    targetTimes,
  };
}
