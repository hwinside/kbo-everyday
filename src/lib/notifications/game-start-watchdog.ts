import type { KboRawGame } from "@/types/api";
import type { StartPlateAppearanceEvidence } from "@/lib/notifications/start-freshness-policy";

export type GameStartWatchdogState = {
  game_id: string;
  start_notified: boolean | null;
  last_seen_scheduled_at: string | null;
  start_snapshot_at: string | null;
  start_snapshot_deadline_at: string | null;
};

export type GameStartWatchdogResult = {
  scheduled: number;
  live: number;
  evidenceRequested: number;
  started: number;
};

type GameStartWatchdogDeps = {
  fetchGames: (deadlineAtMs: number) => Promise<{
    ok: boolean;
    games: KboRawGame[];
    observedAtMs: number;
  }>;
  readStartStates: (gameIds: string[], deadlineAtMs: number) => Promise<GameStartWatchdogState[]>;
  fetchStartEvidence: (
    gameIds: string[],
    deadlineAtMs: number,
  ) => Promise<ReadonlyMap<string, StartPlateAppearanceEvidence>>;
  notifyStartTransitions: (
    games: KboRawGame[],
    params: {
      observedAtMs: number;
      deadlineAtMs: number;
      startPlateAppearanceByGame: ReadonlyMap<string, StartPlateAppearanceEvidence>;
      preloadedStartStates: ReadonlyMap<string, Omit<GameStartWatchdogState, "game_id">>;
    },
  ) => Promise<{ started: number }>;
  isCancelled: (cancelCode: string | null | undefined) => boolean;
};

/**
 * 외부 스케줄러 전용 얇은 시작알림 경로.
 *
 * scheduled 관측과 live snapshot/drain만 기존 notifyGameStatusTransitions()에 넘긴다.
 * 이미 종결된 live 경기는 game-events 근거를 다시 읽지 않아 15초 watchdog의 KBO 부하를
 * 시작 전환 구간에 한정한다.
 */
export async function runGameStartWatchdog(
  deps: GameStartWatchdogDeps,
  deadlineAtMs: number,
): Promise<GameStartWatchdogResult> {
  const fetched = await deps.fetchGames(deadlineAtMs);
  if (!fetched.ok) throw new Error("kbo_fetch_failed");

  const relevant = fetched.games.filter((game) =>
    Boolean(game.G_ID)
    && !deps.isCancelled(game.CANCEL_SC_ID)
    && (game.GAME_STATE_SC === "1" || game.GAME_STATE_SC === "2"));
  const live = relevant.filter((game) => game.GAME_STATE_SC === "2");
  const liveIds = live.map((game) => game.G_ID as string);

  const states = liveIds.length > 0
    ? await deps.readStartStates(liveIds, deadlineAtMs)
    : [];
  const stateByGame = new Map(states.map((row) => [row.game_id, row]));
  const evidenceIds = liveIds.filter((gameId) => {
    const state = stateByGame.get(gameId);
    return !state?.start_notified && !state?.start_snapshot_at;
  });
  const evidence = evidenceIds.length > 0
    ? await deps.fetchStartEvidence(evidenceIds, deadlineAtMs)
    : new Map<string, StartPlateAppearanceEvidence>();

  const notified = await deps.notifyStartTransitions(relevant, {
    observedAtMs: fetched.observedAtMs,
    deadlineAtMs,
    startPlateAppearanceByGame: evidence,
    preloadedStartStates: new Map(liveIds.map((gameId) => {
      const state = stateByGame.get(gameId);
      return [gameId, state
        ? {
            start_notified: state.start_notified,
            last_seen_scheduled_at: state.last_seen_scheduled_at,
            start_snapshot_at: state.start_snapshot_at,
            start_snapshot_deadline_at: state.start_snapshot_deadline_at,
          }
        : {
            start_notified: false,
            last_seen_scheduled_at: null,
            start_snapshot_at: null,
            start_snapshot_deadline_at: null,
          }];
    })),
  });
  return {
    scheduled: relevant.length - live.length,
    live: live.length,
    evidenceRequested: evidenceIds.length,
    started: notified.started,
  };
}
