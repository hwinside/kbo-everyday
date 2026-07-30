/**
 * /api/contextual-stats?gameId=YYYYMMDD{HOME}{AWAY}{N}
 *
 * Surfaces situational stats for the *current at-bat* in the GameChat box
 * between 문자중계 and chat. Each line is null unless its context gate
 * matches AND its sample-size threshold is met AND upstream parsed cleanly
 * — i.e. fail-closed at the row level. The full box is unmounted only when
 * every line and every highlight is null (response.empty === true).
 *
 * Spec: specs/community/gamechat-contextual-stats-v1.md
 *
 * Sources (spec §3):
 *   D — KBO GetKboGameList     (current game state, current batter/pitcher)
 *   B — KBO GetBoxScore        (대타 detection, pitcher today H/BB/BF)
 *   C — KBO Basic.aspx         (season RISP/PH-BA/HR, handedness)
 *   C-S — KBO Situation.aspx   (bases/byHand/byOuts split rows)
 *
 * Why no /api/player-stats reuse: that endpoint omits RISP/PH-BA and never
 * fetches Situation. v1 needs the union, so we go direct.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { normalizeBatterName } from "@/lib/relay-event-generator";
import { parseHandedness } from "@/lib/contextual-stats/handedness-parser";
import { parseHitterBasic, parsePitcherBasic } from "@/lib/contextual-stats/basic-parser";
import {
  parseSituation,
  looksLikeAspNetError,
} from "@/lib/contextual-stats/situation-parser";
import {
  selectBasesLoadedPair,
  selectNoHitter,
  selectPhBA,
  selectRispPair,
  selectTwoOutsPair,
  selectVsHandPair,
} from "@/lib/contextual-stats/gates";
import type {
  BasicSeasonStats,
  ContextualHighlights,
  ContextualLines,
  ContextualStatsResponse,
  GameContext,
  PlayerHandedness,
  SituationTables,
} from "@/lib/contextual-stats/types";
import type { KboRawGame } from "@/types/api";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";

export const dynamic = "force-dynamic";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_SCHEDULE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const KBO_PLAYER = "https://www.koreabaseball.com/Record/Player";

// 2026-05-20: KBO returns IE-branch HTML when Referer is not koreabaseball.com.
// Every outbound KBO fetch in this route MUST include this Referer header.
const KBO_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  Referer: "https://www.koreabaseball.com",
};

// ===== Profile cache (Basic + Situation share the same 1h policy) =====

interface ProfileBundle {
  basic: BasicSeasonStats | null;
  situation: SituationTables;
  handedness: ReturnType<typeof parseHandedness>;
}

const profileCache = new Map<string, { bundle: ProfileBundle; expiresAt: number }>();
const PROFILE_TTL_MS = 60 * 60 * 1000;

function profileKey(role: "batter" | "pitcher", playerId: string): string {
  return `${role}:${playerId}`;
}

async function fetchKboHtml(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: KBO_HEADERS, cache: "no-store" });
  if (!res.ok) return null;
  const html = await res.text();
  if (looksLikeAspNetError(html)) return null;
  return html;
}

async function loadProfile(
  role: "batter" | "pitcher",
  numericId: string,
  name: string,
): Promise<ProfileBundle> {
  const key = profileKey(role, numericId);
  const cached = profileCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.bundle;

  const basicUrl =
    `${KBO_PLAYER}/${role === "batter" ? "HitterDetail" : "PitcherDetail"}/Basic.aspx?playerId=${numericId}`;
  const situationUrl =
    `${KBO_PLAYER}/${role === "batter" ? "HitterDetail" : "PitcherDetail"}/Situation.aspx?playerId=${numericId}`;

  const [basicHtml, situationHtml] = await Promise.all([
    fetchKboHtml(basicUrl),
    fetchKboHtml(situationUrl),
  ]);

  const basic =
    basicHtml === null
      ? null
      : role === "batter"
        ? parseHitterBasic(basicHtml, numericId, name)
        : parsePitcherBasic(basicHtml, numericId, name);

  const situation: SituationTables =
    situationHtml === null
      ? { bases: [], byHand: [], byOuts: [] }
      : parseSituation(situationHtml, role);

  const handedness = basicHtml ? parseHandedness(basicHtml) : { bat: null, throws: null };

  const bundle: ProfileBundle = { basic, situation, handedness };
  profileCache.set(key, { bundle, expiresAt: Date.now() + PROFILE_TTL_MS });
  return bundle;
}

// ===== KBO live state fetch =====

interface LiveGameSnapshot {
  rawGame: KboRawGame;
  batterName: string | null;
  pitcherName: string | null;
}

/**
 * KBO GetKboGameList 직접 호출 결과. rawGame=null이면서 kboFailed=true는
 * HTTP 실패/JSON 파싱 실패(하드 장애)로, 이때만 Naver failover를 태운다.
 * kboFailed=false + rawGame=null은 KBO가 정상 응답했으나 해당 경기가 목록에
 * 없는 경우로(무경기/미개시), 기존처럼 degrade 유지(무변경 보존).
 */
