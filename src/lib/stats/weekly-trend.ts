import type { PlayerGameLog, PitcherGameLog } from "@/lib/constants/players";

/**
 * 주간 추이 집계 공용 모듈.
 * 선수 상세(PlayerWeeklyTrend)와 홈 최애선수 카드(FavoritePlayersSection)가
 * 동일 로직을 공유해 두 화면의 주간 타율/ERA가 정확히 일치하도록 한다.
 */

export interface WeeklyTrendRow {
  game_date: string; // YYYY-MM-DD
  ab: number;
  h: number;
  ip_outs: number;
  er: number;
}

/** YYYY-MM-DD → 그 주(ISO, 월요일 시작) 월요일의 "M/D" 라벨 + 정렬키. */
export function weekOf(dateStr: string): { key: string; label: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=일 .. 6=토
  const offset = dow === 0 ? -6 : 1 - dow; // 월요일까지
  dt.setUTCDate(dt.getUTCDate() + offset);
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  const key = `${dt.getUTCFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return { key, label: `${mm}/${dd}` };
}

/** 출전 경기(game_date asc) → 주간 타율/ERA 시계열. 분모 0 주는 제외. */
export function toWeeklyTrend(
  rows: WeeklyTrendRow[],
  isPitcher: boolean
): (PlayerGameLog | PitcherGameLog)[] {
  const buckets = new Map<string, { label: string; ab: number; h: number; er: number; outs: number }>();
  for (const r of rows) {
    const { key, label } = weekOf(r.game_date);
    const b = buckets.get(key) ?? { label, ab: 0, h: 0, er: 0, outs: 0 };
    b.ab += r.ab;
    b.h += r.h;
    b.er += r.er;
    b.outs += r.ip_outs;
    buckets.set(key, b);
  }
  const sorted = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (isPitcher) {
    return sorted
      .filter(([, b]) => b.outs > 0)
      .map(([, b]) => ({ date: b.label, era: (b.er * 27) / b.outs, whip: 0 }));
  }
  return sorted
    .filter(([, b]) => b.ab > 0)
    .map(([, b]) => ({ date: b.label, avg: b.h / b.ab, ops: 0 }));
}

/**
 * 최근 출전 N경기 평균 (rows는 game_date asc, 이미 출전 경기만 포함된다고 가정).
 * 타자=타율(h/ab), 투수=ERA(er*27/outs). 분모 0이면 null.
 */
export function recentAverage(
  rows: WeeklyTrendRow[],
  isPitcher: boolean,
  n: number
): number | null {
  const last = rows.slice(-n);
  if (last.length === 0) return null;
  if (isPitcher) {
    const outs = last.reduce((s, r) => s + (r.ip_outs ?? 0), 0);
    const er = last.reduce((s, r) => s + (r.er ?? 0), 0);
    if (outs === 0) return null;
    return (er * 27) / outs;
  }
  const ab = last.reduce((s, r) => s + (r.ab ?? 0), 0);
  const h = last.reduce((s, r) => s + (r.h ?? 0), 0);
  if (ab === 0) return null;
  return h / ab;
}

export type TrendDirection = "improving" | "declining" | "flat";

/**
 * 전주 대비 추세 — 주간 시계열의 마지막 두 주 비교.
 * 타자: 타율 ↑ = improving / 투수: ERA ↓ = improving (낮을수록 좋음).
 * 데이터 2주 미만이면 null.
 */
export function weeklyDirection(
  trend: (PlayerGameLog | PitcherGameLog)[],
  isPitcher: boolean
): TrendDirection | null {
  if (trend.length < 2) return null;
  const prev = trend[trend.length - 2];
  const curr = trend[trend.length - 1];
  const pv = isPitcher ? (prev as PitcherGameLog).era : (prev as PlayerGameLog).avg;
  const cv = isPitcher ? (curr as PitcherGameLog).era : (curr as PlayerGameLog).avg;
  if (cv === pv) return "flat";
  const better = isPitcher ? cv < pv : cv > pv;
  return better ? "improving" : "declining";
}
