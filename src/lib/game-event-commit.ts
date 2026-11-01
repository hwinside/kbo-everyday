import { randomUUID } from "node:crypto";
import { generateEvents, type PrevGameState } from "./event-generator";
import type { GameEvent } from "@/types/game-events";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";

export interface EventStateRow {
  updated_at?: string;
  prev_state: PrevGameState | null;
  event_history: GameEvent[] | null;
}
export interface EventStateStore {
  read(): Promise<EventStateRow | null>;
  /** Atomic comparison with its revision (legacy rows use updated_at). */
  replace(expected: EventStateRow | null, next: EventStateRow): Promise<boolean>;
}

/** Compute against the row actually committed, never append a diff from a lost race. */
export async function commitGameEventObservation(
  store: EventStateStore,
  gameId: string,
  live: LiveGameData,
  boxScore: PrevGameState["boxScore"],
  observedAt: number,
  signal: AbortSignal,
): Promise<EventStateRow> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const row = await store.read();
    const prev = row?.prev_state ?? null;
    if (prev?.observedAt !== undefined && prev.observedAt >= observedAt) return row!;
    const { events, nextState } = generateEvents(gameId, prev, live, boxScore ?? prev?.boxScore ?? null);
    if (nextState === prev) return row!;
    const history = [...(row?.event_history ?? [])];
    const ids = new Set(history.map(event => event.id));
    for (const event of events) if (!ids.has(event.id)) {
      ids.add(event.id);
      history.push(event);
    }
    const next: EventStateRow = {
      prev_state: { ...nextState, observedAt, revision: randomUUID() },
      event_history: history,
    };
    signal.throwIfAborted();
    if (await store.replace(row, next)) return next;
  }
  // Contention is not permission to fabricate a successful append.
  const latest = await store.read();
  if (!latest) throw new Error("event_state_contention");
  return latest;
}
