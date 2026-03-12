/**
 * Event Text Builder — GameEvent → Korean text with emoji
 */

import type { GameEvent } from "@/types/game-events";

function inningLabel(inning: number, isTop: boolean): string {
  return `${inning}회${isTop ? "초" : "말"}`;
}

export function buildEventText(event: GameEvent): string {
  const { type, detail, inning, isTop } = event;

  switch (type) {
    case "game_start":
      return "🟢 경기 시작";

    case "game_end":
      return `🏁 경기 종료 (${event.snapshot.awayScore}:${event.snapshot.homeScore})`;

    case "inning_start":
      return `⚾ ${inningLabel(detail.inning ?? inning, detail.isTop ?? isTop)} 시작`;

    case "inning_end":
      return `📋 ${inningLabel(detail.inning ?? inning, detail.isTop ?? isTop)} 종료`;

    case "at_bat_hit":
      return detail.batter
        ? `🔵 ${detail.batter} 안타!`
        : "🔵 안타!";

    case "at_bat_homerun":
      return detail.batter
        ? `⚡ ${detail.batter} 홈런!`
        : "⚡ 홈런!";

    case "at_bat_strikeout":
      return detail.batter
        ? `🔴 ${detail.batter} 삼진 아웃 (${event.snapshot.outs}아웃)`
        : `🔴 삼진 아웃 (${event.snapshot.outs}아웃)`;

    case "at_bat_walk":
      return detail.batter
        ? `🟡 ${detail.batter} 볼넷`
        : "🟡 볼넷";

    case "at_bat_out":
      return detail.batter
        ? `🔴 ${detail.batter} 아웃 (${event.snapshot.outs}아웃)`
        : `🔴 아웃 (${event.snapshot.outs}아웃)`;

    case "run_scored": {
      const runs = detail.rbi ?? 1;
      return `🎉 ${runs}점 득점! (${event.snapshot.awayScore}:${event.snapshot.homeScore})`;
    }

    case "pitching_change":
      return detail.playerOut && detail.playerIn
        ? `🔄 투수 교체: ${detail.playerOut} → ${detail.playerIn}`
        : `🔄 투수 교체: ${detail.playerIn || "새 투수"}`;

    case "info":
      return detail.message || "ℹ️ 정보";

    default:
      return "⚾";
  }
}
