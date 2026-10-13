/** Calendar-window uniques, not a sum of daily DAU or GA's 28-day metric. */
export type GaActiveWindow = {
  days: 7 | 30;
  startDate: string;
  endDate: string;
  activeUsers: number | null;
};
export type GaActiveWindowsResponse = {
  source: "ga4";
  metric: "activeUsers";
  timeZone: string;
  includesToday: true;
  windows: { wau: GaActiveWindow; mau: GaActiveWindow };
  subjectToThresholding: boolean;
};
type Report = {
  rowCount?: number;
  dimensionHeaders?: unknown[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: unknown[]; metricValues?: { value: string }[] }[];
  metadata?: { timeZone?: string; dataLossFromOtherRow?: boolean; samplingMetadatas?: unknown[]; subjectToThresholding?: boolean };
};
type RunReport = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
// Verified GA4 property metadata (2026-09-08). Fail closed if it changes.
const PROPERTY_TIME_ZONE = "Asia/Seoul";

function read(report: Report) {
  const timeZone = report.metadata?.timeZone;
  if (!timeZone) throw new Error("GA4 window timezone missing");
  if (report.metricHeaders?.length !== 1 || report.metricHeaders[0].name !== "activeUsers") throw new Error("GA4 window metric mismatch");
  if (report.dimensionHeaders?.length) throw new Error("GA4 window must be an undimensioned unique count");
  if (report.metadata?.dataLossFromOtherRow || report.metadata?.samplingMetadatas?.length) throw new Error("GA4 window report is incomplete or sampled");
  const rows = report.rows ?? [];
  if (rows.length > 1 || (report.rowCount ?? rows.length) !== rows.length) throw new Error("GA4 window row count mismatch");
  if (!rows.length) return { timeZone, value: null, thresholding: !!report.metadata?.subjectToThresholding };
  const row = rows[0];
  const raw = row.metricValues?.[0]?.value;
  if (row.dimensionValues?.length || row.metricValues?.length !== 1 || raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("GA4 window activeUsers count invalid");
  }
  return { timeZone, value: Number(raw), thresholding: !!report.metadata?.subjectToThresholding };
}

function day(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function loadGa4ActiveWindows(runReport: RunReport, now = new Date()): Promise<GaActiveWindowsResponse> {
  // GA date ranges are inclusive: today-6..today = 7 days; -29..today = 30.
  // Fix absolute bounds once: two relative "today" requests can straddle midnight.
  const endDate = day(now, PROPERTY_TIME_ZONE);
  const window = (days: 7 | 30, activeUsers: number | null): GaActiveWindow => {
    const start = new Date(`${endDate}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - days + 1);
    return { days, startDate: start.toISOString().slice(0, 10), endDate, activeUsers };
  };
  // Omit dimensions so a returning user is counted once across the whole range.
  const reports = await Promise.all(([7, 30] as const).map(days => runReport({
    dateRanges: [{ startDate: window(days, null).startDate, endDate }],
    metrics: [{ name: "activeUsers" }],
    keepEmptyRows: true,
  })));
  const [wau, mau] = reports.map(report => read(report as Report));
  if (wau.timeZone !== PROPERTY_TIME_ZONE || mau.timeZone !== PROPERTY_TIME_ZONE) throw new Error("GA4 window timezone changed");
  return {
    source: "ga4", metric: "activeUsers", timeZone: wau.timeZone, includesToday: true,
    windows: { wau: window(7, wau.value), mau: window(30, mau.value) },
    subjectToThresholding: wau.thresholding || mau.thresholding,
  };
}
