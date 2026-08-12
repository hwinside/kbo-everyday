import baselineJson from "../../../../data/baseball-qa/kbo-career-hitter-through-2025.json";
import {
  fetchServedBatterSnapshot,
  SERVED_BATTER_FULL_ENTRY_IDS,
} from "./served-record";
import { STATS_STALE_MS, type SeasonRecordRow } from "./season-record";
import { canonicalKboId } from "@/lib/utils/resolve-player";

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

/** 라우터와 intent resolver가 공유하는 유일한 시점어 SSOT. */
export const CAREER_LEADERBOARD_TEMPORAL_WORDS = [
  "통산", "역대", "커리어", "누적", "올타임",
] as const;

function compactCareerQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[?!？！.,。]+$/g, "")
    .replace(/\s+/g, "");
}

/** 첫 수직 슬라이스: 질문 **전체를 consume하는 안타+단일 1위 positive grammar**만 지원한다.
 *
 * 부분문자열 매칭은 `안타 1위는 누구고 2위는?`의 앞 절만 먹거나, `홈런 1위는? 안타도`
 * 에서 다른 절의 안타를 지표로 오결속한다(삼순 4차 NO-GO). 끝 문장부호만 제거한 전체 문자열이
 * 아래 두 폐쇄 문법 중 하나와 완전히 일치할 때만 지원한다. */
export function resolveCareerLeaderboardIntent(question: string): CareerLeaderboardIntent | null {
  const normalized = compactCareerQuestion(question);
  const temporal = `(?:${CAREER_LEADERBOARD_TEMPORAL_WORDS.join("|")})`;
  const who = "(?:누구(?:야|인가|인가요|예요)?|누가|누군(?:데|가요)?|알려(?:줘|주세요)?)";
  const explicitFirst = new RegExp(`^${temporal}안타(?:기록)?1위(?:는|가|를)?${who}$`);
  const singularLeader = new RegExp(
    `^${temporal}(?:최다안타|안타최다|안타선두)(?:기록)?(?:는|가|를)?` +
    `(?:${who}|누가(?:갖고있어|보유하고있어))$`,
  );
  if (!explicitFirst.test(normalized) && !singularLeader.test(normalized)) return null;
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
  // 빈/부분 2026 스냅샷 fail-close — 행수 하한은 리더를 뺀 임의 N행도 통과한다.
  // 실제 full=1 merge 입력인 static ID 전집합을 모두 포함해야 현재 스냅샷으로 인정한다.
  const currentById = new Map<string, SeasonRecordRow>();
  for (const row of currentRows) {
    const id = String(row.kbo_id ?? row.player_key ?? "");
    if (!id || currentById.has(id)) return null;
    // 서빙 컬럼 원타입 계약: 문자열 "109" 는 Number() 로 통과하지만 스키마 변형의 증거다.
    const raw = row[intent.metric];
    if (raw === undefined || raw === null || typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return null;
    }
    currentById.set(id, row);
  }
  if (!SERVED_BATTER_FULL_ENTRY_IDS.every((id) => currentById.has(id))) return null;
  const ranked = snapshot.rows.map((base) => {
    const canonicalId = canonicalKboId(base.kboId);
    const current = currentById.get(canonicalId);
    if (current && current.name !== base.name) return null;
    // delta 는 위 루프에서 원타입 검증을 통과한 값만 온다 — 이중 가드를 두면
    // mutation 이 서로를 가려 검출력이 0이 된다(단일 권위 가드 원칙).
    const delta = current == null ? 0 : (current[intent.metric] as number);
    return {
      kboId: canonicalId,
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
  return `${date} 기준 KBO 통산 ${result.label} 1위는 ${names}, ${total}${result.label}입니다.${breakdown}\n📄 출처: KBO 공식 기록실(${result.baselineThroughSeason}년 말 통산) + 크보팬 2026 시즌 기록`;
}

export function createCareerLeaderboardFetcher(): CareerLeaderboardFetcher {
  return async (intent, now = new Date()) => {
    const current = await fetchServedBatterSnapshot();
    return resolveCareerLeaderboard(baselineJson, current.rows, current.updatedAt, intent, now);
  };
}
