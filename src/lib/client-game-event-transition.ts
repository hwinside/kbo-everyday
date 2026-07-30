import {
  generateEvents,
  type PrevGameState,
} from "@/lib/event-generator";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import type { GameEvent } from "@/types/game-events";

interface ClientGameEventTransitionInput {
  gameId: string;
  previous: PrevGameState | null;
  current: LiveGameData;
  boxScore: GameDetailResponse["boxScore"];
  skipNextDiff: boolean;
  visibilityState: DocumentVisibilityState;
}

interface ClientGameEventTransition {
  events: GameEvent[];
  nextState: PrevGameState | null;
  skipNextDiff: boolean;
  preserveFreshGameEnd: boolean;
  shouldProcess: boolean;
}

/**
 * 경기상세 client diff baseline 전이의 단일 구현.
 * hidden 중에는 visible 세션의 baseline을 보존하고, 복귀 첫 live→final만
 * baseline skip에서 제외해 game_end/victory를 정확히 한 번 전달한다.
 */
export function advanceClientGameEventTransition({
  gameId,
  previous,
  current,
  boxScore,
  skipNextDiff,
  visibilityState,
}: ClientGameEventTransitionInput): ClientGameEventTransition {
  if (visibilityState === "hidden") {
    return {
      events: [],
      nextState: previous,
      skipNextDiff,
      preserveFreshGameEnd: false,
      shouldProcess: false,
    };
  }

  let preserveFreshGameEnd = false;
  if (skipNextDiff) {
    preserveFreshGameEnd = !!previous?.live.isLive
      && !current.isLive
      && current.awayScore + current.homeScore > 0;
    if (!preserveFreshGameEnd) {
      return {
        events: [],
        nextState: { live: current, boxScore },
        skipNextDiff: false,
        preserveFreshGameEnd: false,
        shouldProcess: false,
      };
    }
  }

  const { events, nextState } = generateEvents(
    gameId,
    previous,
    current,
    boxScore,
  );
  return {
    events,
    nextState,
    skipNextDiff: false,
    preserveFreshGameEnd,
    shouldProcess: true,
  };
}
