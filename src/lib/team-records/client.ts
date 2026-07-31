import { TEAMS } from "@/lib/constants/teams";

export interface TeamBatting {
  teamId: number;
  slug: string;
  avg: string;
  ops: string;
  hr: number;
  runs: number;
  sb: number;
}

export interface TeamPitching {
  teamId: number;
  slug: string;
  era: string;
  whip: string;
  so: number;
  sv: number;
  hra: number;
}

export interface RecordsData {
  season: number;
  batting: TeamBatting[];
  pitching: TeamPitching[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 비율 지표(avg/ops/era/whip)는 문자열이되 유한 수치여야 한다. */
function isFiniteNumericString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  );
}

/** 정규 10구단 teamId↔slug 정본. 임의 slug/teamId 조합을 차단한다. */
const KBO_TEAM_SLUG_BY_ID = new Map(TEAMS.map((team) => [team.id, team.slug]));

function hasCanonicalTeamIdentity(row: { teamId: number; slug: string }): boolean {
  return KBO_TEAM_SLUG_BY_ID.get(row.teamId) === row.slug;
}

/** 정확히 10구단 전체가 1회씩 등장하는지 확인. */
function coversAllKboTeams(rows: Array<{ teamId: number }>): boolean {
  const ids = new Set(rows.map((row) => row.teamId));
  return ids.size === KBO_TEAM_SLUG_BY_ID.size && rows.length === KBO_TEAM_SLUG_BY_ID.size;
}

function isTeamBatting(value: unknown): value is TeamBatting {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    isFiniteNumber(row.teamId) &&
    typeof row.slug === "string" &&
    isFiniteNumericString(row.avg) &&
    isFiniteNumericString(row.ops) &&
    isFiniteNumber(row.hr) &&
    isFiniteNumber(row.runs) &&
    isFiniteNumber(row.sb) &&
    hasCanonicalTeamIdentity({ teamId: row.teamId, slug: row.slug })
  );
}

function isTeamPitching(value: unknown): value is TeamPitching {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    isFiniteNumber(row.teamId) &&
    typeof row.slug === "string" &&
    isFiniteNumericString(row.era) &&
    isFiniteNumericString(row.whip) &&
    isFiniteNumber(row.so) &&
    isFiniteNumber(row.sv) &&
    isFiniteNumber(row.hra) &&
    hasCanonicalTeamIdentity({ teamId: row.teamId, slug: row.slug })
  );
}

export function isRecordsData(value: unknown): value is RecordsData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!isFiniteNumber(data.season)) return false;
  if (!Array.isArray(data.batting) || !Array.isArray(data.pitching)) return false;
  const batting: unknown[] = data.batting;
  const pitching: unknown[] = data.pitching;
  if (!batting.every(isTeamBatting) || !pitching.every(isTeamPitching)) return false;
  const battingRows = batting as TeamBatting[];
  const pitchingRows = pitching as TeamPitching[];
  if (!coversAllKboTeams(battingRows) || !coversAllKboTeams(pitchingRows)) return false;
  // 두 배열이 같은 10구단 집합을 담아야 한다(한쪽만 누락/치환 차단).
  return battingRows.every((row) =>
    pitchingRows.some((other) => other.teamId === row.teamId),
  );
}

export async function fetchTeamRecordsForDisplay(
  fetchImpl: typeof fetch = fetch,
): Promise<RecordsData> {
  const response = await fetchImpl("/api/team-records?season=2026");
  if (!response.ok) {
    throw new Error(`team records request failed: ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isRecordsData(payload)) {
    throw new Error("team records response contract invalid");
  }
  return payload;
}
