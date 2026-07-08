import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import type { KboRawGame } from "@/types/api";

// 어드민 — Live Activity 토큰/카드 종합 현황.
// 발급된 push-to-start 토큰 수, 떠있는 잠금화면(started_users), update 토큰 등록 수,
// 갱신 불가 카드(gap = started − tokens)를 경기별로 집계한다.
// 데이터 소스는 warmup cron이 쓰는 것과 동일한 세 테이블 + KBO 당일 경기 목록.

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function gameStatus(g: KboRawGame): "live" | "final" | "scheduled" | "cancelled" | "other" {
  if (g.CANCEL_SC_ID !== "0") return "cancelled";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  if (g.GAME_STATE_SC === "1") return "scheduled";
  return "other";
}

async function fetchTodayGames(): Promise<KboRawGame[]> {
  // 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
  const res = await fetch(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
    },
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${getKSTDateStr()}`,
    cache: "no-store",
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  return (res?.game ?? []) as KboRawGame[];
}

interface CardRow {
  game_id: string;
  user_id: string;
}

// Supabase는 요청당 기본 1000행 캡이 있어(무제한 select가 조용히 잘림 — #560 사고)
// 반드시 range 페이지네이션으로 전량을 모은다. 두 테이블 모두 종료 경기 정리 cron이
// 돌아 수천 행 이내라 10페이지(1만 행)면 충분한 상한.
async function fetchAllRows(table: string): Promise<CardRow[]> {
  const PAGE = 1000;
  const rows: CardRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from(table)
      .select("game_id, user_id")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as CardRow[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [p2sTotal, p2sFresh24h, p2sFresh7d, startedRows, tokenRows, games] = await Promise.all([
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since24h),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since7d),
      fetchAllRows("live_activity_started_users"),
      fetchAllRows("live_activity_tokens"),
      fetchTodayGames(),
    ]);

    const gameMeta = new Map<string, { label: string; status: string }>();
    for (const g of games) {
      if (!g.G_ID) continue;
      gameMeta.set(g.G_ID, {
        label: `${g.AWAY_NM ?? "?"} vs ${g.HOME_NM ?? "?"}`,
        status: gameStatus(g),
      });
    }

    // 경기별 집계: started(push-to-start로 뜬 카드) / tokens(update 토큰) /
    // updatable(둘 다 있음 = 매분 갱신 수신) / gap(started인데 토큰 없음 = 갱신 불가).
    const byGame = new Map<string, { started: Set<string>; tokens: Set<string> }>();
    const entry = (gameId: string) => {
      let e = byGame.get(gameId);
      if (!e) {
        e = { started: new Set(), tokens: new Set() };
        byGame.set(gameId, e);
      }
      return e;
    };
    for (const r of startedRows) entry(r.game_id).started.add(r.user_id);
    for (const r of tokenRows) entry(r.game_id).tokens.add(r.user_id);

    const todayStr = getKSTDateStr();
    const gamesOut = [...byGame.entries()]
      .map(([gameId, e]) => {
        const meta = gameMeta.get(gameId);
        const gameDate = gameId.slice(0, 8);
        const isStale = !meta && gameDate < todayStr;
        const started = e.started.size;
        const tokens = e.tokens.size;
        const updatable = [...e.started].filter(u => e.tokens.has(u)).length;
        const gap = started - updatable;
        return {
          gameId,
          label: meta?.label ?? gameId,
          // 오늘 KBO 목록에 없는 과거 game_id 잔존 행 = end 정리 미수신 좀비 후보.
          status: meta?.status ?? (isStale ? "stale" : "unknown"),
          started,
          tokens,
          updatable,
          gap,
          isStale,
        };
      })
      .sort((a, b) => b.gameId.localeCompare(a.gameId) || b.started - a.started);

    // 요약은 *활성 경기(진행중/예정)*만 집계한다. 종료 경기는 end 푸시 후 서버가
    // update 토큰을 정상 삭제하므로 gap이 커 보이는 게 당연하고(고장 아님), 과거
    // started_users 행은 삭제 없이 잔존하는 기록 잔재라 섞으면 수치가 오독된다.
    const active = gamesOut.filter(g => g.status === "live" || g.status === "scheduled");
    const cards = active.reduce((s, g) => s + g.started, 0);
    const updatable = active.reduce((s, g) => s + g.updatable, 0);
    const residualGames = gamesOut.filter(g => !(g.status === "live" || g.status === "scheduled"));

    return NextResponse.json({
      pushToStart: {
        total: p2sTotal.count ?? 0,
        fresh24h: p2sFresh24h.count ?? 0,
        fresh7d: p2sFresh7d.count ?? 0,
      },
      summary: {
        cards,
        updatable,
        gap: cards - updatable,
        updateTokens: active.reduce((s, g) => s + g.tokens, 0),
        residualRows: residualGames.reduce((s, g) => s + g.started + g.tokens, 0),
        residualGameCount: residualGames.length,
      },
      games: gamesOut,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
