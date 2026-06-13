import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { teamIdByShortName, fansOfTeams } from "@/lib/notifications/game-status";
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

// game-events가 누적 event_history 전체를 반환하므로, 알림은 최근 이벤트만 대상으로
// (배포 직후 과거 이벤트 몰림 방지, 삼순 #273). cron 매분 실행이라 신규 이벤트는 <1분.
const RECENT_EVENT_MS = 5 * 60 * 1000;

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
          },
        }, "game_start");
      }
    }
  }

  return { scored };
}

/**
 * 이닝 득점 요약 알림 (push-notifications-v1 S5a-2, pref: my_team_score_inning_summary).
 * 이닝(half) 종료 시 그 이닝에 공격팀이 낸 득점을 묶어 1회 발송. "내 팀 득점"(득점마다)과
 * 별개 토글(기본 off) — on 유저만 받음. 득점 수는 이벤트 snapshot 누적점수의 단조증가를
 * 이용해 정확히 계산(홈런 포함): runs = maxScore(이닝≤I) − maxScore(이닝<I).
 * dedup = (game, inning, half) 단위. fcm은 pref 키로 토글 자동 게이팅.
 */
export async function notifyInningScoreSummary(
  games: KboRawGame[],
  eventsByGame: Map<string, GameEvent[]>,
): Promise<{ summarized: number }> {
  let summarized = 0;
  const gameById = new Map(games.map((g) => [g.G_ID, g]));

  for (const [gameId, events] of eventsByGame) {
    const g = gameById.get(gameId);
    if (!g || g.CANCEL_SC_ID !== "0") continue;
    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const url = `/games/${gameId}`;

    // 이닝≤maxInn 까지 한 팀의 누적 득점 최대값 (snapshot 단조증가 → 홈런 포함 정확).
    const sideScoreUpTo = (side: "away" | "home", maxInn: number): number => {
      let m = 0;
      for (const e of events) {
        if (e.inning > maxInn) continue;
        const s = side === "away" ? e.snapshot.awayScore : e.snapshot.homeScore;
        if (s > m) m = s;
      }
      return m;
    };

    for (const ev of events) {
      if (ev.type !== "inning_end") continue;
      // game-events는 누적 history 전체를 반환 → 과거 이벤트 발송 차단 (최근 5분만, 삼순 #273).
      if (Date.now() - new Date(ev.timestamp).getTime() > RECENT_EVENT_MS) continue;
      const inning = ev.inning;
      if (!inning) continue;
      const isTop = ev.isTop; // top 종료 → 원정 공격, bottom 종료 → 홈 공격
      const side: "away" | "home" = isTop ? "away" : "home";
      const teamName = isTop ? away : home;

      const runs = sideScoreUpTo(side, inning) - sideScoreUpTo(side, inning - 1);
      if (runs <= 0) continue; // 그 이닝 무득점 → 요약 없음

      const teamId = teamIdByShortName(teamName);
      if (teamId === null) continue;

      // dedup: 이닝×half 단위 1회. 발송 전 선점(과거 알림 방지, S5a와 동일 원칙).
      const dedupId = `${gameId}-inning_summary-${inning}-${isTop ? "T" : "B"}`;
      if (!(await claimEvent(dedupId, gameId))) continue;

      const fans = await fansOfTeams([teamId]);
      if (!fans.ok) { await unclaimEvent(dedupId); continue; }
      if (fans.ids.length === 0) continue; // 팬 없음 — claim 유지

      const res = await sendFcmToUsers(fans.ids, {
        title: `⚾ ${teamName} ${inning}회${isTop ? "초" : "말"} ${runs}득점`,
        body: `${away} vs ${home}`,
        url,
      }, "my_team_score_inning_summary");
      if (!res.ok) { await unclaimEvent(dedupId); continue; }
      summarized += res.sent;
    }
  }

  return { summarized };
}
