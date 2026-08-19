import { NextRequest, NextResponse, after } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import rosterData from "@/lib/constants/players-roster.json";
import {
  toWeeklyTrend,
  recentAverage,
  recentEraByInnings,
  outsToInnings,
  weeklyDirection,
  type WeeklyTrendRow,
} from "@/lib/stats/weekly-trend";
import { getPlayerTitles } from "@/lib/stats/title-rankings";
import { getTeamById } from "@/lib/constants/teams";
import {
  getPlayerGameLogsRouteResult,
} from "@/lib/services/player-game-logs";
import {
  getPlayerStatsRouteResult,
} from "@/lib/services/player-stats";
import {
  getPlayerTodayGameRouteResult,
  type PlayerTodayGameResponse,
} from "@/lib/services/player-today-game";
import { getStatsRouteResult } from "@/lib/services/stats";

export const dynamic = "force-dynamic";

/**
 * 최애선수 카드 위젯용 단일 조합 API.
 * 홈 최애선수 카드(FavoritePlayersSection)가 클라이언트에서 조합하는
 * player-stats + player-game-logs + 리그 랭킹(titles) + player-today-game을
 * 위젯이 한 번에 받도록 서버에서 조합·포맷한다.
 * 문자열 포맷(헤드라인/시즌 라인/칩)은 앱 카드와 동일 규칙 — 위젯 네이티브는 그리기만 한다.
 *
 * GET /api/widget/player-card?id=<kboId>
 */

interface RosterEntry {
  name: string;
  kboId: string;
  backNo: string;
  position: string;
  teamId: number;
  team: string;
}

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);
const ROSTER = new Map((rosterData as RosterEntry[]).map((r) => [r.kboId, r]));

type StatLike = Record<string, string | number | undefined>;

function fmtAvg(n: number): string {
  return n.toFixed(3).replace(/^0\./, ".");
}

// 최근 경기 채움 줄 — 오늘 경기 활약이 없는 날 카드 중앙 공백 대신 표시(위젯 네이티브는 그리기만)
interface GameLogRow extends WeeklyTrendRow {
  opponent_team_id?: number;
  k?: number;
  hr?: number;
  rbi?: number;
}

function recentGameLines(rows: GameLogRow[], isPitcher: boolean) {
  return rows
    .filter((r) => (isPitcher ? r.ip_outs > 0 : r.ab > 0)) // 대주자/볼넷만 경기 등 "0타수" 줄 제외
    .slice(-3)
    .reverse()
    .map((r) => {
      const [, m, d] = r.game_date.split("-").map(Number);
      const opp = r.opponent_team_id ? getTeamById(r.opponent_team_id)?.shortName : null;
      let line: string;
      if (isPitcher) {
        line = `${outsToInnings(r.ip_outs)}이닝${r.k ? ` ${r.k}K` : ""} ${r.er}자책`;
      } else {
        line = `${r.ab}타수 ${r.h}안타`;
        if (r.hr) line += ` ${r.hr}홈런`;
        else if (r.rbi) line += ` ${r.rbi}타점`;
      }
      return { date: `${m}/${d}`, opponent: opp ? `vs ${opp}` : "", line };
    });
}

// 앱 카드와 동일한 오늘 경기 강조칩 규칙 (FavoritePlayersSection batterTodayChips/pitcherTodayChips)
function todayChips(today: PlayerTodayGameResponse): string[] {
  if (today.type === "batter" && today.batter) {
    const b = today.batter;
    const out: string[] = [];
    if (b.hr > 0) out.push(`${b.hr}홈런`);
    if (b.rbi > 0) out.push(`${b.rbi}타점`);
    if (b.onBase > 0) out.push(`${b.onBase}출루`);
    if (b.sb > 0) out.push(`${b.sb}도루`);
    if (b.runs > 0) out.push(`${b.runs}득점`);
    return out.slice(0, 4);
  }
  if (today.type === "pitcher" && today.pitcher) {
    const p = today.pitcher;
    return [`${p.k}K`, `${p.bb}볼넷`, `${p.hits}피안타`, `${p.runs}실점`];
  }
  return [];
}

function scheduleDeferred(effect: () => Promise<void>): void {
  try {
    after(() => effect());
  } catch {
    void effect().catch(() => undefined);
  }
}

