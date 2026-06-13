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
const SCORE_EVENT_TYPES = new Set<string>(["run_scored", "at_bat_homerun"]);

interface InningSummaryRow {
  game_id: string;
  inning: number;
  is_top: boolean;
  team_id: number;
  team_name: string;
  away_name: string;
  home_name: string;
  runs: number;
  away_score: number;
  home_score: number;
  sent: boolean;
}

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
): Promise<{ scored: number; inningSummaries: number }> {
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
      await recordInningScore(g, ev, teamId, scoringTeamName);

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

  const inningSummaries = await sendPendingInningScoreSummaries(games);
  return { scored, inningSummaries };
}

function scoreEventRuns(ev: GameEvent): number {
  const rbi = Number(ev.detail?.rbi ?? 1);
  return Number.isFinite(rbi) && rbi > 0 ? rbi : 1;
}

function scoreEventSide(ev: GameEvent): "away" | "home" {
  if (ev.type === "run_scored" && ev.detail?.scoringSide) return ev.detail.scoringSide;
  return ev.isTop ? "away" : "home";
}

async function recordInningScore(
  g: KboRawGame,
  ev: GameEvent,
  teamId: number,
  teamName: string,
): Promise<void> {
  const side = scoreEventSide(ev);
  const isTop = side === "away";
  const key = { game_id: g.G_ID, inning: ev.inning, is_top: isTop };
  const runs = scoreEventRuns(ev);
  const awayScore = ev.snapshot?.awayScore ?? (parseInt(g.T_SCORE_CN ?? "0") || 0);
  const homeScore = ev.snapshot?.homeScore ?? (parseInt(g.B_SCORE_CN ?? "0") || 0);

  const { data: existing, error: selectError } = await supabase
    .from("inning_score_summary_state")
    .select("runs")
    .eq("game_id", key.game_id)
    .eq("inning", key.inning)
    .eq("is_top", key.is_top)
    .maybeSingle();
  if (selectError) {
    console.error("[game-score] inning summary state select failed:", selectError.message);
    return;
  }

  const nextRuns = ((existing as { runs?: number } | null)?.runs ?? 0) + runs;
  const payload = {
    ...key,
    team_id: teamId,
    team_name: teamName,
    away_name: g.AWAY_NM ?? "",
    home_name: g.HOME_NM ?? "",
    runs: nextRuns,
    away_score: awayScore,
    home_score: homeScore,
    updated_at: new Date().toISOString(),
  };

  const query = existing
    ? supabase.from("inning_score_summary_state")
      .update(payload)
      .eq("game_id", key.game_id)
      .eq("inning", key.inning)
      .eq("is_top", key.is_top)
    : supabase.from("inning_score_summary_state")
      .insert({ ...payload, sent: false });
  const { error } = await query;
  if (error) console.error("[game-score] inning summary state write failed:", error.message);
}

function halfInningComplete(row: InningSummaryRow, g: KboRawGame): boolean {
  if (g.CANCEL_SC_ID !== "0") return false;
  if (g.GAME_STATE_SC === "3") return true;
  if (g.GAME_STATE_SC !== "2") return false;

  const currentInning = Number(g.GAME_INN_NO ?? 0);
  if (currentInning > row.inning) return true;
  if (currentInning < row.inning) return false;
  return row.is_top && g.GAME_TB_SC === "B";
}

async function sendPendingInningScoreSummaries(games: KboRawGame[]): Promise<number> {
  const gameById = new Map(games.map((g) => [g.G_ID, g]));
  const gameIds = [...gameById.keys()].filter(Boolean);
  if (gameIds.length === 0) return 0;

  const { data, error } = await supabase
    .from("inning_score_summary_state")
    .select("game_id, inning, is_top, team_id, team_name, away_name, home_name, runs, away_score, home_score, sent")
    .eq("sent", false)
    .in("game_id", gameIds);
  if (error) {
    console.error("[game-score] inning summary pending query failed:", error.message);
    return 0;
  }

  let sent = 0;
  for (const row of (data ?? []) as InningSummaryRow[]) {
    const g = gameById.get(row.game_id);
    if (!g || !halfInningComplete(row, g) || row.runs <= 0) continue;

    const fans = await fansOfTeams([row.team_id]);
    if (!fans.ok) continue;
    const half = row.is_top ? "초" : "말";
    const scoreLine = `${row.away_name} ${row.away_score} : ${row.home_score} ${row.home_name}`;
    const res = await sendFcmToUsers(fans.ids, {
      title: `📌 ${row.team_name} ${row.inning}회${half} ${row.runs}득점`,
      body: scoreLine,
      url: `/games/${row.game_id}`,
    }, "my_team_score_inning_summary");
    if (!res.ok) continue;

    const { error: updateError } = await supabase
      .from("inning_score_summary_state")
      .update({ sent: true, updated_at: new Date().toISOString() })
      .eq("game_id", row.game_id)
      .eq("inning", row.inning)
      .eq("is_top", row.is_top);
    if (updateError) {
      console.error("[game-score] inning summary sent mark failed:", updateError.message);
      continue;
    }
    sent += res.sent;
  }
  return sent;
}
