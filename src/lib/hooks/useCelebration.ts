"use client";

import { useState, useRef, useCallback } from "react";
import type { GameEvent } from "@/types/game-events";
import type { CelebrationEvent, CelebrationEventType } from "@/components/game/CelebrationOverlay";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { trackCelebration } from "@/lib/admin/tracker";

interface UseCelebrationOptions {
  myTeamId: number | null;
  homeTeamId: number;
  awayTeamId: number;
}

/** Look up kboId from player name + teamId */
function findKboId(name: string | undefined, teamId: number): string | undefined {
  if (!name) return undefined;
  const entry = (PLAYERS_ROSTER as { name: string; teamId: number; kboId: string }[])
    .find((p) => p.name === name && p.teamId === teamId);
  return entry?.kboId;
}

/** Map GameEventType → CelebrationEventType, null if not celebration-worthy */
function toCelebrationType(eventType: string): CelebrationEventType | null {
  switch (eventType) {
    case "at_bat_homerun": return "homerun";
    case "game_end": return "victory";
    case "at_bat_triple": return "triple";
    case "at_bat_double": return "double";
    case "at_bat_hit": return "hit";
    case "at_bat_walk": return "walk";
    case "at_bat_strikeout": return "strikeout";
    default: return null;
  }
}

export function useCelebration({ myTeamId, homeTeamId, awayTeamId }: UseCelebrationOptions) {
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<CelebrationEvent[]>([]);
  /** Track pitcher strikeout counts for "2K, 3K..." display */
  const pitcherKRef = useRef<Map<string, number>>(new Map());

  /** Process the next item in queue when current celebration ends */
  const showNext = useCallback(() => {
    setCelebration(null);
    // Slight delay before showing next queued event
    setTimeout(() => {
      const next = queueRef.current.shift();
      if (next) setCelebration(next);
    }, 300);
  }, []);

  /** Call on each gameEvents update to detect new celebration-worthy events */
  const processEvents = useCallback(
    (events: GameEvent[]) => {
      // [DEBUG] temporary — remove after verifying celebrations work
      if (!myTeamId) {
        console.warn("[celeb] myTeamId is null — skipping");
        return;
      }

      const newCelebrations: CelebrationEvent[] = [];
      let newEventCount = 0;

      for (const ev of events) {
        if (seenRef.current.has(ev.id)) continue;
        seenRef.current.add(ev.id);
        newEventCount++;

        const celebType = toCelebrationType(ev.type);
        if (!celebType) {
          console.debug("[celeb] skip non-celeb event:", ev.type, ev.id);
          continue;
        }

        // Victory event: only celebrate when my team wins
        if (celebType === "victory") {
          const awayWon = ev.snapshot.awayScore > ev.snapshot.homeScore;
          const homeWon = ev.snapshot.homeScore > ev.snapshot.awayScore;
          const winningTeamId = awayWon ? awayTeamId : homeWon ? homeTeamId : null;
          if (winningTeamId !== myTeamId) continue;

          newCelebrations.push({
            id: ev.id,
            type: celebType,
            teamId: myTeamId,
          });
          continue;
        }

        // Offense events: batting team must be my team
        // Defense events (strikeout): pitching team must be my team
        const battingTeamId = ev.isTop ? awayTeamId : homeTeamId;
        const pitchingTeamId = ev.isTop ? homeTeamId : awayTeamId;

        const isOffense = celebType !== "strikeout";
        const relevantTeamId = isOffense ? battingTeamId : pitchingTeamId;
        if (relevantTeamId !== myTeamId) {
          console.debug("[celeb] team mismatch:", celebType, "relevant:", relevantTeamId, "mine:", myTeamId, "isTop:", ev.isTop);
          continue;
        }

        // Build celebration event
        const playerName = isOffense ? ev.detail.batter : ev.detail.pitcher;
        const kboId = findKboId(playerName, relevantTeamId);

        let strikeoutCount: number | undefined;
        if (celebType === "strikeout" && ev.detail.pitcher) {
          const prev = pitcherKRef.current.get(ev.detail.pitcher) ?? 0;
          const next = prev + 1;
          pitcherKRef.current.set(ev.detail.pitcher, next);
          strikeoutCount = next;
        }

        newCelebrations.push({
          id: ev.id,
          type: celebType,
          teamId: myTeamId,
          playerName,
          kboId,
          strikeoutCount,
        });
      }

      if (newEventCount > 0) {
        console.log(`[celeb] processed ${newEventCount} new events → ${newCelebrations.length} celebrations (myTeam: ${myTeamId}, home: ${homeTeamId}, away: ${awayTeamId})`);
      }
      if (newCelebrations.length === 0) return;

      // Log each celebration trigger
      const gameId = events[0]?.gameId;
      for (const c of newCelebrations) {
        trackCelebration(c.type, gameId || "", c.teamId, c.playerName);
      }

      // If nothing showing, start first immediately
      if (!celebration && queueRef.current.length === 0) {
        setCelebration(newCelebrations.shift()!);
      }
      // Queue the rest
      queueRef.current.push(...newCelebrations);
    },
    [myTeamId, homeTeamId, awayTeamId, celebration],
  );

  return { celebration, processEvents, dismiss: showNext };
}