async function fetchLiveGameFromKbo(
  gameId: string,
  date: string,
  fetchImpl: typeof fetch,
): Promise<{ rawGame: KboRawGame | null; kboFailed: boolean }> {
  const res = await fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: KBO_HEADERS,
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
    cache: "no-store",
  });
  if (!res.ok) return { rawGame: null, kboFailed: true };
  const text = await res.text();
  // KBO sometimes appends ASP.NET error HTML after JSON — parse JSON prefix only.
  const jsonPrefix = text.split(/}<!/)[0] + (text.includes("}<!") ? "}" : "");
  let parsed: { game?: KboRawGame[] };
  try {
    parsed = JSON.parse(jsonPrefix);
  } catch {
    return { rawGame: null, kboFailed: true };
  }
  const games = parsed.game ?? [];
  return { rawGame: games.find(g => g.G_ID === gameId) ?? null, kboFailed: false };
}

// Exported for scripts/qa/contextual-stats-naver-failover-smoke.ts (fault injection).
export async function fetchLiveGame(
  gameId: string,
  fetchImpl: typeof fetch = fetch,
  failoverImpl: typeof fetchKboLiveGames = fetchKboLiveGames,
): Promise<LiveGameSnapshot | null> {
  const date = gameId.slice(0, 8);
  const kbo = await fetchLiveGameFromKbo(gameId, date, fetchImpl);
  let rawGame = kbo.rawGame;

  // KBO GetKboGameList가 HTTP/파싱으로 하드 실패한 경우에만 공용 Naver failover로
  // 현재 투수/타자를 보강한다. naverGameToRaw가 GAME_TB_SC(공수)와 함께
  // B_P_NM/T_P_NM에 현재 투타명(relay currentGameState pcode→이름)을 넣어 주므로
  // (kbo-live-games.ts naverGameToRaw), 아래 isTop 매핑을 그대로 재사용한다.
  // Naver도 ok:false거나 해당 경기가 없으면 null degrade(fail-close).
  if (!rawGame && kbo.kboFailed) {
    const failover = await failoverImpl(date).catch(() => null);
    if (failover?.ok) {
      rawGame = failover.games.find(g => g.G_ID === gameId) ?? null;
    }
  }
  if (!rawGame) return null;

  const isTop = rawGame.GAME_TB_SC === "T";
  const batterName = (isTop ? rawGame.T_P_NM : rawGame.B_P_NM)?.trim() || null;
  const pitcherName = (isTop ? rawGame.B_P_NM : rawGame.T_P_NM)?.trim() || null;
  return { rawGame, batterName, pitcherName };
}

interface BoxSnapshot {
  /** Is current batter a pinch hitter? Detected via boxscore position prefix "타". */
  batterIsPinch: boolean;
  /**
   * Sum of hits across *all pitchers that have appeared for the defending
   * team today*. Used by the no-hitter gate. Null when the box hasn't been
   * parsed (e.g., game not yet started or KBO error response).
   *
   * Why team-aggregated rather than the current pitcher's row: 삼순이 NO-GO
   * #2 — a relief pitcher with 0 IP would short-circuit to no-hitter on the
   * individual row even after the starter gave up multiple hits.
   */
  defendingTeamHits: number | null;
}

