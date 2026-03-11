/**
 * KST (UTC+9) date utilities.
 *
 * Problem: `new Date().toISOString().slice(0,10)` returns UTC date,
 * which is wrong between 00:00–08:59 KST (still previous day in UTC).
 *
 * These helpers ensure all date logic uses KST consistently.
 */

/** Current date in KST as YYYY-MM-DD */
export function getKSTToday(): string {
  const now = new Date();
  // Add 9 hours to UTC, then extract date from ISO string
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** Current KST Date object (start of day in KST, represented as local) */
export function getKSTNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}

/** Days from KST today to a target date string (YYYY-MM-DD). 0 = today, negative = past. */
export function daysFromKSTToday(targetDateStr: string): number {
  const target = new Date(targetDateStr + "T00:00:00+09:00").getTime();
  const todayStr = getKSTToday();
  const today = new Date(todayStr + "T00:00:00+09:00").getTime();
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

/** Generate dates around KST today for date selectors */
export function getKSTDateRange(range: number = 21) {
  const todayStr = getKSTToday();
  const todayDate = new Date(todayStr + "T12:00:00+09:00"); // noon to avoid DST edge cases

  const dates: { key: string; day: string; weekday: string; isToday: boolean }[] = [];
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];

  for (let i = -range; i <= range; i++) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const day = `${d.getMonth() + 1}/${d.getDate()}`;
    const weekday = weekdays[d.getDay()];
    dates.push({ key, day, weekday, isToday: i === 0 });
  }
  return dates;
}