export async function GET(req: NextRequest) {
  const rawId = req.nextUrl.searchParams.get("id");
  if (!rawId) return NextResponse.json({ error: "id required" }, { status: 400 });

  const resolved = resolvePlayer(rawId);
  const kboId = resolved?.kboId ?? rawId;
  const roster = ROSTER.get(kboId);
  if (!roster) return NextResponse.json({ error: "unknown player" }, { status: 404 });

  const isPitcher = roster.position === "투수";
  const pos = isPitcher ? "투수" : "타자";
  const deferredEffects: Array<() => Promise<void>> = [];

  const [stats, logsRes, league, today] = await Promise.all([
    (async () => {
      try {
        const result = await getPlayerStatsRouteResult(kboId, pos);
        return result.status && result.status >= 400 ? null : (result.body.stats as StatLike | null);
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        const result = await getPlayerGameLogsRouteResult(kboId, pos);
        return Array.isArray(result.body.rows) ? (result.body.rows as GameLogRow[]) : [];
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const result = await getStatsRouteResult({ type: isPitcher ? "pitcher" : "batter", season: "2026" });
        const json = result.body as { stats?: StatLike[] };
        return Array.isArray(json.stats) ? json.stats : [];
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const result = await getPlayerTodayGameRouteResult({
          teamId: roster.teamId,
          name: roster.name,
          pos,
          onDeferredEffect: (effect) => {
            deferredEffects.push(effect);
          },
        });
        return result.body as PlayerTodayGameResponse;
      } catch {
        return null;
      }
    })(),
  ]);

  // 헤드라인: 타자=최근 3경기 타율 / 투수=최근 9이닝(이상) ERA → 없으면 시즌 누적 폴백 (앱 카드 동일)
  const pitcherEra = isPitcher ? recentEraByInnings(logsRes, 27) : null;
  const recentMetric = isPitcher ? (pitcherEra?.era ?? null) : recentAverage(logsRes, false, 3);
  const weeklySeries = toWeeklyTrend(logsRes, isPitcher);
  const direction = weeklyDirection(weeklySeries, isPitcher);
  const weekly = weeklySeries.map((w) =>
    isPitcher ? (w as { era: number }).era : (w as { avg: number }).avg,
  );

  const seasonAvg = !isPitcher && stats ? Number(stats.avg ?? NaN) : NaN;
  const seasonEra = isPitcher && stats ? Number(stats.era ?? NaN) : NaN;
  const seasonMain = isPitcher
    ? Number.isFinite(seasonEra) ? seasonEra.toFixed(2) : null
    : Number.isFinite(seasonAvg) ? fmtAvg(seasonAvg) : null;
  const seasonSub = stats
    ? isPitcher
      ? `${Number(stats.wins ?? 0)}승 ${Number(stats.losses ?? 0)}패 ${Number(stats.saves ?? 0)}세`
      : `${Number(stats.hr ?? 0)}홈런 ${Number(stats.rbi ?? 0)}타점`
    : null;

  const recentText =
    recentMetric != null ? (isPitcher ? recentMetric.toFixed(2) : fmtAvg(recentMetric)) : null;
  const headlineValue = recentText ?? seasonMain;
  const headlineLabel = recentText
    ? isPitcher
      ? `최근 ${pitcherEra ? outsToInnings(pitcherEra.outs) : 9}이닝 ERA`
      : "최근 3경기 타율"
    : isPitcher
      ? "시즌 ERA"
      : "시즌 타율";

  const titles = getPlayerTitles(league, kboId, roster.name, isPitcher).map(
    (t) => `${t.name} ${t.rank}위`,
  );

  const backNo = roster.backNo ? Number(roster.backNo) : null;
  for (const effect of deferredEffects) {
    scheduleDeferred(() => effect());
  }

  return NextResponse.json(
    {
      player: {
        kboId,
        name: roster.name,
        teamId: roster.teamId,
        number: backNo,
        position: roster.position,
        isPitcher,
        heroUrl: HERO_APPROVED.has(kboId) ? `/players-hero/${kboId}.webp` : null,
        photoUrl: getPlayerPhotoUrl(roster.name, kboId, roster.teamId),
      },
      headline: headlineValue ? { label: headlineLabel, value: headlineValue, direction } : null,
      weekly,
      seasonLine: seasonMain ? `시즌 ${seasonMain}${seasonSub ? ` · ${seasonSub}` : ""}` : null,
      titles,
      recentGames: recentGameLines(logsRes, isPitcher),
      today:
        today && today.show
          ? {
              show: true,
              isLive: today.isLive,
              opponentName: today.opponentName,
              line:
                today.type === "batter" && today.batter
                  ? `${today.batter.ab}타수 ${today.batter.h}안타`
                  : today.pitcher
                    ? `${today.pitcher.ip}이닝${today.pitcher.pitches > 0 ? ` · ${today.pitcher.pitches}구` : ""}`
                    : "",
              decision: today.type === "pitcher" ? (today.pitcher?.decision ?? "") : "",
              chips: todayChips(today),
            }
          : { show: false },
    },
    { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=120" } },
  );
}