async function fetchBoxSnapshot(
  gameId: string,
  srId: string,
  batterName: string | null,
  pitcherName: string | null,
): Promise<BoxSnapshot> {
  const seasonId = gameId.slice(0, 4);
  const res = await fetch(`${KBO_SCHEDULE}/GetBoxScore`, {
    method: "POST",
    headers: KBO_HEADERS,
    body: `leId=1&srId=${srId}&seasonId=${seasonId}&gameId=${gameId}`,
    cache: "no-store",
  });
  if (!res.ok) return { batterIsPinch: false, defendingTeamHits: null };
  let parsed: { tables?: Array<{ rows?: Array<{ row: Array<{ Text: string }> }> }> };
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    return { batterIsPinch: false, defendingTeamHits: null };
  }
  const tables = parsed.tables ?? [];

  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();
  const safeStr = (v: unknown) => {
    if (v == null) return "";
    const s = String(v).trim();
    return s === "&nbsp;" ? "" : s;
  };

  // Tables 1/2 = away/home batters. We look for the *current batter row* and
  // check the position cell — substitute pinch hitters carry "타" prefix.
  // Name comparison normalizes whitespace so "엘리엇 어슨" (live) vs
  // "엘리엇어슨" (boxscore) doesn't silently drop the match.
  let batterIsPinch = false;
  const batterNameNorm = batterName ? normalizeBatterName(batterName) : "";
  if (batterNameNorm) {
    for (const t of [tables[1], tables[2]]) {
      if (!t?.rows) continue;
      for (const r of t.rows) {
        const cells = r.row.map(c => safeStr(c.Text));
        const name = normalizeBatterName(stripHtml(cells[2] ?? ""));
        if (name === batterNameNorm) {
          const posRaw = stripHtml(cells[1] ?? "");
          if (posRaw.startsWith("타")) batterIsPinch = true;
        }
      }
    }
  }

  // Tables 3/4 = away/home pitchers. Each row layout (from game-events/route):
  //   [name, _, decision, _, _, _, IP, BF, NP, AB, H, HR, BB, K, R, ER, ERA]
  //
  // For the no-hitter gate we want the *defending team's* total hits across
  // ALL pitchers in their respective table. Defending team is identified by
  // locating which of tables[3]/tables[4] contains the current pitcher.
  const safeInt = (s: string) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };

  let defendingTeamHits: number | null = null;
  const pitcherNameNorm = pitcherName ? normalizeBatterName(pitcherName) : "";
  if (pitcherNameNorm) {
    for (const t of [tables[3], tables[4]]) {
      if (!t?.rows) continue;
      const tableHasCurrentPitcher = t.rows.some(r => {
        const cells = r.row.map(c => safeStr(c.Text));
        return normalizeBatterName(stripHtml(cells[0] ?? "")) === pitcherNameNorm;
      });
      if (!tableHasCurrentPitcher) continue;
      let sumH = 0;
      for (const r of t.rows) {
        const cells = r.row.map(c => safeStr(c.Text));
        sumH += safeInt(stripHtml(cells[10] ?? ""));
      }
      defendingTeamHits = sumH;
      break;
    }
  }

  return { batterIsPinch, defendingTeamHits };
}

// ===== Route handler =====

const EMPTY_RESPONSE_LINES: ContextualLines = {
  vsHand: null,
  basesLoaded: null,
  risp: null,
  twoOuts: null,
  phBA: null,
};
const EMPTY_RESPONSE_HIGHLIGHTS: ContextualHighlights = {
  cycle: null,
  noHitter: null,
  milestone: null,
  hrLeader: null,
};

