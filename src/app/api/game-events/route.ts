import { NextRequest, NextResponse } from "next/server";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameSnapshot } from "@/types/game-events";
import { generateEvents, type PrevGameState } from "@/lib/event-generator";
import type { GameEvent } from "@/types/game-events";
import type { KboRawGame } from "@/types/api";

// In-memory cache per game
const prevStateCache = new Map<string, PrevGameState>();
const eventHistory = new Map<string, GameEvent[]>();

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_SCHEDULE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
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
      let hr = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        if (ab === "4구") bb++;
        if (ab.includes("삼진")) so++;
      }
      const order = safeInt(stripHtml(cells[0]));
      const posRaw = stripHtml(cells[1] || "");
      const isSubstitute = order === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      prevOrder = order;
      return {
        order,
        position: posRaw,
        positionFull: posRaw,
        name: stripHtml(cells[2] || ""),
        atBats: safeInt(stripHtml(tail[0])),
        hits: safeInt(stripHtml(tail[1])),
        rbi: safeInt(stripHtml(tail[2])),
        runs: safeInt(stripHtml(tail[3])),
        hr, bb, so, sb: 0,
        avg: stripHtml(tail[4]) || ".000",
        isSubstitute,
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
    // Fetch live game list + BoxScore in parallel
    const [liveRes, boxScoreRes] = await Promise.all([
      fetch(`${KBO_MAIN}/GetKboGameList`, {
        method: "POST",
        headers: HEADERS,
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
        cache: "no-store",
      }).then(r => r.ok ? r.json() : null).catch(() => null),

      fetch(`${KBO_SCHEDULE}/GetBoxScore`, {
        method: "POST",
        headers: HEADERS,
        body: `leId=1&srId=${date >= "20260312" && date <= "20260324" ? "1" : "0"}&seasonId=${date.slice(0, 4)}&gameId=${gameId}`,
        cache: "no-store",
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    // Find this game in the live list
    const games = liveRes?.game || [];
    const rawGame = games.find((g: KboRawGame) => g.G_ID === gameId);

    if (!rawGame) {
      const existing = eventHistory.get(gameId) || [];
      const emptySnapshot: GameSnapshot = {
        awayScore: 0, homeScore: 0,
        balls: 0, strikes: 0, outs: 0,
        runners: { first: null, second: null, third: null },
        pitcher: "", batter: "",
      };
      return NextResponse.json({ events: existing, currentState: emptySnapshot });
    }

    const status = rawGame.CANCEL_SC_ID !== "0" ? "cancelled"
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
      currentBatter: rawGame.T_P_NM?.trim() || null,
      currentPitcher: rawGame.B_P_NM?.trim() || null,
      currentInning: rawGame.GAME_INN_NO ? `${rawGame.GAME_INN_NO}회${rawGame.GAME_TB_SC === "T" ? "초" : "말"}` : "",
      stadium: rawGame.S_NM,
      isLive: rawGame.GAME_STATE_SC === "2",
    };

    const currentBoxScore = parseBoxScoreMinimal(boxScoreRes);
    const prevState = prevStateCache.get(gameId) || null;

    const { events: newEvents, nextState } = generateEvents(
      gameId,
      prevState,
      currentLive,
      currentBoxScore,
    );

    // Update cache
    prevStateCache.set(gameId, nextState);

    // Accumulate event history
    const history = eventHistory.get(gameId) || [];
    history.push(...newEvents);
    eventHistory.set(gameId, history);

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

    return NextResponse.json({ events: history, currentState });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: (e as Error).message, events: eventHistory.get(gameId) || [], currentState: null },
      { status: 200 },
    );
  }
}
