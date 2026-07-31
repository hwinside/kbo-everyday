import { canonicalKboId } from "@/lib/utils/resolve-player";

const NAVER_STATS_BASE =
  "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";

export interface NaverPlayerStat {
  rank: number;
  name: string;
  team: string;
  [key: string]: string | number;
}

interface NaverPlayerRow {
  ranking?: unknown;
  playerId?: unknown;
  playerName?: unknown;
  teamId?: unknown;
  teamName?: unknown;
  hitterHra?: unknown;
  hitterRbi?: unknown;
  hitterRun?: unknown;
  hitterHr?: unknown;
  hitterHit?: unknown;
  hitterH2?: unknown;
  hitterH3?: unknown;
  hitterGameCount?: unknown;
  hitterAb?: unknown;
  hitterSb?: unknown;
  hitterBb?: unknown;
  hitterHp?: unknown;
  hitterKk?: unknown;
  hitterObp?: unknown;
  hitterSlg?: unknown;
  hitterOps?: unknown;
  pitcherEra?: unknown;
  pitcherWin?: unknown;
  pitcherLose?: unknown;
  pitcherSave?: unknown;
  pitcherHold?: unknown;
  pitcherGameCount?: unknown;
  pitcherInning?: unknown;
  pitcherKk?: unknown;
  pitcherHit?: unknown;
  pitcherHr?: unknown;
  pitcherR?: unknown;
  pitcherEr?: unknown;
  pitcherBb?: unknown;
  pitcherHp?: unknown;
  pitcherWra?: unknown;
  pitcherWhip?: unknown;
  isQualified?: unknown;
}

interface NaverPlayersPayload {
  success?: unknown;
  code?: unknown;
  result?: {
    seasonPlayerStats?: unknown;
  };
}

const TEAM_NAMES_BY_ID = new Map([
  ["HH", "한화"],
  ["HT", "KIA"],
  ["KT", "KT"],
  ["LG", "LG"],
  ["LT", "롯데"],
  ["NC", "NC"],
  ["OB", "두산"],
  ["SK", "SSG"],
  ["SS", "삼성"],
  ["WO", "키움"],
]);
const NAVER_TEAM_MINIMUM = { batter: 20, pitcher: 15 } as const;
const PITCHER_INNING_RE = /^\d+(?: [12]\/3)?$/;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteNonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function nonNegative(value: unknown): number {
  return finiteNonNegative(value) ? value : 0;
}

function rate(value: unknown, digits: number): string {
  if (!finite(value)) return digits === 3 ? ".000" : "0.00";
  const formatted = value.toFixed(digits);
  return digits === 3 && value >= 0 && value < 1 ? formatted.slice(1) : formatted;
}

function staticByPlayerId(staticStats: NaverPlayerStat[]): Map<string, NaverPlayerStat> {
  return new Map(
    staticStats
      .map((row) => [String(row.playerId || row.kboId || ""), row] as const)
      .filter(([id]) => id.length > 0),
  );
}

function validateCommon(row: NaverPlayerRow): row is NaverPlayerRow & {
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
} {
  return (
    typeof row.playerId === "string" &&
    /^\d+$/.test(row.playerId) &&
    typeof row.playerName === "string" &&
    row.playerName.trim().length > 0 &&
    typeof row.teamId === "string" &&
    TEAM_NAMES_BY_ID.get(row.teamId) === row.teamName &&
    typeof row.teamName === "string" &&
    row.teamName.trim().length > 0
  );
}

