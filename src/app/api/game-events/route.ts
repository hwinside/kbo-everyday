import { NextRequest, NextResponse } from "next/server";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import { fetchNaverRecord, type GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameSnapshot } from "@/types/game-events";
import { generateEvents, type PrevGameState } from "@/lib/event-generator";
import type { GameEvent } from "@/types/game-events";
import type { KboRawGame } from "@/types/api";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { deriveStartPlateAppearanceEvidence } from "@/lib/notifications/start-plate-appearance";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";

// State is persisted in Supabase (table: game_event_state) so all Vercel
// serverless instances share a single source of truth. Previous in-memory
// Maps caused instance lottery — a client request landing on instance A
// could see a different events history than the same request landing on
// instance B, breaking K celebration counters (e.g. 6연속 K → "그냥 삼진"
// or "2K" depending on which instance answered each poll).

const KBO_SCHEDULE = "https://www.koreabaseball.com/ws/Schedule.asmx";
// 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청에 IE 분기 HTML 에러 페이지 반환.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
};

function safeInt(v: unknown): number {
  if (v == null || v === "" || v === "&nbsp;") return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "&nbsp;" ? "" : s;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

// Minimal BoxScore parser (reuse logic from game-detail)
function parseBoxScoreMinimal(data: unknown): GameDetailResponse["boxScore"] {
  const obj = data as { tables?: unknown[] };
  if (!obj?.tables || !Array.isArray(obj.tables) || obj.tables.length < 5) return null;

  type TableRow = { rows?: { row: { Text: string }[] }[] };

  function parseBatters(table: TableRow) {
    if (!table?.rows) return [];
    let prevOrder = -1;
    return table.rows.map(r => {
      const cells = r.row.map(c => safeStr(c.Text));
      const tail = cells.slice(cells.length - 5);
      const atBatResults = cells.slice(3, cells.length - 5).map(c => stripHtml(c)).filter(c => c && c !== "&nbsp;");
      let hr = 0, h2b = 0, h3b = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        else if (ab.includes("3루타") || ab.includes("삼루타")) h3b++;
        else if (ab.includes("2루타") || ab.includes("이루타")) h2b++;
        if (ab === "4구") bb++;
        if (ab.includes("삼진")) so++;
      }
      const rawOrder = safeInt(stripHtml(cells[0]));
      const posRaw = stripHtml(cells[1] || "");
      // game-detail/route.ts와 동일한 substitute 룰. 빈 타순 셀은 직전 row의 타순을
      // 그대로 이어 베이스 룩업이 안정적이도록 한다.
      const isSubstitute = rawOrder === 0 || rawOrder === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      const order = isSubstitute && rawOrder === 0 && prevOrder > 0 ? prevOrder : rawOrder;
      if (order > 0) prevOrder = order;
      return {
        order,
        position: posRaw,
        positionFull: posRaw,
        name: stripHtml(cells[2] || ""),
        atBats: safeInt(stripHtml(tail[0])),
        hits: safeInt(stripHtml(tail[1])),
        rbi: safeInt(stripHtml(tail[2])),
        runs: safeInt(stripHtml(tail[3])),
        hr, h2b, h3b, bb, so, sb: 0,
        avg: stripHtml(tail[4]) || ".000",
        isSubstitute,
        plateAppearances: atBatResults.length,
      };
    }).filter(b => b.name !== "");
  }

  function parsePitchers(table: TableRow) {
    if (!table?.rows) return [];
    return table.rows.map(r => {
      const cells = r.row.map(c => safeStr(c.Text));
      return {
        name: stripHtml(cells[0] || ""),
        inningsPitched: stripHtml(cells[6] || ""),
        decision: stripHtml(cells[2] || ""),
        battersFaced: safeInt(stripHtml(cells[7])),
        pitchCount: safeInt(stripHtml(cells[8])),
        atBats: safeInt(stripHtml(cells[9])),
        hits: safeInt(stripHtml(cells[10])),
        hr: safeInt(stripHtml(cells[11])),
        walks: safeInt(stripHtml(cells[12])),
        strikeouts: safeInt(stripHtml(cells[13])),
        runs: safeInt(stripHtml(cells[14])),
        earnedRuns: safeInt(stripHtml(cells[15])),
        era: stripHtml(cells[16] || "") || "0.00",
      };
    }).filter(p => p.name !== "");
  }

  const tables = obj.tables as TableRow[];
  return {
    awayBatters: parseBatters(tables[1]),
    homeBatters: parseBatters(tables[2]),
    awayPitchers: parsePitchers(tables[3]),
    homePitchers: parsePitchers(tables[4]),
  };
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 });
  }

  const date = gameId.slice(0, 8); // YYYYMMDD from game ID

  try {
    // 중계 화면·warmup과 같은 KBO→Naver 공용 source를 사용한다.
    const fetched = await fetchKboLiveGames(date, Date.now() + 5_000);
    const games = fetched.ok ? fetched.games : [];
    const rawGame = games.find((g: KboRawGame) => g.G_ID === gameId);

    // Use SR_ID from live data (GetBoxScore only accepts single integer srId)
    const srId = (rawGame as (KboRawGame & { SR_ID?: string }) | undefined)?.SR_ID ?? "0";
    const boxScoreRes = await fetch(`${KBO_SCHEDULE}/GetBoxScore`, {
      method: "POST",
      headers: HEADERS,
      body: `leId=1&srId=${srId}&seasonId=${date.slice(0, 4)}&gameId=${gameId}`,
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    }).then(r => r.ok ? r.json() : null).catch(() => null);

    if (!rawGame) {
      const { data: row } = await supabaseAdmin
        .from("game_event_state")
        .select("event_history")
        .eq("game_id", gameId)
        .maybeSingle();
      const existing = ((row?.event_history as GameEvent[] | null) ?? []);
      const emptySnapshot: GameSnapshot = {
        awayScore: 0, homeScore: 0,
        balls: 0, strikes: 0, outs: 0,
        runners: { first: null, second: null, third: null },
        pitcher: "", batter: "",
      };
      return NextResponse.json({ events: existing, currentState: emptySnapshot });
    }

    const status = isKboGameCancelled(rawGame.CANCEL_SC_ID) ? "cancelled"
      : rawGame.GAME_STATE_SC === "3" ? "final"
      : rawGame.GAME_STATE_SC === "2" ? "live"
      : "scheduled";

    const currentLive: LiveGameData = {
      gameId: rawGame.G_ID,
      awayName: rawGame.AWAY_NM,
      homeName: rawGame.HOME_NM,
      awayScore: status !== "scheduled" ? safeInt(rawGame.T_SCORE_CN) : 0,
      homeScore: status !== "scheduled" ? safeInt(rawGame.B_SCORE_CN) : 0,
      inning: rawGame.GAME_INN_NO ?? 0,
      isTop: rawGame.GAME_TB_SC === "T",
      balls: rawGame.BALL_CN ?? 0,
      strikes: rawGame.STRIKE_CN ?? 0,
      outs: rawGame.OUT_CN ?? 0,
      runner1b: (rawGame.B1_BAT_ORDER_NO ?? 0) > 0,
      runner2b: (rawGame.B2_BAT_ORDER_NO ?? 0) > 0,
      runner3b: (rawGame.B3_BAT_ORDER_NO ?? 0) > 0,
      runner1bName: null,
      runner2bName: null,
      runner3bName: null,
      ...resolveCurrentPlayers({
        tPlayerName: rawGame.T_P_NM,
        bPlayerName: rawGame.B_P_NM,
        gameTbSc: rawGame.GAME_TB_SC,
      }),
      currentInning: rawGame.GAME_INN_NO ? `${rawGame.GAME_INN_NO}회${rawGame.GAME_TB_SC === "T" ? "초" : "말"}` : "",
      stadium: rawGame.S_NM,
      isLive: rawGame.GAME_STATE_SC === "2",
      awayStarterName: rawGame.T_PIT_P_NM?.trim() || null,
      homeStarterName: rawGame.B_PIT_P_NM?.trim() || null,
    };

    let currentBoxScore = parseBoxScoreMinimal(boxScoreRes);

    // KBO GetBoxScore returns empty tables intermittently — same fallback as
    // game-detail/route.ts. Without this the parsed batter list is empty,
    // diffBatters() returns nothing, and at_bat_strikeout events are never
    // emitted (clients see only at_bat_out fallbacks → no K celebration).
    const hasRealBoxScore = currentBoxScore &&
      (currentBoxScore.awayBatters.some(b => b.atBats > 0) ||
        currentBoxScore.homeBatters.some(b => b.atBats > 0));
    if (!hasRealBoxScore) {
      const naver = await fetchNaverRecord(gameId);
      if (naver?.boxScore) {
        const naverHasData = naver.boxScore.awayBatters.some(b => b.atBats > 0)
          || naver.boxScore.homeBatters.some(b => b.atBats > 0);
        if (naverHasData) currentBoxScore = naver.boxScore;
      }
    }

    // Read shared state from Supabase (single row per game)
    const { data: stateRow } = await supabaseAdmin
      .from("game_event_state")
      .select("prev_state, event_history")
      .eq("game_id", gameId)
      .maybeSingle();

    const prevState = (stateRow?.prev_state as PrevGameState | null) ?? null;
    const existingHistory = ((stateRow?.event_history as GameEvent[] | null) ?? []);

    const { events: newEvents, nextState } = generateEvents(
      gameId,
      prevState,
      currentLive,
      currentBoxScore,
    );

    // Atomic append via SQL function — prevents read-modify-write race
    // where two concurrent pollers both read the same existingHistory and
    // each clobbers the other's newEvents. event_history grows
    // monotonically; prev_state is last-write-wins (self-heals next poll).
    let history: GameEvent[];
    if (newEvents.length > 0) {
      const { data: rpcHistory } = await supabaseAdmin.rpc(
        "upsert_game_event_state",
        {
          p_game_id: gameId,
          p_prev_state: nextState as unknown as Record<string, unknown>,
          p_new_events: newEvents as unknown as Record<string, unknown>[],
        },
      );
      history = (rpcHistory as GameEvent[] | null) ?? [...existingHistory, ...newEvents];
    } else if (!stateRow) {
      // First-ever poll for this game — seed an empty row so subsequent
      // pollers see prev_state on the first contentful change.
      await supabaseAdmin
        .from("game_event_state")
        .upsert({
          game_id: gameId,
          prev_state: nextState as unknown as Record<string, unknown>,
          event_history: [] as unknown as Record<string, unknown>[],
          updated_at: new Date().toISOString(),
        });
      history = existingHistory;
    } else {
      history = existingHistory;
    }

    const currentState: GameSnapshot = {
      awayScore: currentLive.awayScore,
      homeScore: currentLive.homeScore,
      balls: currentLive.balls,
      strikes: currentLive.strikes,
      outs: currentLive.outs,
      runners: {
        first: currentLive.runner1bName || (currentLive.runner1b ? "주자" : null),
        second: currentLive.runner2bName || (currentLive.runner2b ? "주자" : null),
        third: currentLive.runner3bName || (currentLive.runner3b ? "주자" : null),
      },
      pitcher: currentLive.currentPitcher || "",
      batter: currentLive.currentBatter || "",
    };

    const startPlateAppearance = deriveStartPlateAppearanceEvidence(
      currentBoxScore?.awayBatters,
      currentLive.currentBatter,
    );

    return NextResponse.json({ events: history, currentState, startPlateAppearance });
  } catch (e: unknown) {
    // Best-effort fallback — if Supabase itself is down, the original error
    // would have surfaced from the supabase client too, so wrap defensively
    // and return an empty history rather than a 500.
    let fallback: GameEvent[] = [];
    try {
      const { data: row } = await supabaseAdmin
        .from("game_event_state")
        .select("event_history")
        .eq("game_id", gameId)
        .maybeSingle();
      fallback = (row?.event_history as GameEvent[] | null) ?? [];
    } catch {
      // swallow — fallback stays []
    }
    return NextResponse.json(
      { error: (e as Error).message, events: fallback, currentState: null },
      { status: 200 },
    );
  }
}
