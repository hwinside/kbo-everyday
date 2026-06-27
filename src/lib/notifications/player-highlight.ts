import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { teamIdByShortName } from "@/lib/notifications/game-status";
import { claimEvent, unclaimEvent } from "@/lib/notifications/game-score";
import { resolvePhantomSingle, inheritHitRbi } from "@/lib/notifications/score-dedupe";
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
// 활약 알림 대상 타석 결과. 단타(at_bat_hit)도 포함 — 하린아빠 요청(2026-06-14):
// 최애선수 안타도 받고 싶음. 장타(2루타~홈런)는 기존 prod 경로.
const HIGHLIGHT_TYPES = new Set<GameEventType>([
  "at_bat_homerun",
  "at_bat_triple",
  "at_bat_double",
  "at_bat_hit",
]);

const HIGHLIGHT_LABEL: Partial<Record<GameEventType, string>> = {
  at_bat_homerun: "홈런",
  at_bat_triple: "3루타",
  at_bat_double: "2루타",
  at_bat_hit: "안타",
};

// "{라벨}{으로/로} N타점 획득!" 의 조사. 홈런(ㄴ받침)=으로, 루타·안타(받침없음)=로.
const HIGHLIGHT_PARTICLE: Partial<Record<GameEventType, string>> = {
  at_bat_homerun: "으로",
  at_bat_triple: "로",
  at_bat_double: "로",
  at_bat_hit: "로",
};