function emptyResponse(gameId: string, context: GameContext): ContextualStatsResponse {
  return {
    gameId,
    context,
    lines: EMPTY_RESPONSE_LINES,
    highlights: EMPTY_RESPONSE_HIGHLIGHTS,
    fetchedAt: new Date().toISOString(),
    empty: true,
  };
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId required" }, { status: 400 });
  }

  const live = await fetchLiveGame(gameId);
  if (!live) {
    return NextResponse.json(
      emptyResponse(gameId, {
        gameId,
        inning: 0,
        isTop: true,
        outs: 0,
        balls: 0,
        strikes: 0,
        bases: { first: false, second: false, third: false },
        batterKboId: null,
        pitcherKboId: null,
        batterName: null,
        pitcherName: null,
        batterIsPinch: false,
      }),
    );
  }

  const { rawGame, batterName, pitcherName } = live;

  // Box snapshot in parallel with profile loads, but profile loads need
  // resolved kboIds first — do them sequentially in two waves to keep the
  // code straight (boxscore is fast enough that this isn't a hot path issue).
  // SR_ID isn't in the typed KboRawGame interface but is present in the
  // actual response (existing game-events route reads it the same way).
  const srId = (rawGame as unknown as { SR_ID?: string }).SR_ID ?? "1";

  const batter = batterName ? resolvePlayer({ name: batterName }) : null;
  const pitcher = pitcherName ? resolvePlayer({ name: pitcherName }) : null;

  // If we cannot map *either* current player to a kboId, every line below
  // will be null — short-circuit early.
  if (!batter && !pitcher) {
    return NextResponse.json(
      emptyResponse(gameId, {
        gameId,
        inning: rawGame.GAME_INN_NO ?? 0,
        isTop: rawGame.GAME_TB_SC === "T",
        outs: rawGame.OUT_CN ?? 0,
        balls: rawGame.BALL_CN ?? 0,
        strikes: rawGame.STRIKE_CN ?? 0,
        bases: {
          first: (rawGame.B1_BAT_ORDER_NO ?? 0) > 0,
          second: (rawGame.B2_BAT_ORDER_NO ?? 0) > 0,
          third: (rawGame.B3_BAT_ORDER_NO ?? 0) > 0,
        },
        batterKboId: null,
        pitcherKboId: null,
        batterName: null,
        pitcherName: null,
        batterIsPinch: false,
      }),
    );
  }

  const [boxSnapshot, batterProfile, pitcherProfile] = await Promise.all([
    fetchBoxSnapshot(gameId, srId, batterName, pitcherName),
    batter ? loadProfile("batter", batter.numericId, batter.name) : Promise.resolve(null),
    pitcher ? loadProfile("pitcher", pitcher.numericId, pitcher.name) : Promise.resolve(null),
  ]);

  const ctx: GameContext = {
    gameId,
    inning: rawGame.GAME_INN_NO ?? 0,
    isTop: rawGame.GAME_TB_SC === "T",
    outs: rawGame.OUT_CN ?? 0,
    balls: rawGame.BALL_CN ?? 0,
    strikes: rawGame.STRIKE_CN ?? 0,
    bases: {
      first: (rawGame.B1_BAT_ORDER_NO ?? 0) > 0,
      second: (rawGame.B2_BAT_ORDER_NO ?? 0) > 0,
      third: (rawGame.B3_BAT_ORDER_NO ?? 0) > 0,
    },
    batterKboId: batter?.kboId ?? null,
    pitcherKboId: pitcher?.kboId ?? null,
    batterName: batter?.name ?? null,
    pitcherName: pitcher?.name ?? null,
    batterIsPinch: boxSnapshot.batterIsPinch,
  };

  // ===== Apply gates =====

  // Batter 측은 bat이 vsHand 매칭에 필수, throws는 무관(미사용).
  const batterHandedness: PlayerHandedness | null =
    batter && batterProfile?.handedness.bat
      ? {
          kboId: batter.kboId,
          name: batter.name,
          bat: batterProfile.handedness.bat,
          throws: batterProfile.handedness.throws,
        }
      : null;

  // Pitcher 측 페이지("투수(좌투)")는 bat 정보 없음. throws만 있어도 batter의
  // "vs 좌/우투수" 행 매칭에 충분 → throws 단독으로 PlayerHandedness 생성.
  const pitcherHandedness: PlayerHandedness | null =
    pitcher && pitcherProfile?.handedness.throws
      ? {
          kboId: pitcher.kboId,
          name: pitcher.name,
          bat: pitcherProfile.handedness.bat,
          throws: pitcherProfile.handedness.throws,
        }
      : null;

  const batterRef = batter ? { kboId: batter.kboId, name: batter.name } : null;
  const pitcherRef = pitcher ? { kboId: pitcher.kboId, name: pitcher.name } : null;
  const batterSit = batterProfile?.situation ?? null;
  const pitcherSit = pitcherProfile?.situation ?? null;

  const lines: ContextualLines = {
    vsHand: selectVsHandPair(
      batterSit,
      pitcherSit,
      batterHandedness,
      pitcherHandedness,
      batterRef,
      pitcherRef,
    ),
    basesLoaded: selectBasesLoadedPair(batterSit, pitcherSit, ctx, batterRef, pitcherRef),
    risp: selectRispPair(batterSit, pitcherSit, ctx, batterRef, pitcherRef),
    twoOuts: selectTwoOutsPair(batterSit, pitcherSit, ctx, batterRef, pitcherRef),
    phBA: selectPhBA(batterProfile?.basic ?? null, ctx),
  };

  const noHitter = selectNoHitter(boxSnapshot.defendingTeamHits, ctx);
  const highlights: ContextualHighlights = {
    cycle: null, // PR3 trigger-line work
    noHitter: noHitter
      ? { value: noHitter, reason: `inning=${ctx.inning}, defending-team H=0` }
      : null,
    milestone: null, // PR3 trigger-line work
    hrLeader: null, // PR3 trigger-line work
  };

  const empty =
    Object.values(lines).every(v => v === null) &&
    Object.values(highlights).every(v => v === null);

  const response: ContextualStatsResponse = {
    gameId,
    context: ctx,
    lines,
    highlights,
    fetchedAt: new Date().toISOString(),
    empty,
  };
  return NextResponse.json(response);
}
