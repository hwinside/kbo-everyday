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

function isTeamBatting(value: unknown): value is TeamBatting {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    isFiniteNumber(row.teamId) &&
    typeof row.slug === "string" &&
    typeof row.avg === "string" &&
    typeof row.ops === "string" &&
    isFiniteNumber(row.hr) &&
    isFiniteNumber(row.runs) &&
    isFiniteNumber(row.sb)
  );
}

function isTeamPitching(value: unknown): value is TeamPitching {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    isFiniteNumber(row.teamId) &&
    typeof row.slug === "string" &&
    typeof row.era === "string" &&
    typeof row.whip === "string" &&
    isFiniteNumber(row.so) &&
    isFiniteNumber(row.sv) &&
    isFiniteNumber(row.hra)
  );
}

export function isRecordsData(value: unknown): value is RecordsData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    isFiniteNumber(data.season) &&
    Array.isArray(data.batting) &&
    data.batting.length === 10 &&
    data.batting.every(isTeamBatting) &&
    new Set(data.batting.map((row) => row.slug)).size === 10 &&
    Array.isArray(data.pitching) &&
    data.pitching.length === 10 &&
    data.pitching.every(isTeamPitching) &&
    new Set(data.pitching.map((row) => row.slug)).size === 10
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
