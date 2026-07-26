import { runBeforeDeadline } from "@/lib/async-deadline";
import type { StartPlateAppearanceEvidence } from "@/lib/notifications/start-freshness-policy";
import type { GameEvent } from "@/types/game-events";

export type InitialGameEventsResult = {
  gameId: string;
  ok: boolean;
  status: number;
  events: GameEvent[];
  eventCount: number | null;
  startPlateAppearance: StartPlateAppearanceEvidence | null;
};

/**
 * 경기별 self-fetch를 독립 deadline으로 격리한다. 한 경기의 KBO/DB path가 hang해도
 * 나머지 경기 결과는 같은 짧은 상한 안에 회수되어 시작알림을 열 수 있다.
 */
export async function fetchInitialGameEventsBounded(
  gameIds: string[],
  fetchOne: (gameId: string, deadlineAtMs: number) => Promise<InitialGameEventsResult>,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<InitialGameEventsResult[]> {
  return Promise.all(gameIds.map(async (gameId) => {
    const deadlineAtMs = now() + timeoutMs;
    try {
      return await runBeforeDeadline(
        () => fetchOne(gameId, deadlineAtMs),
        deadlineAtMs,
        now,
      );
    } catch {
      return {
        gameId,
        ok: false,
        status: 0,
        events: [],
        eventCount: null,
        startPlateAppearance: null,
      };
    }
  }));
}
