import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { sendFcmToUsers, type PushPayload } from "@/lib/notifications/fcm";
import { fansOfTeams, teamIdByShortName } from "@/lib/notifications/game-status";
import { safeInt, parseTeamCodes, iosWidgetScoreState } from "@/lib/notifications/ios-widget-policy";
import type { KboRawGame } from "@/types/api";

// iOS 홈 위젯 무음 갱신 (1.0.9 build 17) — 앱 미실행 상태에서 스코어 변화 시 위젯 반영.
//
// iOS 홈 화면 위젯은 WidgetKit 제약상 서버 push로 직접 갱신 불가(LA와 달리 전용 push 채널
// 없음). 대신 *스코어축 변화 시에만* 무음(content-available) FCM으로 앱을 백그라운드 깨워
// AppDelegate가 위젯 스냅샷을 갱신(WidgetSnapshotStore.markLiveScore → reloadAllTimelines).
// - best-effort: iOS 백그라운드 push 예산 한도 내(3분 SLA 아님 — 잠금화면 LA만 3분 보장).
// - 스코어 변화 시에만 발송(매 틱 아님) → 경기당 ~10-15회로 예산 안전.
// - 위젯이 *이미 이 경기 스냅샷을 갖고 있을 때만* 반영(markLiveScore가 gameId 일치 확인) —
//   브로드캐스트라 per-user myTeamCode를 실을 수 없어, 기존 스냅샷의 팀/최애팀을 보존하고
//   스코어 관련 필드만 덮어쓴다(markFinal과 동일 원리). 스냅샷 없으면 no-op(위젯 미표시 유저).
// - 종료 전환(game_end)은 기존 경로(pushLiveActivityUpdates + AppDelegate markFinal) 유지.

/**
 * iOS 홈 위젯 무음 갱신 — 라이브 경기 스코어축 변화 시 iOS 팬에게 무음 push.
 * lastPlayByGame = warmup이 이미 수집한 문자중계 최근 플레이 한 줄(잠금 LA와 동일 소스).
 */
export async function pushIosWidgetLiveUpdates(
  games: KboRawGame[],
  lastPlayByGame?: Map<string, string>,
): Promise<
  | { games: number; sent: number; failed: number; skipped: number; cleaned: number }
  | { error: string }
> {
  const liveGames = games.filter((g) => g.G_ID && g.GAME_STATE_SC === "2");
  const finishedIds = games
    .filter((g) => g.G_ID && (g.GAME_STATE_SC === "3" || g.CANCEL_SC_ID !== "0"))
    .map((g) => g.G_ID as string);

  // 종료/취소 경기의 상태 행 정리(멱등) — game_id 재사용 안 되나 테이블을 작게 유지.
  if (finishedIds.length > 0) {
    await supabase.from("ios_widget_push_state").delete().in("game_id", finishedIds);
  }
  if (liveGames.length === 0) return { games: 0, sent: 0, failed: 0, skipped: 0, cleaned: 0 };

  const liveIds = liveGames.map((g) => g.G_ID as string);
  const { data: stateRows, error } = await supabase
    .from("ios_widget_push_state")
    .select("game_id, last_score_state")
    .in("game_id", liveIds);
  if (error) return { error: error.message };
  const lastByGame = new Map<string, string>();
  for (const r of (stateRows ?? []) as { game_id: string; last_score_state: string }[]) {
    lastByGame.set(r.game_id, r.last_score_state);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let cleaned = 0;
  let pushedGames = 0;

  for (const g of liveGames) {
    const gameId = g.G_ID as string;
    const codes = parseTeamCodes(gameId);
    if (!codes) continue;

    const scoreState = iosWidgetScoreState(g);
    // 무변화 스킵 — 예산 절약(iOS 백그라운드 push 한도).
    if (lastByGame.get(gameId) === scoreState) {
      skipped += 1;
      continue;
    }

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)].filter(
      (v): v is number => v !== null,
    );
    const fans = await fansOfTeams(teamIds);
    if (!fans.ok) {
      failed += 1;
      continue;
    }
    if (fans.ids.length === 0) {
      // 팬 없음(legit) — 상태만 갱신해 다음 틱 반복 스킵.
      await supabase
        .from("ios_widget_push_state")
        .upsert({ game_id: gameId, last_score_state: scoreState, updated_at: new Date().toISOString() }, { onConflict: "game_id" });
      continue;
    }

    const awayScore = safeInt(g.T_SCORE_CN);
    const homeScore = safeInt(g.B_SCORE_CN);
    const inning = safeInt(g.GAME_INN_NO) || 1;
    const isTop = g.GAME_TB_SC === "T";
    const { currentBatter, currentPitcher } = resolveCurrentPlayers({
      tPlayerName: g.T_P_NM,
      bPlayerName: g.B_P_NM,
      gameTbSc: g.GAME_TB_SC,
    });

    // 무음(content-available) push — 배너 없이 앱 백그라운드 wake. iOS 전용(platform 필터).
    // 라이브 필드만 실음: AppDelegate가 기존 스냅샷(팀/최애팀/next 보존)에 이 값들만 덮어쓴다.
    const payload: PushPayload = {
      title: "",
      body: "",
      dataOnly: true,
      apnsBackground: true,
      data: {
        kind: "widget_live",
        gameId,
        w_away: codes.away,
        w_home: codes.home,
        w_as: String(awayScore),
        w_hs: String(homeScore),
        w_inning: String(inning),
        w_istop: isTop ? "1" : "0",
        w_outs: String(Math.min(Math.max(safeInt(g.OUT_CN), 0), 2)),
        w_first: safeInt(g.B1_BAT_ORDER_NO) > 0 ? "1" : "0",
        w_second: safeInt(g.B2_BAT_ORDER_NO) > 0 ? "1" : "0",
        w_third: safeInt(g.B3_BAT_ORDER_NO) > 0 ? "1" : "0",
        w_pitcher: currentPitcher ?? "",
        w_batter: currentBatter ?? "",
        w_stadium: g.S_NM ?? "",
        w_lastplay: lastPlayByGame?.get(gameId) ?? "",
      },
    };

    const res = await sendFcmToUsers(fans.ids, payload, undefined, "ios");
    if (!res.ok) {
      failed += 1;
      continue; // 발송 실패 → 상태 미갱신(다음 틱 재시도)
    }
    sent += res.sent;
    failed += res.failed;
    cleaned += res.cleaned;
    pushedGames += 1;

    // 발송 성공 → 상태 갱신(다음 틱 무변화 스킵 판정).
    await supabase
      .from("ios_widget_push_state")
      .upsert({ game_id: gameId, last_score_state: scoreState, updated_at: new Date().toISOString() }, { onConflict: "game_id" });
  }

  return { games: pushedGames, sent, failed, skipped, cleaned };
}
