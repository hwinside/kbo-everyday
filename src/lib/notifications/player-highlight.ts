import { randomUUID } from "node:crypto";
import { sendFcmToTokens } from "@/lib/notifications/fcm";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { teamIdByShortName } from "@/lib/notifications/game-status";
import { resolvePhantomSingle, inheritHitRbi } from "@/lib/notifications/score-dedupe";
import { resolvePlayer, resolveUniquePlayerByName } from "@/lib/utils/resolve-player";
import { isAllStarGameId } from "@/lib/constants/teams";
import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";
import type { KboRawGame } from "@/types/api";
import type { GameEvent, GameEventType } from "@/types/game-events";
import {
  drainDueHighlightSnapshots,
  mapHighlightSettlements,
  shouldProcessHighlightEvent,
  type ClaimedHighlightToken,
} from "@/lib/notifications/player-highlight-delivery";

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

// freshness 컷오프 (삼순 #274 NO-GO 패턴): 신규 dedup namespace에 진입하는 이벤트는
// 배포/활성화 직후 warmup이 넘기는 *전체 경기 history*의 과거분이 한꺼번에 claim·발송되는
// backlog 플러시 위험이 있다(#271 inning-summary와 동일). 적용 대상:
//  - at_bat_strikeout(#fav-so, 기본 on)
//  - 모든 타자 활약(#fav): token별 dedup 원장으로 전환되어 기존 global event claim을
//    재사용할 수 없으므로 장타까지 포함해야 배포 중 진행 경기의 과거분 재발송을 막는다.
// 매분 cron이 갓 잡힌 이벤트를 1~2분 내 처리하고 start pending은 90초 안에 종결되므로
// FRESH_MS(10분) 밖은 skip한다.
const FRESH_MS = 10 * 60 * 1000;

// 2026 올스타 참가선수 중 우리 로스터에 동명이인이 있어 이름만으로 특정 불가한 선수 →
// 발표 명단(KBO 크보라이브 2026-06-29)의 소속팀 기준 kboId를 확정해 정확 발송.
// (이름 유일 매칭만으론 이 2명은 skip돼 알림 누락.) 나머지 참가자는 유일 매칭으로 커버.
//   이승민: 삼성(50464)  [SSG 54806 아님] / 최원준: KT(66606)  [두산 67263 아님]
const ALLSTAR_2026_DUP_KBOID: Record<string, string> = {
  이승민: "50464",
  최원준: "66606",
};

type DurableHighlightSnapshot = {
  eventId: string;
  gameId: string;
  playerId: string;
  prefKey: "fav_player_highlight" | "fav_player_strikeout";
  startTeamIds: number[];
  title: string;
  body: string;
  url: string;
  snapshotCompleted: boolean;
};

async function drainHighlightSnapshot(
  snapshot: DurableHighlightSnapshot,
  userIds: string[],
  startAcceptedBeforeMs: number,
  deadlineAtMs?: number,
): Promise<number> {
  let acceptedTotal = 0;
  let firstClaim = true;

  while (deadlineAtMs == null || Date.now() < deadlineAtMs) {
    const leaseToken = randomUUID();
    // 한 RPC transaction에서 audience 전체 insert + snapshot 완료를 함께 수행한다.
    // worker crash는 transaction 전체 rollback이고, incomplete row는 playerId로 audience를
    // 다시 전량 열거하므로 일부 chunk만 completed로 굳는 창이 없다.
    // query-guard: bounded -- SQL이 반환 claim을 p_limit 최대 500행으로 clamp한다.
    const { data, error } = await supabase.rpc("claim_player_highlight_tokens", {
      p_event_id: snapshot.eventId,
      p_game_id: snapshot.gameId,
      p_player_id: snapshot.playerId,
      p_start_team_ids: snapshot.startTeamIds,
      p_user_ids: firstClaim ? userIds : [],
      p_pref_key: snapshot.prefKey,
      p_push_title: snapshot.title,
      p_push_body: snapshot.body,
      p_push_url: snapshot.url,
      p_finalize_snapshot: true,
      p_start_accepted_before: new Date(startAcceptedBeforeMs).toISOString(),
      p_lease_token: leaseToken,
      p_lease_seconds: 20,
      p_limit: 500,
    });
    if (error) throw new Error(`highlight token barrier: ${error.message}`);
    firstClaim = false;

    const claimedTokens: ClaimedHighlightToken[] = [];
    for (const row of data ?? []) {
      const claimed = row as { token_id?: number; token_hash?: string; fcm_token?: string };
      if (claimed.token_id != null && claimed.token_hash && claimed.fcm_token) {
        claimedTokens.push({
          tokenId: claimed.token_id,
          tokenHash: claimed.token_hash,
          fcmToken: claimed.fcm_token,
        });
      }
    }
    if (claimedTokens.length === 0) break;

    const transportDeadlineAtMs = Math.min(
      deadlineAtMs ?? Date.now() + 8_000,
      Date.now() + 8_000,
    );
    const res = await sendFcmToTokens(claimedTokens.map((row) => row.fcmToken), {
      title: snapshot.title,
      body: snapshot.body,
      url: snapshot.url,
    }, { deadlineAtMs: transportDeadlineAtMs });
    const settleResults = mapHighlightSettlements(
      claimedTokens,
      res.outcomes ?? [],
      res.lastError ?? null,
    );
    // query-guard: bounded -- claim RPC 최대 500행의 token별 FCM 결과를 단일 settle한다.
    const { data: accepted, error: settleError } = await supabase.rpc(
      "settle_player_highlight_tokens",
      { p_results: settleResults, p_lease_token: leaseToken },
    );
    if (settleError) throw new Error(`highlight token settle: ${settleError.message}`);
    acceptedTotal += Number(accepted ?? 0);
    if (claimedTokens.length < 500) break;
  }

  return acceptedTotal;
}

