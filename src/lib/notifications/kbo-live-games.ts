import type { KboRawGame } from "@/types/api";
import { runBeforeDeadline } from "@/lib/async-deadline";
import { parseKboGameListPayload } from "@/lib/notifications/widget-fast-loop";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { naverGameId } from "@/lib/crawler/naver-record";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_PRIMARY_BUDGET_MS = 1_500;

type LiveGamesSource = "kbo" | "naver";

type NaverLiveEvidence = {
  hasRealPlay: boolean;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
};

type NaverLiveEvidenceFetcher = (
  gameId: string,
  signal: AbortSignal,
) => Promise<NaverLiveEvidence>;

function safeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Naver schedule의 STARTED는 첫 투구 전에도 1회초 0:0으로 바뀐다.
 * relay에 실제 투구 식별자/투구번호가 생긴 뒤에만 downstream live로 노출한다.
 */
export async function fetchNaverLiveEvidence(
  gameId: string,
  signal: AbortSignal,
): Promise<NaverLiveEvidence> {
  const response = await fetch(
    `https://api-gw.sports.naver.com/schedule/games/${naverGameId(gameId)}/relay?inning=1`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok) throw new Error(`Naver relay HTTP ${response.status}`);
  const json = await response.json();
  const relays = Array.isArray(json?.result?.textRelayData?.textRelays)
    ? json.result.textRelayData.textRelays
    : [];
  const options = relays.flatMap((relay: { textOptions?: unknown[] }) =>
    Array.isArray(relay?.textOptions) ? relay.textOptions : []
  ) as Array<{
    seqno?: number;
    pitchNum?: number;
    ptsPitchId?: string;
    currentGameState?: Record<string, unknown>;
  }>;
  const actualPlay = options
    .filter((option) => (
      (typeof option.pitchNum === "number" && option.pitchNum > 0)
      || (typeof option.ptsPitchId === "string" && option.ptsPitchId.length > 0)
    ))
    .sort((a, b) => (b.seqno ?? 0) - (a.seqno ?? 0));
  const state = actualPlay[0]?.currentGameState ?? {};
  return {
    hasRealPlay: actualPlay.length > 0,
    balls: safeCount(state.ball),
    strikes: safeCount(state.strike),
    outs: safeCount(state.out),
    runner1b: safeCount(state.base1) > 0,
    runner2b: safeCount(state.base2) > 0,
    runner3b: safeCount(state.base3) > 0,
  };
}

function hasSchedulePlayEvidence(game: KboGame): boolean {
  if (game.status !== "live") return true;
  return (
    game.inning > 1
    || !game.isTop
    || (game.awayScore ?? 0) > 0
    || (game.homeScore ?? 0) > 0
  );
}

export function naverGameToRaw(game: KboGame): KboRawGame {
  const state = game.status === "live"
    ? "2"
    : game.status === "final"
      ? "3"
      : game.status === "cancelled"
        ? "4"
        : "1";
  return {
    G_ID: game.gameId,
    G_DT: game.date,
    G_TM: game.time,
    S_NM: game.stadium,
    AWAY_ID: game.gameId.slice(8, 10),
    HOME_ID: game.gameId.slice(10, 12),
    AWAY_NM: game.awayName,
    HOME_NM: game.homeName,
    T_SCORE_CN: game.awayScore == null ? "" : String(game.awayScore),
    B_SCORE_CN: game.homeScore == null ? "" : String(game.homeScore),
    GAME_INN_NO: game.inning,
    GAME_TB_SC: game.isTop ? "T" : "B",
    GAME_STATE_SC: state,
    CANCEL_SC_ID: game.status === "cancelled" ? "1" : "0",
    T_PIT_P_NM: game.awayStarterName,
    B_PIT_P_NM: game.homeStarterName,
    W_PIT_P_NM: game.winPitcher,
    L_PIT_P_NM: game.losePitcher,
    SV_PIT_P_NM: game.savePitcher,
    STRIKE_CN: game.strikes,
    BALL_CN: game.balls,
    OUT_CN: game.outs,
    B1_BAT_ORDER_NO: game.runnersOn.first ? 1 : 0,
    B2_BAT_ORDER_NO: game.runnersOn.second ? 1 : 0,
    B3_BAT_ORDER_NO: game.runnersOn.third ? 1 : 0,
    B_P_NM: game.isTop ? game.currentPitcher : game.currentBatter,
    T_P_NM: game.isTop ? game.currentBatter : game.currentPitcher,
    T_RANK_NO: game.awayRank,
    B_RANK_NO: game.homeRank,
  };
}

/**
 * 서버 알림/Live Activity용 라이브 스코어보드.
 * KBO를 짧게 시도한 뒤 HTTP/network/schema 실패면 남은 deadline 안에서 Naver로
 * failover한다. 두 소스 모두 실패한 ok:false는 정상 "경기 0"과 구분한다.
 */
export async function fetchKboLiveGames(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
  fetchNaverImpl: typeof fetchNaverGames = fetchNaverGames,
  fetchNaverEvidenceImpl: NaverLiveEvidenceFetcher = fetchNaverLiveEvidence,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: { source: LiveGamesSource; sourceAtMs: number; fetchedAtMs: number };
}> {
  const sourceAtMs = Date.now();
  try {
    const kboDeadlineAtMs = Math.min(
      deadlineAtMs ?? Date.now() + KBO_PRIMARY_BUDGET_MS,
      Date.now() + KBO_PRIMARY_BUDGET_MS,
    );
    const remainingMs = kboDeadlineAtMs - Date.now();
    const response = await runBeforeDeadline(
      () => fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
        },
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      }),
      kboDeadlineAtMs,
    );
    if (response.ok) {
      const json = await runBeforeDeadline(() => response.json(), kboDeadlineAtMs).catch(() => null);
      const games = parseKboGameListPayload(json);
      const fetchedAtMs = Date.now();
      if (games !== null) {
        return { ok: true, games, trace: { source: "kbo", sourceAtMs, fetchedAtMs } };
      }
    }
  } catch {
    // Naver failover below.
  }

  try {
    const remainingMs = (deadlineAtMs ?? Date.now() + 5_000) - Date.now();
    if (remainingMs <= 0) throw new Error("live_games_deadline_exceeded");
    const games = await fetchNaverImpl(date, undefined, {
      signal: AbortSignal.timeout(remainingMs),
    });
    const verifiedGames = await Promise.all(games.map(async (game) => {
      if (game.status !== "live" || hasSchedulePlayEvidence(game)) return game;
      const evidenceRemainingMs = (deadlineAtMs ?? Date.now() + 5_000) - Date.now();
      if (evidenceRemainingMs <= 0) return { ...game, status: "scheduled" as const };
      try {
        const evidence = await fetchNaverEvidenceImpl(
          game.gameId,
          AbortSignal.timeout(evidenceRemainingMs),
        );
        if (!evidence.hasRealPlay) return { ...game, status: "scheduled" as const };
        return {
          ...game,
          balls: evidence.balls,
          strikes: evidence.strikes,
          outs: evidence.outs,
          runnersOn: {
            first: evidence.runner1b,
            second: evidence.runner2b,
            third: evidence.runner3b,
          },
        };
      } catch {
        return { ...game, status: "scheduled" as const };
      }
    }));
    return {
      ok: true,
      games: verifiedGames.map(naverGameToRaw),
      trace: { source: "naver", sourceAtMs, fetchedAtMs: Date.now() },
    };
  } catch {
    return {
      ok: false,
      games: [],
      trace: { source: "kbo", sourceAtMs, fetchedAtMs: Date.now() },
    };
  }
}
