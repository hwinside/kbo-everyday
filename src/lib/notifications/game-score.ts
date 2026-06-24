import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { teamIdByShortName, fansOfTeams } from "@/lib/notifications/game-status";
import { isHomerunCoveredRun } from "@/lib/notifications/score-dedupe";
import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";

// 내 팀 득점 알림 (push-notifications-v1 S5a).
// warmup cron이 game-events에서 받은 득점 이벤트를 보고, 득점팀(공격팀)을
// 최애팀으로 둔 유저에게 발송. 중복 발화 방지 = notified_score_events(event_id PK).
//
// 트리거 = run_scored + at_bat_homerun 두 종류:
//  - run_scored: event-generator가 점수 증가분(홈런 제외)을 묶어 emit. id가
//    `${away}-${home}` 점수상태 단위라 다중 인스턴스가 같은 id를 mint → race-safe.
//  - at_bat_homerun: run_scored가 홈런분을 제외하므로(event-generator L395) 솔로/
//    멀티 홈런 득점은 이 이벤트로 별도 커버. batter 포함이라 "홈런!" 강조 메시지.
// (이닝 묶음 요약 = my_team_score_inning_summary는 후속 슬라이스)
const SCORE_EVENT_TYPES = new Set<string>(["run_scored", "at_bat_homerun"]);

/**
 * event_id 선점 — 멱등 INSERT에 성공한(첫 발송) 호출만 true.
 * UNIQUE 충돌(23505) = 이미 다른 인스턴스가 발송 → false. 기타 에러도 보류(다음 cron).
 */
export async function claimEvent(eventId: string, gameId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("notified_score_events")
    .insert({ event_id: eventId, game_id: gameId })
    .select("event_id");
  if (error) return false;
  return (data ?? []).length > 0;
}

/** 발송 인프라 실패 시 선점 해제 — 다음 cron이 재시도하게 함 (game-status unclaim과 동형) */
export async function unclaimEvent(eventId: string): Promise<void> {
  const { error } = await supabase.from("notified_score_events").delete().eq("event_id", eventId);
  if (error) console.error("[game-score] unclaim failed:", error.message);
}

/**
 * 게임별 득점 이벤트를 보고 "내 팀 득점" 알림 발송.
 * warmup cron이 self-fetch한 game-events의 events 배열을 gameId별로 넘긴다.
 * 발송 실패해도 warmup 본연의 동작에 영향 없음(cron에서 try/catch).
 */
export async function notifyScoreEvents(
  games: KboRawGame[],
  eventsByGame: Map<string, GameEvent[]>,
): Promise<{ scored: number }> {
  let scored = 0;
  const gameById = new Map(games.map((g) => [g.G_ID, g]));

  for (const [gameId, events] of eventsByGame) {
    const g = gameById.get(gameId);
    if (!g || g.CANCEL_SC_ID !== "0") continue;
    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const url = `/games/${gameId}`;

    for (const ev of events) {
      if (!SCORE_EVENT_TYPES.has(ev.type)) continue;

      // 득점팀 판정. run_scored는 generator가 detail.scoringSide로 팀을 확정해줌
      // (isTop 추론은 이닝교대 lag/양팀 동시득점에 취약 — 삼순 #213-②).
      // at_bat_homerun은 batterDiff 경로라 isTop이 이미 이닝교대 보정돼 있음.
      let scoringTeamName: string;
      if (ev.type === "run_scored") {
        const side = ev.detail?.scoringSide;
        if (side !== "away" && side !== "home") continue; // scoringSide 없는 구버전 이벤트 방어
        if (isHomerunCoveredRun(ev, events)) continue; // 홈런 득점 → at_bat_homerun이 이미 푸시 (중복 방지)
        scoringTeamName = side === "away" ? away : home;
      } else {
        scoringTeamName = ev.isTop ? away : home;
      }
      const teamId = teamIdByShortName(scoringTeamName);
      if (teamId === null) continue;

      if (!(await claimEvent(ev.id, gameId))) continue; // 이미 발송됨/보류

      const fans = await fansOfTeams([teamId]);
      if (!fans.ok) { await unclaimEvent(ev.id); continue; } // 조회 실패 → 재시도

      const aS = ev.snapshot?.awayScore ?? 0;
      const hS = ev.snapshot?.homeScore ?? 0;
      const scoreLine = `${away} ${aS} : ${hS} ${home}`;
      const isHr = ev.type === "at_bat_homerun";
      const batter = ev.detail?.batter;
      const title = isHr ? `💥 ${scoringTeamName} 홈런!` : `⚾ ${scoringTeamName} 득점!`;
      const body = isHr && batter ? `${batter} · ${scoreLine}` : scoreLine;

      const res = await sendFcmToUsers(fans.ids, { title, body, url }, "my_team_score");
      if (!res.ok) { await unclaimEvent(ev.id); continue; } // 인프라 실패 → 재시도
      scored += res.sent;

      // 잠금화면 ongoing card 스코어 갱신 (C2b) — 득점팀뿐 아니라 *양팀 팬* 카드를
      // 신선화(게임 관전자 모두). data-only, fire-and-forget(득점 알림은 이미 성공이라
      // 카드 실패해도 unclaim 안 함). 시작 카드와 동일하게 game_start 옵트인 유저만.
      // 이닝 half — run_scored는 isTop이 이닝교대 lag에 취약(득점팀 판정과 동일 이유)이라
      // scoringSide로 판정(away 공격=초, home 공격=말). 홈런은 isTop이 이미 보정됨 (삼순 C2b).
      const cardHalf = ev.type === "run_scored"
        ? (ev.detail?.scoringSide === "away" ? "초" : "말")
        : (ev.isTop ? "초" : "말");
      const cardTeamIds = [teamIdByShortName(away), teamIdByShortName(home)]
        .filter((v): v is number => v !== null);
      const cardFans = await fansOfTeams(cardTeamIds);
      if (cardFans.ok && cardFans.ids.length > 0) {
        // 위젯(안드로이드)용 구조화 필드 — gameId에서 2자 팀코드 파싱(YYYYMMDD+AWAY+HOME+N).
        const codes = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
        await sendFcmToUsers(cardFans.ids, {
          title: scoreLine,
          body: `${ev.inning}회${cardHalf}`,
          url,
          dataOnly: true,
          data: {
            kind: "game_live",
            ...(codes ? { w_away: codes[1], w_home: codes[2] } : {}),
            w_as: String(aS),
            w_hs: String(hS),
            w_status: `LIVE ${ev.inning}회${cardHalf}`,
            w_stadium: g.S_NM ?? "",
          },
        }, "game_start");
      }
    }
  }

  return { scored };
}

