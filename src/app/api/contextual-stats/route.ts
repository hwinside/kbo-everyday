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
import {
  LIVE_LIST_EDGE_TTL_SECONDS,
  NO_STORE_HEADERS,
  liveCacheHeaders,
} from "@/lib/http/live-cache";

export const dynamic = "force-dynamic";

const KBO_SCHEDULE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const KBO_PLAYER = "https://www.koreabaseball.com/Record/Player";
const CONTEXTUAL_DEADLINE_MS = 7_000;

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

// Exported for scripts/qa/contextual-stats-naver-failover-smoke.ts.
export async function fetchContextualBeforeDeadline(
  url: string,
  init: RequestInit,
  deadlineAtMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  try {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) return null;
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, remainingMs)),
    });
  } catch {
    return null;
  }
}

// Exported for scripts/qa/contextual-stats-naver-failover-smoke.ts (fault injection).
// KBO는 200 헤더를 먼저 흘리고 본문(body) 스트림에서 멈추는 부분열화가 있다. 이때
// res.text()/res.json()은 fetch AbortSignal(또는 아래 명시 deadline)에 의해 reject되는데,
// 그 reject가 fetchKboHtml/fetchBoxSnapshot→Promise.all→GET route로 전파되면 route 전체가
// 500으로 죽는다(삼순 재리뷰 blocker: actual GET 7.003s 후 500). 본문 읽기까지 catch +
// 절대 deadline race로 감싸 empty/null degrade시킨다(부분열화가 전체 실패로 번지지 않게).
export async function readTextBeforeDeadline(
  res: Response,
  deadlineAtMs: number,
): Promise<string | null> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // fetch에 넘긴 AbortSignal이 stalled body를 이미 끊어주지만, 헤더 도착 후 본문에서
    // 멈추는 런타임/수동 Response(테스트)에서도 안전하도록 명시적 절대 deadline을 함께 race한다.
    return await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("contextual_body_read_deadline")),
          Math.max(1, remainingMs),
        );
      }),
    ]);
  } catch {
    void res.body?.cancel().catch(() => {});
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchKboHtml(url: string, deadlineAtMs: number): Promise<string | null> {
  const res = await fetchContextualBeforeDeadline(
    url,
    { headers: KBO_HEADERS, cache: "no-store" },
    deadlineAtMs,
  );
  if (!res?.ok) return null;
  const html = await readTextBeforeDeadline(res, deadlineAtMs);
  if (html === null || looksLikeAspNetError(html)) return null;
  return html;
}

async function loadProfile(
  role: "batter" | "pitcher",
  numericId: string,
  name: string,
  deadlineAtMs: number,
): Promise<ProfileBundle> {
  const key = profileKey(role, numericId);
  const cached = profileCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.bundle;

  const basicUrl =
    `${KBO_PLAYER}/${role === "batter" ? "HitterDetail" : "PitcherDetail"}/Basic.aspx?playerId=${numericId}`;
  const situationUrl =
    `${KBO_PLAYER}/${role === "batter" ? "HitterDetail" : "PitcherDetail"}/Situation.aspx?playerId=${numericId}`;

  const [basicHtml, situationHtml] = await Promise.all([
    fetchKboHtml(basicUrl, deadlineAtMs),
    fetchKboHtml(situationUrl, deadlineAtMs),
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
  // Upstream 전체 장애/timeout의 빈 결과를 1시간 캐시하면 복구 뒤에도 UI가 계속 비게 된다.
  if (basicHtml !== null || situationHtml !== null) {
    profileCache.set(key, { bundle, expiresAt: Date.now() + PROFILE_TTL_MS });
  }
  return bundle;
}

// ===== KBO live state fetch =====

interface LiveGameSnapshot {
  rawGame: KboRawGame;
  batterName: string | null;
  pitcherName: string | null;
}

// Exported for scripts/qa/contextual-stats-naver-failover-smoke.ts (fault injection).
export async function fetchLiveGame(
  gameId: string,
  liveGamesImpl: typeof fetchKboLiveGames = fetchKboLiveGames,
  deadlineAtMs: number = Date.now() + CONTEXTUAL_DEADLINE_MS,
): Promise<LiveGameSnapshot | null> {
  const date = gameId.slice(0, 8);
  // 공용 helper가 KBO hard-hang을 짧게 끊고, 200-empty/요청 경기 부재도 Naver로
  // 교차확인한다. 양쪽 불확실하면 ok:false라 거짓 empty를 확정하지 않는다.
  const source = await liveGamesImpl(
    date,
    deadlineAtMs,
    undefined,
    undefined,
    undefined,
    gameId,
  ).catch(() => null);
  const rawGame = source?.ok
    ? source.games.find(g => g.G_ID === gameId) ?? null
    : null;
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
  deadlineAtMs: number,
): Promise<BoxSnapshot> {
  const seasonId = gameId.slice(0, 4);
  const res = await fetchContextualBeforeDeadline(
    `${KBO_SCHEDULE}/GetBoxScore`,
    {
      method: "POST",
      headers: KBO_HEADERS,
      body: `leId=1&srId=${srId}&seasonId=${seasonId}&gameId=${gameId}`,
      cache: "no-store",
    },
    deadlineAtMs,
  );
  if (!res?.ok) return { batterIsPinch: false, defendingTeamHits: null };
  // Body-stall(헤더 200 후 본문 멈춤)도 catch+절대 deadline으로 null degrade — res.text()
  // reject가 Promise.all→route로 전파되어 500 나는 것 차단(삼순 재리뷰 blocker).
  const text = await readTextBeforeDeadline(res, deadlineAtMs);
  if (text === null) return { batterIsPinch: false, defendingTeamHits: null };
  let parsed: { tables?: Array<{ rows?: Array<{ row: Array<{ Text: string }> }> }> };
  try {
    parsed = JSON.parse(text);
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
    return NextResponse.json(
      { error: "gameId required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const deadlineAtMs = Date.now() + CONTEXTUAL_DEADLINE_MS;
  const live = await fetchLiveGame(gameId, fetchKboLiveGames, deadlineAtMs);
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
      { headers: NO_STORE_HEADERS },
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
      { headers: NO_STORE_HEADERS },
    );
  }

  const [boxSnapshot, batterProfile, pitcherProfile] = await Promise.all([
    fetchBoxSnapshot(gameId, srId, batterName, pitcherName, deadlineAtMs),
    batter ? loadProfile("batter", batter.numericId, batter.name, deadlineAtMs) : Promise.resolve(null),
    pitcher ? loadProfile("pitcher", pitcher.numericId, pitcher.name, deadlineAtMs) : Promise.resolve(null),
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
  // 완전히 채워진 응답만 엣지에 올린다. empty 응답(상대 매핑 실패·라이브 미조회)은
  // 열화 상태이므로 캐시하면 TTL 동안 빈 박스가 고정된다 — 위 emptyResponse 반환들과
  // 동일하게 no-store 로 둠(fail-close).
  return NextResponse.json(response, {
    headers: liveCacheHeaders(!empty, LIVE_LIST_EDGE_TTL_SECONDS),
  });
}
