/**
 * Relay Event Generator — 네이버 문자중계 → GameEvent 브릿지
 *
 * Cross-source dedupe contract
 * ----------------------------
 * Mints *exactly the same id* as event-generator.ts does for the
 * corresponding BoxScore-diff event, so useCelebration's module-level
 * `displayedEventIds` suppresses whichever source arrives second:
 *
 *   id = `${gameId}-${type}-${inningKey}-${normalizedBatter}-${cumIdx}`
 *
 * `cumIdx` is the 1-based count of (inning, side, batter, type) occurrences
 * in the play sequence. The BoxScore-diff path computes the same idx from
 * `prev{Hits|Hr|H2b|H3b|Bb|So}` deltas — the same plate appearance lands
 * on the same id regardless of which path observes it first.
 *
 * normalizeBatterName is symmetric — event-generator.ts calls the same
 * wrapper at the diff site so the two paths agree on whitespace-normalized
 * batter strings (외국인 선수 "엘리엇 어슨" / "엘리엇어슨" 변종 흡수).
 *
 * XBH monotonic clamp (PR #88 회귀 방어) is *implicit* here: relay reports
 * plays as discrete events in chronological order; a "1루타" line cannot
 * retroactively become a "2루타" within a single play row. If Naver later
 * issues a correction it would mint a new play with new idx — matches the
 * BoxScore path's at_bat_hit-...-N behavior (no negative-idx events).
 */
import type { GameEvent, GameEventType } from "@/types/game-events";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { InningRelay, PlayEvent } from "@/app/api/game-relay/route";
import { buildEventText } from "@/lib/event-text-builder";

export function inningKey(inning: number, isTop: boolean): string {
  return `${inning}-${isTop ? "T" : "B"}`;
}

/**
 * Symmetric batter-name normalization. Called by BOTH relay generator and
 * BoxScore-diff generator (event-generator.ts) at the dedupe-key site so that
 * a name with whitespace variants ("엘리엇 어슨" vs "엘리엇어슨") collapses to
 * the same key. Displayed text uses the raw name; only the id encoding is
 * normalized.
 */
export function normalizeBatterName(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, "").trim();
}

/** Relay PlayEvent.type === "hit"는 1루타/2루타/3루타/홈런 모두 포함.
 *  result 텍스트 substring으로 다시 분류. 일치 우선순위: HR > 3B > 2B > 1B. */
function classifyHit(resultText: string): "homerun" | "triple" | "double" | "single" {
  if (resultText.includes("홈런")) return "homerun";
  if (resultText.includes("3루타")) return "triple";
  if (resultText.includes("2루타")) return "double";
  return "single";
}

function playToType(play: PlayEvent): GameEventType | null {
  switch (play.type) {
    case "homerun":
      return "at_bat_homerun";
    case "walk":
      return "at_bat_walk";
    case "strikeout":
      return "at_bat_strikeout";
    case "hit": {
      const sub = classifyHit(play.result);
      if (sub === "homerun") return "at_bat_homerun";
      if (sub === "triple") return "at_bat_triple";
      if (sub === "double") return "at_bat_double";
      return "at_bat_hit";
    }
    // out / sacrifice / error / hbp / other → 세레머니 미지원 (BoxScore 경로와 동일)
    default:
      return null;
  }
}

/**
 * Generate celebration-bound GameEvent[] from Naver relay innings.
 *
 * Idempotent — every call mints the same id for the same play. Repeated polls
 * are dedupe-suppressed downstream in useCelebration (seenRef +
 * displayedEventIds module-level Set).
 */
export function generateRelayEvents(
  gameId: string,
  innings: readonly InningRelay[] | undefined,
  liveSnapshot: LiveGameData | null,
): GameEvent[] {
  if (!innings || innings.length === 0) return [];

  const events: GameEvent[] = [];
  /** (batterNorm, type) → GAME-WIDE cum count. Must match event-generator.ts
   *  which derives idx from `prev{Hr|H3b|H2b|Singles|Bb|So}` — those are the
   *  batter's cumulative game-wide stats, NOT per-inning. A per-inning cumKey
   *  would mint idx=1 for the batter's 2nd HR in a different inning while
   *  BoxScore-diff mints idx=2, breaking cross-source dedupe. */
  const cumIdx = new Map<string, number>();

  for (const inning of innings) {
    const isTop = inning.half === "top";
    const sideKey = inningKey(inning.inning, isTop);

    for (const play of inning.plays) {
      const evType = playToType(play);
      if (!evType) continue;

      const batterNorm = normalizeBatterName(play.batterName);
      if (!batterNorm) continue;

      const cumKey = `${batterNorm}-${evType}`;
      const idx = (cumIdx.get(cumKey) ?? 0) + 1;
      cumIdx.set(cumKey, idx);

      // id itself encodes sideKey (matching event-generator.ts dedupe-key
      // pattern). Only the cumIdx accumulator is game-wide.
      const id = `${gameId}-${evType}-${sideKey}-${batterNorm}-${idx}`;

      const snapshot = liveSnapshot
        ? {
            awayScore: liveSnapshot.awayScore,
            homeScore: liveSnapshot.homeScore,
            balls: liveSnapshot.balls,
            strikes: liveSnapshot.strikes,
            outs: liveSnapshot.outs,
            runners: {
              first: liveSnapshot.runner1bName || null,
              second: liveSnapshot.runner2bName || null,
              third: liveSnapshot.runner3bName || null,
            },
            pitcher: liveSnapshot.currentPitcher || "",
            batter: play.batterName,
          }
        : {
            awayScore: 0,
            homeScore: 0,
            balls: 0,
            strikes: 0,
            outs: 0,
            runners: { first: null, second: null, third: null },
            pitcher: "",
            batter: play.batterName,
          };

      const event: GameEvent = {
        id,
        gameId,
        timestamp: new Date().toISOString(),
        inning: inning.inning,
        isTop,
        type: evType,
        detail: {
          batter: play.batterName,
          pitcher: liveSnapshot?.currentPitcher || undefined,
        },
        text: "",
        snapshot,
        source: "relay",
      };
      event.text = buildEventText(event);
      events.push(event);
    }
  }

  return events;
}
