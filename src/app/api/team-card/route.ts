import { NextRequest, NextResponse } from "next/server";
import { fetchStandings, fetchGames } from "@/lib/crawler/kbo-api";
import { getMonthGames } from "@/lib/crawler/season-games-cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";

// GET /api/team-card?team=<slug>
// 홈 팀 카드용 데이터 조립: 순위/게임차 + 연승연패 + 최근 5경기 폼 + 다음 경기(예고선발)
// + 시즌 순위 변동(daily_standings_snapshot). 기존 lib 재사용, 신규 크롤 없음.

type FormResult = "W" | "L" | "D";

// YYYY-MM-DD → 그 주 월요일 YYYY-MM-DD (주간 버킷 키)
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function kstDateStr(offsetDays: number): string {
  const base = new Date(Date.now() + 9 * 60 * 60 * 1000);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10).replace(/-/g, "");
}

// 이웃 팀과의 게임차 = KBO 공식 게임차(1위 대비)의 차이. 순위(승률 기준)와
// raw 승차가 어긋나는 엣지케이스에서도 KBO 표기와 일치하게 절대값으로.
function gapBetween(a: { gamesBehind: number }, b: { gamesBehind: number }): number {
  return Math.abs(a.gamesBehind - b.gamesBehind);
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("team");
  const team = TEAMS.find((t) => t.slug === slug);
  if (!team) {
    return NextResponse.json({ error: "Unknown team slug" }, { status: 400 });
  }

  try {
    // 1) 순위 + 게임차 + 연승연패
    const standings = await fetchStandings();
    const ranked = [...standings].sort((a, b) => b.winRate - a.winRate);
    const idx = ranked.findIndex((s) => s.teamId === team.id);
    const me = idx >= 0 ? ranked[idx] : null;

    const standing = me
      ? {
          rank: idx + 1,
          gamesBehind: me.gamesBehind, // 1위 대비
          streak: me.continuousGameResult ?? null,
          above:
            idx > 0
              ? { teamId: ranked[idx - 1].teamId, gap: gapBetween(ranked[idx - 1], me) }
              : null,
          below:
            idx < ranked.length - 1
              ? { teamId: ranked[idx + 1].teamId, gap: gapBetween(me, ranked[idx + 1]) }
              : null,
        }
      : null;

    // 2) 최근 5경기 폼 — 이번 달(부족하면 지난 달까지) 종료 경기에서 산출
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const thisMonth = now.toISOString().slice(0, 7);
    const prev = new Date(now);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const prevMonth = prev.toISOString().slice(0, 7);

    let monthGames = await getMonthGames(thisMonth).catch(() => []);
    let teamFinals = monthGames.filter(
      (g) => (g.awayTeamId === team.id || g.homeTeamId === team.id) && g.status === "final",
    );
    if (teamFinals.length < 5) {
      const prevGames = await getMonthGames(prevMonth).catch(() => []);
      monthGames = [...prevGames, ...monthGames];
      teamFinals = monthGames.filter(
        (g) => (g.awayTeamId === team.id || g.homeTeamId === team.id) && g.status === "final",
      );
    }
    teamFinals.sort((a, b) => a.date.localeCompare(b.date));
    const recentForm: FormResult[] = teamFinals
      .slice(-5)
      .map((g) => {
        const isHome = g.homeTeamId === team.id;
        const my = isHome ? g.homeScore : g.awayScore;
        const opp = isHome ? g.awayScore : g.homeScore;
        if (my == null || opp == null) return null;
        return my > opp ? "W" : my < opp ? "L" : "D";
      })
      .filter((r): r is FormResult => r !== null);

    // 3) 다음 경기 + 예고선발 (라이브 fetchGames로 최신 예고선발 확보)
    let nextGame: {
      gameId: string;
      date: string;
      time: string;
      stadium: string;
      home: boolean;
      opponentId: number;
      myStarter: string | null;
      oppStarter: string | null;
    } | null = null;
    for (let i = 0; i < 10 && !nextGame; i++) {
      const date = kstDateStr(i);
      const games = await fetchGames(date).catch(() => []);
      const g = games.find(
        (x) =>
          (x.awayTeamId === team.id || x.homeTeamId === team.id) && x.status === "scheduled",
      );
      if (g) {
        const isHome = g.homeTeamId === team.id;
        nextGame = {
          gameId: g.gameId,
          date: g.date,
          time: g.time,
          stadium: g.stadium,
          home: isHome,
          opponentId: isHome ? g.awayTeamId : g.homeTeamId,
          myStarter: (isHome ? g.homeStarterName : g.awayStarterName) || null,
          oppStarter: (isHome ? g.awayStarterName : g.homeStarterName) || null,
        };
      }
    }

    // 4) 시즌 순위 변동 — daily_standings_snapshot에서 팀 rank 시계열(public read)
    let rankHistory: { date: string; rank: number }[] = [];
    try {
      const { data } = await supabaseAdmin
        .from("daily_standings_snapshot")
        .select("date, rank")
        .eq("team_id", team.id)
        .order("date", { ascending: true });
      if (Array.isArray(data)) {
        rankHistory = data.map((r) => ({ date: String(r.date), rank: Number(r.rank) }));
      }
    } catch {
      // 스냅샷 조회 실패해도 카드의 나머지는 정상 반환
    }

    // 5) 순위권 선수 — daily_stats_snapshot 최신일, 팀 소속 부문 rank<=5
    let topPlayers: { category: string; rank: number; playerName: string; value: number }[] = [];
    try {
      const { data: latest } = await supabaseAdmin
        .from("daily_stats_snapshot").select("date").order("date", { ascending: false }).limit(1);
      const latestDate = latest?.[0]?.date;
      if (latestDate) {
        const { data } = await supabaseAdmin
          .from("daily_stats_snapshot")
          .select("category, rank, player_name, value")
          .eq("date", latestDate)
          .eq("team", team.shortName)
          .lte("rank", 5)
          .order("rank", { ascending: true });
        if (Array.isArray(data)) {
          topPlayers = data.map((r) => ({
            category: String(r.category),
            rank: Number(r.rank),
            playerName: String(r.player_name),
            value: Number(r.value),
          }));
        }
      }
    } catch {
      // 순위권 조회 실패해도 나머지 정상 반환
    }

    // 6) 주간 팀 타율/방어율 추이 — player_game_logs 주(월요일 기준) 단위 합산
    let weeklyBatting: { week: string; avg: number }[] = [];
    let weeklyPitching: { week: string; era: number }[] = [];
    try {
      const { data } = await supabaseAdmin
        .from("player_game_logs")
        .select("game_date, ab, h, ip_outs, er")
        .eq("team_id", team.id)
        .order("game_date", { ascending: true });
      if (Array.isArray(data)) {
        const wk = new Map<string, { ab: number; h: number; outs: number; er: number }>();
        for (const r of data) {
          const key = mondayOf(String(r.game_date));
          const e = wk.get(key) ?? { ab: 0, h: 0, outs: 0, er: 0 };
          e.ab += Number(r.ab) || 0;
          e.h += Number(r.h) || 0;
          e.outs += Number(r.ip_outs) || 0;
          e.er += Number(r.er) || 0;
          wk.set(key, e);
        }
        const weeks = [...wk.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        weeklyBatting = weeks.filter(([, e]) => e.ab > 0).map(([week, e]) => ({ week, avg: Number((e.h / e.ab).toFixed(3)) }));
        weeklyPitching = weeks.filter(([, e]) => e.outs > 0).map(([week, e]) => ({ week, era: Number(((e.er * 27) / e.outs).toFixed(2)) }));
      }
    } catch {
      // 주간 스탯 실패해도 나머지 정상 반환
    }

    return NextResponse.json(
      { team: team.slug, standing, recentForm, nextGame, rankHistory, topPlayers, weeklyBatting, weeklyPitching },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