// 안타류(이닝 안타수 집계). at_bat_out/walk/strikeout 제외.
const INNING_HIT_TYPES = new Set<string>(["at_bat_hit", "at_bat_double", "at_bat_triple", "at_bat_homerun"]);

/**
 * 이닝 득점 요약 알림 (push-notifications-v1 S5 — my_team_score_inning_summary).
 * 이닝(half) 종료 시 그 half에 공격팀이 낸 득점을 *1건으로 묶어* 발송(득점마다 알림과 별개 옵션).
 * 득점량 = inning_end snapshot − 같은 half의 inning_start snapshot(공격팀 점수 델타)이라
 * run_scored·홈런 등 모든 득점 포함. dedup = notified_score_events에 `${inning_end.id}-summary` 선점.
 * 수신자 = 공격팀 팬 중 my_team_score_inning_summary on (sendFcmToUsers가 pref 필터, 디폴트 off).
 * 문구(하린아빠 확정 2026-06-22): 제목 `⚾ {N}회{초/말} 요약` / 본문 `{N}회{초/말} {안타}안타 {득점}득점.`
 */
export async function notifyInningSummaries(
  games: KboRawGame[],
  eventsByGame: Map<string, GameEvent[]>,
): Promise<{ summarized: number }> {
  let summarized = 0;
  const gameById = new Map(games.map((g) => [g.G_ID, g]));
  // future-only 컷오프: warmup이 받는 events는 *전체 경기 history*라, 기능 배포/활성화
  // 직후 과거 inning_end가 한꺼번에 claim·발송되는 backlog 플러시를 막아야 한다(삼순 #271
  // NO-GO). 매분 도는 cron이 갓 끝난 이닝을 1~2분 내 처리하므로, inning_end timestamp가
  // FRESH_MS보다 오래된(=이전 이닝/배포 전) 것은 skip → 최근 종료 이닝만 요약.
  const FRESH_MS = 10 * 60 * 1000;
  const nowMs = Date.now();

  for (const [gameId, events] of eventsByGame) {
    const g = gameById.get(gameId);
    if (!g || g.CANCEL_SC_ID !== "0") continue;
    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const url = `/games/${gameId}`;

    for (const ev of events) {
      if (ev.type !== "inning_end") continue;
      // 오래된 inning_end(이전 이닝·배포 전) skip — 배포 시 과거 요약 일괄 발송 방지.
      const evMs = Date.parse(ev.timestamp);
      if (Number.isFinite(evMs) && nowMs - evMs > FRESH_MS) continue;
      // 초(isTop) = 원정 공격, 말 = 홈 공격.
      const side: "away" | "home" = ev.isTop ? "away" : "home";
      const scoringTeamName = side === "away" ? away : home;
      const teamId = teamIdByShortName(scoringTeamName);
      if (teamId === null) continue;

      // 같은 half(inning+isTop)의 inning_start 스냅샷 대비 점수 델타 = 그 half 득점.
      const start = events.find(
        (e) => e.type === "inning_start" && e.inning === ev.inning && e.isTop === ev.isTop,
      );
      const endScore = side === "away" ? ev.snapshot.awayScore : ev.snapshot.homeScore;
      const startScore = start
        ? (side === "away" ? start.snapshot.awayScore : start.snapshot.homeScore)
        : endScore; // 시작 스냅샷 없으면 델타 0 → 발송 안 함(보수적)
      const runs = endScore - startScore;
      if (runs <= 0) continue; // 그 half 무득점 → 요약 없음

      if (!(await claimEvent(`${ev.id}-summary`, gameId))) continue; // 이미 발송됨/보류

      const fans = await fansOfTeams([teamId]);
      if (!fans.ok) { await unclaimEvent(`${ev.id}-summary`); continue; }

      const half = ev.isTop ? "초" : "말";
      // 그 half(inning+isTop)의 안타 수.
      const hits = events.filter(
        (e) => e.inning === ev.inning && e.isTop === ev.isTop && INNING_HIT_TYPES.has(e.type),
      ).length;
      const res = await sendFcmToUsers(
        fans.ids,
        { title: `⚾ ${ev.inning}회${half} 요약`, body: `${ev.inning}회${half} ${hits}안타 ${runs}득점.`, url },
        "my_team_score_inning_summary",
      );
      if (!res.ok) { await unclaimEvent(`${ev.id}-summary`); continue; } // 인프라 실패 → 재시도
      summarized += res.sent;
    }
  }
  return { summarized };
}
