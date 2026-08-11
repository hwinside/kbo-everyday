export const OWN_START_DATE = "2026-06-25";
export const GA_PREHISTORY_END = "2026-06-24";

export type TrendPoint = { date: string; users: number; pv: number };

/**
 * GA4 고정 과거 구간(6/24까지)과 자체 영구 원장(6/25부터)을 연결한다.
 * 현재 자체 지표의 GA4 폴백이 아니라 누적 차트의 과거 공백만 보완하는 함수다.
 */
export function mergeCumulativeSeries(
  ga: TrendPoint[],
  own: TrendPoint[],
): { date: string; users: number; pv: number }[] {
  if (ga.length === 0) throw new Error("GA4 prehistory returned no rows");
  if (own.some((r) => r.date < OWN_START_DATE)) {
    throw new Error("internal cumulative series crossed GA4 boundary");
  }
  if (ga.some((r) => r.date > GA_PREHISTORY_END)) {
    throw new Error("GA4 prehistory crossed internal boundary");
  }

  let previous = "";
  for (const row of [...ga, ...own]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date <= previous) {
      throw new Error("cumulative source dates are invalid or unordered");
    }
    if (!Number.isFinite(row.users) || !Number.isFinite(row.pv) || row.users < 0 || row.pv < 0) {
      throw new Error("cumulative source values are invalid");
    }
    previous = row.date;
  }

  const baseline = ga.at(-1)!;
  return [
    ...ga,
    ...own.map((r) => ({
      date: r.date,
      users: baseline.users + r.users,
      pv: baseline.pv + r.pv,
    })),
  ];
}
