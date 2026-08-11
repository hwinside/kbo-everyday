import baselineJson from "../../../../data/baseball-qa/kbo-career-hitter-through-2025.json";
import { fetchServedBatterSnapshot } from "./served-record";
import { STATS_STALE_MS, type SeasonRecordRow } from "./season-record";

const CAREER_SOURCE_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx";

export type CareerLeaderboardMetric = "hits";
export interface CareerLeaderboardIntent {
  metric: CareerLeaderboardMetric;
  label: "안타";
}
interface BaselineRow {
  kboId: string;
  name: string;
  team: string;
  hits: number;
}
interface BaselineSnapshot {
  schemaVersion: number;
  throughSeason: number;
  source: { url: string; seasonValue: string; sortKey: string; order: string };
  rowCount: number;
  rows: BaselineRow[];
}
export interface CareerLeaderboardAnswer {
  metric: CareerLeaderboardMetric;
  label: string;
  leaders: Array<{ kboId: string; name: string; team: string; total: number; baseline: number; current: number }>;
  asOf: string;
  baselineThroughSeason: number;
  sourceUrl: string;
}
export type CareerLeaderboardFetcher = (
  intent: CareerLeaderboardIntent,
  now?: Date,
) => Promise<CareerLeaderboardAnswer | null>;

/** 첫 수직 슬라이스: 공식 통산 순위 질문 중 안타 1위만 닫힌 구조로 잡는다. */
export function resolveCareerLeaderboardIntent(question: string): CareerLeaderboardIntent | null {
  const normalized = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const temporal = ["통산", "역대", "커리어", "누적"].some((word) => normalized.includes(word));
  const rankAsk = normalized.includes("1위") || normalized.includes("최다") || normalized.includes("선두");
  if (!temporal || !rankAsk || !normalized.includes("안타")) return null;
  return { metric: "hits", label: "안타" };
}

function validSnapshot(value: unknown): value is BaselineSnapshot {
  const s = value as Partial<BaselineSnapshot>;
  if (s.schemaVersion !== 1 || s.throughSeason !== 2025 || s.source?.url !== CAREER_SOURCE_URL) return false;
  if (s.source.seasonValue !== "9999" || s.source.sortKey !== "HIT_CN" || s.source.order !== "DESC") return false;
  if (!Array.isArray(s.rows) || s.rows.length < 100 || s.rowCount !== s.rows.length) return false;
  const ids = new Set<string>();
  for (const row of s.rows) {
    if (!/^\d+$/.test(row.kboId) || !row.name || typeof row.team !== "string" || !Number.isInteger(row.hits) || row.hits < 0) return false;
    if (ids.has(row.kboId)) return false;
    ids.add(row.kboId);
  }
  return true;
}

export function resolveCareerLeaderboard(
  snapshot: unknown,
  currentRows: SeasonRecordRow[],
  updatedAt: string,
  intent: CareerLeaderboardIntent,
  now = new Date(),
): CareerLeaderboardAnswer | null {
  if (!validSnapshot(snapshot)) return null;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs) || now.getTime() - updatedMs > STATS_STALE_MS || updatedMs > now.getTime() + 5 * 60_000) {
    return null;
  }
  const currentById = new Map<string, SeasonRecordRow>();
  for (const row of currentRows) {
    const id = String(row.kbo_id ?? row.player_key ?? "");
    if (!id || currentById.has(id)) return null;
    currentById.set(id, row);
  }
  const ranked = snapshot.rows.map((base) => {
    const current = currentById.get(base.kboId);
    if (current && current.name !== base.name) return null;
    const delta = current == null ? 0 : Number(current[intent.metric] ?? 0);
    if (!Number.isInteger(delta) || delta < 0) return null;
    return {
      kboId: base.kboId,
      name: base.name,
      team: (current?.team as string | null | undefined) || base.team,
      total: base[intent.metric] + delta,
      baseline: base[intent.metric],
      current: delta,
    };
  });
  if (ranked.some((row) => row === null)) return null;
  const rows = ranked.filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ko"));
  const top = rows[0]?.total;
  if (top == null) return null;
  return {
    metric: intent.metric,
    label: intent.label,
    leaders: rows.filter((row) => row.total === top),
    asOf: updatedAt,
    baselineThroughSeason: snapshot.throughSeason,
    sourceUrl: snapshot.source.url,
  };
}

export function composeCareerLeaderboardAnswer(result: CareerLeaderboardAnswer): string {
  const date = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(result.asOf)).replace(/\.\s*/g, "-").replace(/-$/, "");
  const names = result.leaders.map((row) => `${row.name}(${row.team})`).join("·");
  const total = result.leaders[0].total.toLocaleString("ko-KR");
  const breakdown = result.leaders.length === 1
    ? ` (${result.baselineThroughSeason}년 말 ${result.leaders[0].baseline.toLocaleString("ko-KR")} + 2026시즌 ${result.leaders[0].current.toLocaleString("ko-KR")})`
    : "";
  return `${date} 기준 KBO 통산 ${result.label} 1위는 ${names}, ${total}${result.label}입니다.${breakdown}`;
}

export function createCareerLeaderboardFetcher(): CareerLeaderboardFetcher {
  return async (intent, now = new Date()) => {
    const current = await fetchServedBatterSnapshot();
    return resolveCareerLeaderboard(baselineJson, current.rows, current.updatedAt, intent, now);
  };
}