export async function notifyPlayerHighlights(
  games: KboRawGame[],
  eventsByGame: Map<string, GameEvent[]>,
  opts?: {
    /** 현재 nominal minute 시작. 이 bucket 안에서 accepted된 start는 다음 minute까지 release 금지. */
    startAcceptedBeforeMs?: number;
    /** 이 시각 이후 새 FCM transport를 시작하지 않는다. */
    deadlineAtMs?: number;
  },
): Promise<{ highlighted: number }> {
  let highlighted = 0;
  const startAcceptedBeforeMs = opts?.startAcceptedBeforeMs ?? Date.now();
  const gameById = new Map(games.map((g) => [g.G_ID, g]));

  for (const [gameId, events] of eventsByGame) {
    const g = gameById.get(gameId);
    if (!g || isKboGameCancelled(g.CANCEL_SC_ID)) continue;
    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const startTeamIds = [teamIdByShortName(away), teamIdByShortName(home)]
      .filter((id): id is number => id !== null);
    const url = `/games/${gameId}`;
    // 올스타전 여부 — 선수 resolve 방식(이름 유일 매칭)과 [올스타전] 알림 태그에 사용.
    const isAllStar = isAllStarGameId(gameId);

    for (const ev of events) {
      // 타자 장타/홈런 → 활약 알림(타자 최애 팬, fav_player_highlight) /
      // 삼진 → 삼진 알림(투수 최애 팬, fav_player_strikeout). 그 외 이벤트는 skip.
      const isStrikeout = ev.type === "at_bat_strikeout";
      if (!HIGHLIGHT_TYPES.has(ev.type) && !isStrikeout) continue;

      // token별 dedup namespace 배포 전/이전 이닝의 과거분 skip → backlog 일괄 발송 방지.
      const evMs = Date.parse(ev.timestamp);

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
      // 올스타전은 게임 팀이 나눔/드림(101/102)이라 teamId로 선수 특정 불가 →
      // ① 동명이인 참가선수는 발표명단 기준 override로 정확 발송, ② 그 외는 이름 유일
      // 매칭(동명이인 2+·미등록 0이면 skip)해 오발송 방지. 정규경기는 기존 teamId 경로.
      const teamId = isAllStar
        ? null
        : teamIdByShortName(isStrikeout ? (ev.isTop ? home : away) : (ev.isTop ? away : home));
      if (!isAllStar && teamId === null) continue;
      const resolved = isAllStar
        ? (ALLSTAR_2026_DUP_KBOID[playerName]
            ? resolvePlayer({ kboId: ALLSTAR_2026_DUP_KBOID[playerName] })
            : resolveUniquePlayerByName(playerName))
        : resolvePlayer(
            { name: playerName, teamId: teamId as number },
            undefined,
            { context: isStrikeout ? "push:fav-strikeout" : "push:fav-highlight" },
          );
      if (!resolved) continue;

      const dedupId = isStrikeout ? `${ev.id}#fav-so` : `${ev.id}#fav`;
      if (phantom === "suppress") continue;

      // query-guard: bounded -- player highlight event PK 단일행 조회. freshness는 신규 snapshot에만
      // 적용하고 기존 frozen snapshot은 10분 source-event cutoff 이후에도 deadline까지 drain한다.
      const { data: existingSnapshot, error: snapshotError } = await supabase
        .from("player_highlight_event_snapshots")
        .select("snapshot_completed")
        .eq("event_id", dedupId)
        .maybeSingle();
      if (snapshotError) continue;
      const hasFrozenSnapshot = existingSnapshot != null;
      const snapshotCompleted = Boolean(existingSnapshot?.snapshot_completed);
      if (!shouldProcessHighlightEvent({
        eventAtMs: evMs,
        nowMs: Date.now(),
        freshnessMs: FRESH_MS,
        hasFrozenSnapshot,
      })) continue;

      // 이 선수를 최애선수로 둔 유저 (favorite_players: [{playerId: kboId}])
      let userIds: string[] = [];
      if (!snapshotCompleted) {
        try {
          userIds = await fetchFavoritePlayerFanIds(resolved.kboId, {
            deadlineAtMs: opts?.deadlineAtMs,
          });
        } catch {
          continue;
        }
      }
      // 타점(detail.rbi)이 있으면 "{라벨}{으로/로} N타점 획득!", 0타점이면 "{라벨}!" (하린아빠 확정)
      const label = HIGHLIGHT_LABEL[ev.type] ?? "활약";
      // 홈런/장타가 교차폴링으로 자기 rbi 0이면 유령 단타의 타점을 물려받아 "홈런으로 N타점"으로 합침.
      const rbi = ev.type === "at_bat_hit" ? (ev.detail?.rbi ?? 0) : inheritHitRbi(ev, events);
      // 만루홈런 → "그랜드슬램" 강조 표기 (하린아빠 요청 2026-06-27, 삼순 확정).
      // 가드 = at_bat_homerun 타입 + rbi===4. 홈런 rbi 최대 4(만루)라 홈런에선 4 ⟺ 그랜드슬램.
      // 4타점 단독으로 판정 안 함 — 비홈런 4타점(예: 만루 적시 장타) 오탐은 타입 가드가 차단한다.
      const isGrandSlam = ev.type === "at_bat_homerun" && rbi === 4;
      const baseTitle = isStrikeout
        ? `⚾ ${resolved.name} 삼진!`
        : isGrandSlam
          ? `⚾ ${resolved.name} 그랜드슬램! 💥 (4타점)`
          : rbi > 0
            ? `⚾ ${resolved.name} ${label}${HIGHLIGHT_PARTICLE[ev.type] ?? "로"} ${rbi}타점 획득!`
            : `⚾ ${resolved.name} ${label}!`;
      // 올스타전 알림은 [올스타전] 태그 prefix (하린아빠 지시 2026-07-11).
      const title = isAllStar ? `[올스타전] ${baseTitle}` : baseTitle;
      const prefKey = isStrikeout ? "fav_player_strikeout" : "fav_player_highlight";
      highlighted += await drainHighlightSnapshot({
        eventId: dedupId,
        gameId,
        playerId: resolved.kboId,
        prefKey,
        startTeamIds,
        title,
        body: `${away} vs ${home}`,
        url,
        snapshotCompleted,
      }, userIds, startAcceptedBeforeMs, opts?.deadlineAtMs);
    }
  }

  // source-independent drain: 경기가 final이 되거나 eventsByGame이 비어도 frozen payload로
  // incomplete snapshot resume, transient retry, deadline terminalization을 계속한다.
  // query-guard: bounded -- RPC가 현재 claim 가능하거나 incomplete인 snapshot만 최대 50개 반환한다.
  const { data: dueSnapshots, error: dueError } = await supabase.rpc(
    "list_due_player_highlight_snapshots",
    {
      p_limit: 50,
      p_start_accepted_before: new Date(startAcceptedBeforeMs).toISOString(),
    },
  );
  if (dueError) throw new Error(`highlight due snapshots: ${dueError.message}`);
  type DueSnapshot = {
    event_id: string;
    game_id: string;
    player_id: string;
    pref_key: "fav_player_highlight" | "fav_player_strikeout";
    start_team_ids: number[];
    push_title: string;
    push_body: string;
    push_url: string;
    snapshot_completed: boolean;
  };
  highlighted += await drainDueHighlightSnapshots({
    snapshots: (dueSnapshots ?? []) as DueSnapshot[],
    needsAudience: (due) => !due.snapshot_completed,
    fetchAudience: (due, deadlineAtMs) => fetchFavoritePlayerFanIds(
      due.player_id,
      { deadlineAtMs },
    ),
    drain: (due, userIds) => drainHighlightSnapshot({
      eventId: due.event_id,
      gameId: due.game_id,
      playerId: due.player_id,
      prefKey: due.pref_key,
      startTeamIds: due.start_team_ids,
      title: due.push_title,
      body: due.push_body,
      url: due.push_url,
      snapshotCompleted: due.snapshot_completed,
    }, userIds, startAcceptedBeforeMs, opts?.deadlineAtMs),
    deadlineAtMs: opts?.deadlineAtMs,
  });

  return { highlighted };
}
