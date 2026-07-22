const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_RUN_MINUTE = 10 * 60;
const RUN_WINDOW_MINUTES = 30;
const PREGAME_LEAD_MINUTES = 2 * 60;

export interface RosterScheduleGame {
  time: string;
  status?: string;
}

export type PregameRunDecision =
  | { run: true; reason: "pregame"; firstGameTime: string; targetTime: string }
  | { run: false; reason: "no-games" | "outside-pregame-window"; firstGameTime?: string; targetTime?: string };

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

/** 취소되지 않은 당일 첫 경기의 시작 2시간 전 30분 윈도우인지 판정한다. */
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

  const targetMinute = firstGameMinute.minute - PREGAME_LEAD_MINUTES;
  const currentMinute = kstMinuteOfDay(now);
  const context = {
    firstGameTime: firstGameMinute.time,
    targetTime: formatTime(targetMinute),
  };

  if (
    targetMinute >= 0 &&
    currentMinute >= targetMinute &&
    currentMinute < targetMinute + RUN_WINDOW_MINUTES
  ) {
    return { run: true, reason: "pregame", ...context };
  }

  return { run: false, reason: "outside-pregame-window", ...context };
}
