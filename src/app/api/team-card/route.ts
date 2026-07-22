import { NextRequest, NextResponse } from "next/server";
import { fetchStandings, teamCardRank, fetchGames } from "@/lib/crawler/kbo-api";
import { getMonthGames } from "@/lib/crawler/season-games-cache";
import { appendLiveRankIfStale } from "@/lib/analysis/rank-history-selfheal";
import { fetchAllRows } from "@/lib/db/paginate";
import { weeklyBattingRankMap, weeklyPitchingRankMap, type WeekGameLogRow } from "@/lib/analysis/weekly-team-rank";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";

// GET /api/team-card?team=<slug>
// 홈 팀 카드용 데이터 조립: 순위/게임차 + 연승연패 + 최근 5경기 폼 + 다음 경기(예고선발)
// + 시즌 순위 변동(daily_standings_snapshot). 기존 lib 재사용, 신규 크롤 없음.

type FormResult = "W" | "L" | "D";

// YYYY-MM-DD에 days를 더한 YYYY-MM-DD (주간 범위 간유용)
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    // 순위는 teamCardRank→buildRankMap(네이버 원본 ranking 우선 + competition fallback, 공동순위 보존) SSOT를 사용.
    // winRate-sort idx+1은 공동순위를 깨므로 standing.rank·self-heal liveRank 둘 다 동일 값을 쓴다(삼순 #729).
    const teamRankValue = teamCardRank(standings, team.id);
    const ranked = [...standings].sort((a, b) => b.winRate - a.winRate);
    const idx = ranked.findIndex((s) => s.teamId === team.id);
    const me = idx >= 0 ? ranked[idx] : null;

    const standing = me
      ? {
          rank: teamRankValue ?? idx + 1,
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

    // 4b) 자가복구 — 새벽 스냅샷 크론(daily-analysis)이 하루 스킵되면(Vercel best-effort,
    //     2026-06-19·2026-07-20 실사례) 그래프가 마지막 스냅샷에서 멈춰 실제 순위 하락을
    //     못 보여준다. 최신 스냅샷이 오늘(KST)보다 과거면 라이브 순위(현재 카드 헤더와 동일)로
    //     '오늘' 포인트를 덧붙인다. 저장 스냅샷은 변경하지 않음.
    const todayKstIso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    rankHistory = appendLiveRankIfStale(rankHistory, todayKstIso, standing?.rank ?? null);

    // 5) 순위권 선수는 TeamCard 클라이언트가 /api/stats + rankByStat(공식 랭킹 소스)로
    //    계산한다(리더보드와 100% 동일). daily_stats_snapshot은 부문이 9개뿐이라 미사용.

    // 6) 주간 팀 타율/방어율 추이 — player_game_logs 주(월요일 기준) 단위 합산
    let weeklyBatting: { week: string; avg: number }[] = [];
    let weeklyPitching: { week: string; era: number }[] = [];
    // ① 괄호 순위 = 그래프와 같은 최신 주차·같은 10구단 주간 competition ranking(시즌 누적 순위 아님).
    let weeklyBattingRank: number | null = null;
    let weeklyPitchingRank: number | null = null;
    try {
      // Supabase 기본 max-rows(1000) 상한을 넘는 시즌 전체 로그를 range 페이지네이션으로 전량 수집.
      // (limit 없이 오름차순이면 오래된 1000행만 반환돼 최근 주차가 잘림 — 그래프 정지 버그.)
      // game_date만 정렬하면 동률 행이 1000 경계에서 중복/누락 가능 → id 2차 키로 유일 전체순서 보장.
      const data = await fetchAllRows<{ id: number; game_date: string; ab: number; h: number; ip_outs: number; er: number }>(
        async (from, to) => {
          const { data: page, error } = await supabaseAdmin
            .from("player_game_logs")
            .select("id, game_date, ab, h, ip_outs, er")
            .eq("team_id", team.id)
            .order("game_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          if (error) throw error;
          return page ?? [];
        },
      );
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

      // ① 최신 주차 10구단 competition ranking — 그래프 마지막 점과 동일 주차로 괄호 순위 산출.
      const bw = weeklyBatting.length ? weeklyBatting[weeklyBatting.length - 1].week : null;
      const pw = weeklyPitching.length ? weeklyPitching[weeklyPitching.length - 1].week : null;
      if (bw || pw) {
        const needed = [bw, pw].filter((w): w is string => !!w);
        const spanStart = needed.reduce((a, b) => (a < b ? a : b));
        const spanEnd = addDaysIso(needed.reduce((a, b) => (a > b ? a : b)), 6);
        const leagueRows = await fetchAllRows<WeekGameLogRow & { game_date: string }>(
          async (from, to) => {
            const { data: page, error } = await supabaseAdmin
              .from("player_game_logs")
              .select("team_id, game_date, ab, h, ip_outs, er")
              .gte("game_date", spanStart)
              .lte("game_date", spanEnd)
              .order("game_date", { ascending: true })
              .order("id", { ascending: true })
              .range(from, to);
            if (error) throw error;
            return page ?? [];
          },
        );
        if (bw) {
          const wkRows = leagueRows.filter((r) => mondayOf(String(r.game_date)) === bw);
          weeklyBattingRank = weeklyBattingRankMap(wkRows).get(team.id) ?? null;
        }
        if (pw) {
          const wkRows = leagueRows.filter((r) => mondayOf(String(r.game_date)) === pw);
          weeklyPitchingRank = weeklyPitchingRankMap(wkRows).get(team.id) ?? null;
        }
      }
    } catch {
      // 주간 스탯 실패해도 나머지 정상 반환
    }

    // 7) 커뮤니티 새글 수 — 해당 팀 게시판(board_type='team', board_id=슬러그) 최근 7일 (숨김 제외)
    let communityNewPosts = 0;
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabaseAdmin
        .from("posts")
        .select("id", { count: "exact", head: true })
        .eq("board_type", "team")
        .eq("board_id", team.slug)
        .eq("is_hidden", false)
        .gte("created_at", since);
      communityNewPosts = count ?? 0;
    } catch {
      // 카운트 실패해도 나머지 정상 반환
    }

    return NextResponse.json(
      { team: team.slug, standing, recentForm, nextGame, rankHistory, weeklyBatting, weeklyPitching, weeklyBattingRank, weeklyPitchingRank, communityNewPosts },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
