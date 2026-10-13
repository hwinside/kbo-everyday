/** Daily GA activeUsers only. Never add daily uniques to obtain WAU/MAU/total,
 * and never substitute the internal visitor-id ledger when GA is unavailable. */
export const GA_DAU_PERIODS = ["today", "7d", "30d", "90d", "180d", "all"] as const;
export type GaDauPeriod = typeof GA_DAU_PERIODS[number];
export type GaDauDaily = { date: string; activeUsers: number | null };
export type GaDauResponse = {
  source: "ga4";
  metric: "activeUsers";
  period: GaDauPeriod;
  timeZone: string;
  startDate: string;
  endDate: string;
  today: string;
  dau: number | null;
  daily: GaDauDaily[];
  missingDates: string[];
  subjectToThresholding: boolean;
};
type Report = {
  rowCount?: number;
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues: { value: string }[] }[];
  metadata?: { timeZone?: string; dataLossFromOtherRow?: boolean; subjectToThresholding?: boolean; samplingMetadatas?: unknown[] };
};
type RunReport = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

function isoDate(raw: string): string {
  const value = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("GA4 returned an invalid date");
  }
  return value;
}
function count(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error("GA4 returned an invalid activeUsers count");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("GA4 activeUsers exceeds safe integer range");
  return value;
}
function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function propertyDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return isoDate(`${part("year")}-${part("month")}-${part("day")}`);
}
function validate(report: Report, timeZone?: string, daily = true): string {
  const zone = report.metadata?.timeZone;
  if (!zone || (timeZone && zone !== timeZone)) throw new Error("GA4 report timezone missing or changed");
  if (report.metricHeaders?.length !== 1 || report.metricHeaders[0].name !== "activeUsers") throw new Error("GA4 daily metric mismatch");
  if (daily && (report.dimensionHeaders?.length !== 1 || report.dimensionHeaders[0].name !== "date")) throw new Error("GA4 daily dimension mismatch");
  if (report.metadata?.dataLossFromOtherRow || report.metadata?.samplingMetadatas?.length) throw new Error("GA4 returned an incomplete or sampled daily report");
  return zone;
}

export async function loadGa4Dau(
  period: GaDauPeriod,
  runReport: RunReport,
  now = new Date(),
  // Full historical backfill is a GA read-through, not a rewrite of internal
  // visitor IDs. The audited extraction covers this start through the present.
  historyStart = "2024-01-01",
): Promise<GaDauResponse> {
  if (!GA_DAU_PERIODS.includes(period)) throw new Error("Invalid DAU period");
  const start = period === "today" ? "today" : period === "all" ? isoDate(historyStart) : `${parseInt(period)}daysAgo`;
  const end = period === "today" ? "today" : "yesterday";
  const values = new Map<string, number>();
  let total: number | undefined;
  let zone: string | undefined;
  let thresholding = false;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const report = await runReport({
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      keepEmptyRows: true, limit: PAGE_SIZE, offset,
    }) as Report;
    zone = validate(report, zone);
    thresholding ||= !!report.metadata?.subjectToThresholding;
    const rowCount = report.rowCount ?? 0;
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > MAX_ROWS || (total !== undefined && rowCount !== total)) {
      throw new Error("GA4 daily row count changed or exceeds bounds");
    }
    total = rowCount;
    const rows = report.rows ?? [];
    if (rows.length > PAGE_SIZE || (offset + rows.length < total && rows.length !== PAGE_SIZE) || offset + rows.length > total) {
      throw new Error("GA4 daily report was truncated");
    }
    for (const row of rows) {
      const date = isoDate(row.dimensionValues?.[0]?.value ?? "");
      if (values.has(date)) throw new Error("GA4 daily report returned duplicate dates");
      values.set(date, count(row.metricValues?.[0]?.value));
    }
    if (values.size === total) break;
  }
  const today = propertyDay(now, zone!);
  const endDate = period === "today" ? today : shift(today, -1);
  const sorted = [...values.keys()].sort();
  const startDate = period === "today" ? today : period === "all" ? (sorted[0] ?? isoDate(historyStart)) : shift(today, -parseInt(period));
  for (const date of sorted) {
    if (date < (period === "all" ? isoDate(historyStart) : startDate) || date > endDate) throw new Error("GA4 daily date outside requested range");
  }

  // An absent dimension row is not automatically zero. Verify small internal
  // gaps with an aggregate report for that single day. No fabrication before
  // the first observed date, and no unbounded API fan-out on empty histories.
  const gaps: string[] = [];
  if (sorted.length) {
    for (let date = sorted[0]; date <= sorted.at(-1)!; date = shift(date, 1)) {
      if (!values.has(date)) gaps.push(date);
    }
  }
  if (gaps.length <= 31) {
    for (const date of gaps) {
      const report = await runReport({ dateRanges: [{ startDate: date, endDate: date }], metrics: [{ name: "activeUsers" }], keepEmptyRows: true }) as Report;
      validate(report, zone, false);
      thresholding ||= !!report.metadata?.subjectToThresholding;
      if (report.rowCount === 1 && report.rows?.length === 1) values.set(date, count(report.rows[0].metricValues?.[0]?.value));
    }
  }
  const daily: GaDauDaily[] = [];
  if (period !== "all" || sorted.length) {
    for (let date = startDate; date <= endDate; date = shift(date, 1)) {
      if (daily.length >= MAX_ROWS) throw new Error("GA4 daily calendar exceeds bounds");
      daily.push({ date, activeUsers: values.get(date) ?? null });
    }
  }
  return {
    source: "ga4", metric: "activeUsers", period, timeZone: zone!, startDate, endDate, today,
    dau: period === "today" ? values.get(today) ?? null : null,
    daily, missingDates: daily.filter(d => d.activeUsers === null).map(d => d.date),
    subjectToThresholding: thresholding,
  };
}
