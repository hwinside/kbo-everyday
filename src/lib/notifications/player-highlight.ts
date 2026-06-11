import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { teamIdByShortName } from "@/lib/notifications/game-status";
import { claimEvent, unclaimEvent } from "@/lib/notifications/game-score";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import type { KboRawGame } from "@/types/api";
import type { GameEvent, GameEventType } from "@/types/game-events";

// 최애선수 활약(타자) 알림 (push-notifications-v1 S5b).
// warmup cron이 game-events에서 받는 장타/홈런 이벤트의 타자를 최애선수로 둔
// 유저에게 발송. 내 팀 득점(S5a)과 같은 cron·이벤트 소스지만 대상/메시지가 다름.
//
//  - batter(KBO 원본 이름) + 공격팀 teamId → resolvePlayer로 canonical kboId.
//    동명이인 27그룹이 있어 이름 단독키 불가 → teamId로 구분(SSOT resolve-player).
//  - dedup = notified_score_events 재사용하되 event_id에 "#fav" suffix —
//    같은 홈런 이벤트라도 "내 팀 득점"(S5a)과 별개 키라 둘 다 독립 발송.
//    (대상도 보통 다름: 팀팬 vs 선수팬. 한 유저가 둘 다면 토글로 각각 제어)
const HIGHLIGHT_TYPES = new Set<GameEventType>(["at_bat_homerun", "at_bat_triple", "at_bat_double"]);

const HIGHLIGHT_LABEL: Partial<Record<GameEventType, string>> = {
  at_bat_homerun: "홈런",
  at_bat_triple: "3루타",
  at_bat_double: "2루타",
};

export async function notifyPlayerHighlights(
  games: KboRawGame[],
  eventsByGame: Map<string, GameEvent[]>,
): Promise<{ highlighted: number }> {
  let highlighted = 0;
  const gameById = new Map(games.map((g) => [g.G_ID, g]));

  for (const [gameId, events] of eventsByGame) {
    const g = gameById.get(gameId);
    if (!g || g.CANCEL_SC_ID !== "0") continue;
    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const url = `/games/${gameId}`;

    for (const ev of events) {
      if (!HIGHLIGHT_TYPES.has(ev.type)) continue;
      const batter = ev.detail?.batter;
      if (!batter) continue;

      // 타자 소속팀 = 공격팀(isTop이면 원정). 동명이인은 teamId로 구분.
      const teamId = teamIdByShortName(ev.isTop ? away : home);
      if (teamId === null) continue;
      const resolved = resolvePlayer({ name: batter, teamId }, undefined, { context: "push:fav-highlight" });
      if (!resolved) continue;

      // dedup 키 선점을 팬 조회 *전*에 먼저 — 이벤트 발생 당시 기준으로 마킹해야
      // 경기 중 누가 그 선수를 최애로 추가해도 과거 장타/홈런 알림이 뒤늦게 안 감
      // (삼순 #214-③). S4/S5a의 "대상 0명도 마킹 유지" 원칙과 일치.
      const dedupId = `${ev.id}#fav`;
      if (!(await claimEvent(dedupId, gameId))) continue; // 이미 발송됨/보류

      // 이 선수를 최애선수로 둔 유저 (favorite_players: [{playerId: kboId}])
      const { data: fansData, error } = await supabase
        .from("profiles")
        .select("id")
        .contains("favorite_players", JSON.stringify([{ playerId: resolved.kboId }]));
      if (error) { await unclaimEvent(dedupId); continue; } // 조회 실패 → 선점 해제 후 재시도
      const userIds = (fansData ?? []).map((r: { id: string }) => r.id);
      if (userIds.length === 0) continue; // 최애로 둔 유저 없음 — claim 유지(과거 알림 방지)

      const label = HIGHLIGHT_LABEL[ev.type] ?? "활약";
      const res = await sendFcmToUsers(userIds, {
        title: `⚾ ${resolved.name} ${label}!`,
        body: `${away} vs ${home}`,
        url,
      }, "fav_player_highlight");
      if (!res.ok) { await unclaimEvent(dedupId); continue; } // 인프라 실패 → 재시도
      highlighted += res.sent;
    }
  }

  return { highlighted };
}