// freshness 컷오프 (삼순 #274 NO-GO 패턴): 신규 dedup namespace에 진입하는 빈번 이벤트는
// 배포/활성화 직후 warmup이 넘기는 *전체 경기 history*의 과거분이 한꺼번에 claim·발송되는
// backlog 플러시 위험이 있다(#271 inning-summary와 동일). 적용 대상:
//  - at_bat_strikeout(#fav-so, 기본 on)
//  - at_bat_hit(#fav, 신규 추가 + 단타는 빈번) ← 없으면 배포 즉시 진행 경기의 과거 안타 일괄 발송
// 매분 cron이 갓 잡힌 이벤트를 1~2분 내 처리하므로 FRESH_MS(10분) 밖은 skip.
// 기존 장타(at_bat_double/triple/homerun, #fav)는 prod 안전성 유지 위해 컷오프 미적용.
const FRESH_MS = 10 * 60 * 1000;

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
      // 타자 장타/홈런 → 활약 알림(타자 최애 팬, fav_player_highlight) /
      // 삼진 → 삼진 알림(투수 최애 팬, fav_player_strikeout). 그 외 이벤트는 skip.
      const isStrikeout = ev.type === "at_bat_strikeout";
      if (!HIGHLIGHT_TYPES.has(ev.type) && !isStrikeout) continue;

      // 삼진·단타(신규 dedup 진입 + 빈번): 배포 전/이전 이닝의 과거분 skip → backlog
      // 일괄 발송 방지(삼순 #274 패턴). 기존 장타는 prod 안전성 위해 컷오프 미적용.
      if (isStrikeout || ev.type === "at_bat_hit") {
        const evMs = Date.parse(ev.timestamp);
        if (Number.isFinite(evMs) && Date.now() - evMs > FRESH_MS) continue;
      }

      // 교차-폴링 유령 단타: 적시(rbi>0) 단타는 H 카운트 선반영으로 생긴 홈런/장타일 수 있어
      // 한 폴링 확인한다(고객 2026-06-27 오스틴 만루홈런 "안타로 4타점" 오발송).
      //  - defer: 신선 + 아직 장타/홈런 미확인 → 다음 폴링 재확인(claim 안 함).
      //  - suppress: 같은 타자 장타/홈런이 잡힘 → 그 알림이 타점 물려받아 대체(claim 후 미발송).
      const phantom = ev.type === "at_bat_hit"
        ? resolvePhantomSingle(ev, events, Date.now())
        : "send";
      if (phantom === "defer") continue;

      // 대상 선수: 활약=타자(공격팀, isTop이면 원정) / 삼진=투수(수비팀, isTop이면 홈).
      // 동명이인 27그룹 → teamId로 구분(SSOT resolve-player). at_bat_strikeout의
      // detail.pitcher = 삼진 잡은 투수.
      const playerName = isStrikeout ? ev.detail?.pitcher : ev.detail?.batter;
      if (!playerName) continue;
      const teamId = teamIdByShortName(isStrikeout ? (ev.isTop ? home : away) : (ev.isTop ? away : home));
      if (teamId === null) continue;
      const resolved = resolvePlayer(
        { name: playerName, teamId },
        undefined,
        { context: isStrikeout ? "push:fav-strikeout" : "push:fav-highlight" },
      );
      if (!resolved) continue;

      // dedup 키 선점을 팬 조회 *전*에 먼저 — 이벤트 발생 당시 기준으로 마킹해야
      // 경기 중 누가 그 선수를 최애로 추가해도 과거 알림이 뒤늦게 안 감(삼순 #214-③).
      // 활약/삼진은 별개 타입이라 suffix로 키 분리.
      const dedupId = isStrikeout ? `${ev.id}#fav-so` : `${ev.id}#fav`;
      if (!(await claimEvent(dedupId, gameId))) continue; // 이미 발송됨/보류
      if (phantom === "suppress") continue; // 유령 단타 — 같은 타석 홈런/장타 알림이 대체(claim으로 종결)

      // 이 선수를 최애선수로 둔 유저 (favorite_players: [{playerId: kboId}])
      const { data: fansData, error } = await supabase
        .from("profiles")
        .select("id")
        .contains("favorite_players", JSON.stringify([{ playerId: resolved.kboId }]));
      if (error) { await unclaimEvent(dedupId); continue; } // 조회 실패 → 선점 해제 후 재시도
      const userIds = (fansData ?? []).map((r: { id: string }) => r.id);
      if (userIds.length === 0) continue; // 최애로 둔 유저 없음 — claim 유지(과거 알림 방지)

      // 타점(detail.rbi)이 있으면 "{라벨}{으로/로} N타점 획득!", 0타점이면 "{라벨}!" (하린아빠 확정)
      const label = HIGHLIGHT_LABEL[ev.type] ?? "활약";
      // 홈런/장타가 교차폴링으로 자기 rbi 0이면 유령 단타의 타점을 물려받아 "홈런으로 N타점"으로 합침.
      const rbi = ev.type === "at_bat_hit" ? (ev.detail?.rbi ?? 0) : inheritHitRbi(ev, events);
      // 만루홈런(홈런 4타점) → "그랜드슬램" 강조 표기 (하린아빠 요청 2026-06-27). 홈런 rbi는
      // 최대 4(만루)라 rbi===4 ⟺ 그랜드슬램 (단타 최대 3타점이라 inheritHitRbi 오귀속 불가).
      const isGrandSlam = ev.type === "at_bat_homerun" && rbi === 4;
      const title = isStrikeout
        ? `⚾ ${resolved.name} 삼진!`
        : isGrandSlam
          ? `⚾ ${resolved.name} 그랜드슬램! 💥 (4타점)`
          : rbi > 0
            ? `⚾ ${resolved.name} ${label}${HIGHLIGHT_PARTICLE[ev.type] ?? "로"} ${rbi}타점 획득!`
            : `⚾ ${resolved.name} ${label}!`;
      const res = await sendFcmToUsers(userIds, {
        title,
        body: `${away} vs ${home}`,
        url,
      }, isStrikeout ? "fav_player_strikeout" : "fav_player_highlight");
      if (!res.ok) { await unclaimEvent(dedupId); continue; } // 인프라 실패 → 재시도
      highlighted += res.sent;
    }
  }

  return { highlighted };
}