export function parseNaverPlayerStats(
  payload: unknown,
  type: "batter" | "pitcher",
  staticStats: NaverPlayerStat[] = [],
): NaverPlayerStat[] {
  const body = payload as NaverPlayersPayload;
  const raw = body?.result?.seasonPlayerStats;
  if (body?.success !== true || body?.code !== 200 || !Array.isArray(raw)) {
    throw new Error("Naver player stats response contract invalid");
  }

  const fallback = staticByPlayerId(staticStats);
  const seen = new Set<string>();
  const stats: NaverPlayerStat[] = [];

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Naver player stats row invalid");
    }
    const row = candidate as NaverPlayerRow;
    if (!validateCommon(row)) {
      throw new Error("Naver player stats player/team coverage invalid");
    }
    const canonicalId = canonicalKboId(row.playerId);
    if (seen.has(canonicalId)) {
      throw new Error("Naver player stats player/team coverage invalid");
    }
    seen.add(canonicalId);
    const previous = fallback.get(canonicalId) ?? fallback.get(row.playerId);

    if (type === "batter") {
      const required = [
        row.hitterHra,
        row.hitterRbi,
        row.hitterRun,
        row.hitterHr,
        row.hitterHit,
        row.hitterH2,
        row.hitterH3,
        row.hitterGameCount,
        row.hitterAb,
        row.hitterSb,
        row.hitterBb,
        row.hitterHp,
        row.hitterKk,
        row.hitterObp,
        row.hitterSlg,
        row.hitterOps,
      ];
      if (!required.every(finiteNonNegative)) {
        throw new Error("Naver batter stats required field missing");
      }
      const hits = nonNegative(row.hitterHit);
      const doubles = nonNegative(row.hitterH2);
      const triples = nonNegative(row.hitterH3);
      const homeRuns = nonNegative(row.hitterHr);
      const totalBases = hits + doubles + 2 * triples + 3 * homeRuns;
      const ab = nonNegative(row.hitterAb);
      const bb = nonNegative(row.hitterBb);
      const hbp = nonNegative(row.hitterHp);
      const sac = Number(previous?.sac) || 0;
      const sf = Number(previous?.sf) || 0;
      stats.push({
        rank: finite(row.ranking) ? row.ranking : stats.length + 1,
        name: row.playerName,
        team: row.teamName,
        avg: rate(row.hitterHra, 3),
        games: nonNegative(row.hitterGameCount),
        pa: ab + bb + hbp + sac + sf,
        ab,
        runs: nonNegative(row.hitterRun),
        hits,
        doubles,
        triples,
        hr: homeRuns,
        tb: totalBases,
        rbi: nonNegative(row.hitterRbi),
        sac,
        sf,
        bb,
        ibb: Number(previous?.ibb) || 0,
        hbp,
        so: nonNegative(row.hitterKk),
        gdp: Number(previous?.gdp) || 0,
        slg: rate(row.hitterSlg, 3),
        obp: rate(row.hitterObp, 3),
        ops: rate(row.hitterOps, 3),
        sb: nonNegative(row.hitterSb),
        cs: Number(previous?.cs) || 0,
        kboId: canonicalId,
        playerId: canonicalId,
        qualifiedRate: row.isQualified === true ? 1 : 0,
      });
    } else {
      const required = [
        row.pitcherEra,
        row.pitcherWin,
        row.pitcherLose,
        row.pitcherSave,
        row.pitcherHold,
        row.pitcherGameCount,
        row.pitcherKk,
        row.pitcherHit,
        row.pitcherHr,
        row.pitcherR,
        row.pitcherEr,
        row.pitcherBb,
        row.pitcherHp,
        row.pitcherWra,
        row.pitcherWhip,
      ];
      if (
        !required.every(finiteNonNegative) ||
        typeof row.pitcherInning !== "string" ||
        !PITCHER_INNING_RE.test(row.pitcherInning.trim())
      ) {
        throw new Error("Naver pitcher stats required field missing");
      }
      stats.push({
        rank: finite(row.ranking) ? row.ranking : stats.length + 1,
        name: row.playerName,
        team: row.teamName,
        era: rate(row.pitcherEra, 2),
        games: nonNegative(row.pitcherGameCount),
        wins: nonNegative(row.pitcherWin),
        losses: nonNegative(row.pitcherLose),
        saves: nonNegative(row.pitcherSave),
        holds: nonNegative(row.pitcherHold),
        wpct: rate(row.pitcherWra, 3),
        ip: row.pitcherInning,
        h: nonNegative(row.pitcherHit),
        hr: nonNegative(row.pitcherHr),
        bb: nonNegative(row.pitcherBb),
        hbp: nonNegative(row.pitcherHp),
        so: nonNegative(row.pitcherKk),
        r: nonNegative(row.pitcherR),
        er: nonNegative(row.pitcherEr),
        whip: rate(row.pitcherWhip, 2),
        kboId: canonicalId,
        playerId: canonicalId,
        qualifiedRate: row.isQualified === true ? 1 : 0,
      });
    }
  }

  const teamCounts = new Map<string, number>();
  for (const row of raw as NaverPlayerRow[]) {
    if (typeof row.teamId === "string") {
      teamCounts.set(row.teamId, (teamCounts.get(row.teamId) || 0) + 1);
    }
  }
  const minimum = type === "batter" ? 250 : 200;
  const perTeamMinimum = NAVER_TEAM_MINIMUM[type];
  const allTeamsCovered = [...TEAM_NAMES_BY_ID.keys()].every(
    (teamId) => (teamCounts.get(teamId) || 0) >= perTeamMinimum,
  );
  if (
    stats.length < minimum ||
    teamCounts.size !== TEAM_NAMES_BY_ID.size ||
    !allTeamsCovered
  ) {
    throw new Error(
      `Naver ${type} stats partial: rows=${stats.length}, teams=${teamCounts.size}, ` +
        `minTeam=${Math.min(...teamCounts.values())}`,
    );
  }
  return stats;
}

export async function fetchNaverPlayerStats(
  type: "batter" | "pitcher",
  season: number,
  deadlineAt: number,
  staticStats: NaverPlayerStat[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<NaverPlayerStat[]> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("Naver player stats deadline exceeded");
  const playerType = type === "batter" ? "HITTER" : "PITCHER";
  const sortField = type === "batter" ? "offenseGameCount" : "pitcherGameCount";
  const url =
    `${NAVER_STATS_BASE}/${season}/players?` +
    new URLSearchParams({
      sortField,
      sortDirection: "desc",
      page: "1",
      pageSize: "500",
      playerType,
    }).toString();
  const signal = AbortSignal.timeout(remaining);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://m.sports.naver.com/",
      "User-Agent": "Mozilla/5.0",
    },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`Naver player stats HTTP ${response.status}`);
  const payload = await new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    response.json().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
  return parseNaverPlayerStats(payload, type, staticStats);
}
