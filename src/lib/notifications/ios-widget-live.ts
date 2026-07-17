import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { sendFcmToUsers, type PushPayload } from "@/lib/notifications/fcm";
import { fansOfTeams, teamIdByShortName } from "@/lib/notifications/game-status";
import {
  safeInt,
  parseTeamCodes,
  iosWidgetScoreState,
  decideWidgetPushClaim,
  widgetTransientFailures,
  shouldRevertWidgetCursor,
  WIDGET_RETRY_SENTINEL,
} from "@/lib/notifications/ios-widget-policy";
import type { KboRawGame } from "@/types/api";

// iOS 홈 위젯 무음 갱신 (1.0.9 build 17) — 앱 미실행 상태에서 점수 변화 시 위젯 반영.
//
// iOS 홈 화면 위젯은 WidgetKit 제약상 서버 push로 직접 갱신 불가(LA와 달리 전용 push 채널
// 없음). *최초 live 1회 + 점수 변화 시에만* 무음(content-available) FCM으로 앱을 백그라운드
// 깨워 AppDelegate가 위젯 스냅샷을 갱신(WidgetSnapshotStore.markLiveScore → reload).
// 삼순 #674 NO-GO 5건 반영:
//  ① dedupe 키 = 점수만(경기당 ~10-25회, 예산 안전) — 이닝/아웃/주자는 payload에만.
//  ② AppDelegate가 widget_live 처리 후 completionHandler(.newData) 명시 호출(예산 신뢰).
//  ③ 지연/역순 배달 방어 — payload w_ev(발송 시각) + Swift 로컬 fence + APNs
//     collapse-id(경기별)+expiration 90s.
//  ④ 커서 CAS claim(cron 중첩 중복 발송 차단) + transient 실패 시 bounded retry
//     (revert도 CAS, 최대 WIDGET_PUSH_MAX_RETRIES회 후 전진 유지).
//  ⑤ build 17 게이트 — register-device가 보고한 app_build ≥ 17 토큰에만 발송
//     (null=미보고 자동 제외, fail-closed). 구버전 silent push 예산 보호.
// 종료 전환(game_end)은 기존 경로(pushLiveActivityUpdates + AppDelegate markFinal) 유지.
// 위젯 갱신 자체는 단말에서 스냅샷 gameId 일치 시에만 적용(markLiveScore no-op 가드) —
// 서버는 최애팀 팬(build 17+)에게 보내고, 위젯 미사용 단말은 native no-op로 소화된다.

/** widget_live를 처리할 수 있는 최소 네이티브 빌드(markLiveScore 탑재). */
export const IOS_WIDGET_LIVE_MIN_BUILD = 17;

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

  // 종료/취소 경기의 상태 행 정리(멱등) — 테이블을 작게 유지.
  if (finishedIds.length > 0) {
    await supabase.from("ios_widget_push_state").delete().in("game_id", finishedIds);
  }
  if (liveGames.length === 0) return { games: 0, sent: 0, failed: 0, skipped: 0, cleaned: 0 };

  const liveIds = liveGames.map((g) => g.G_ID as string);
  const { data: stateRows, error } = await supabase
    .from("ios_widget_push_state")
    .select("game_id, last_score_state, attempts")
    .in("game_id", liveIds);
  if (error) return { error: error.message };
  const rowByGame = new Map<string, { last: string; attempts: number }>();
  for (const r of (stateRows ?? []) as { game_id: string; last_score_state: string; attempts: number }[]) {
    rowByGame.set(r.game_id, { last: r.last_score_state, attempts: r.attempts ?? 0 });
  }

  // 지연/역순 배달 fence 기준 시각(③) — 이 틱 발송분의 이벤트 시각. 단말 markLiveScore가
  // 저장된 liveEventMs보다 오래된(≤) 이벤트를 거부해 늦은 배달의 점수 회귀를 막는다.
  const tickMs = Date.now();

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let cleaned = 0;
  let pushedGames = 0;

  for (const g of liveGames) {
    const gameId = g.G_ID as string;
    const codes = parseTeamCodes(gameId);
    if (!codes) continue;

    const nextState = iosWidgetScoreState(g);
    const row = rowByGame.get(gameId) ?? null;
    const claim = decideWidgetPushClaim(row ? row.last : null, nextState);
    if (claim === "skip") {
      skipped += 1;
      continue;
    }
    const attempts = row?.attempts ?? 0;

    // ④ CAS claim — 동시 cron 인스턴스 중 정확히 하나만 발송 자격을 얻는다.
    let claimed = false;
    if (claim === "claim-insert") {
      const { data: ins } = await supabase
        .from("ios_widget_push_state")
        .upsert(
          { game_id: gameId, last_score_state: nextState, attempts: 0, updated_at: new Date().toISOString() },
          { onConflict: "game_id", ignoreDuplicates: true },
        )
        .select("game_id");
      claimed = (ins?.length ?? 0) > 0;
    } else {
      const { data: upd } = await supabase
        .from("ios_widget_push_state")
        .update({ last_score_state: nextState, attempts: 0, updated_at: new Date().toISOString() })
        .eq("game_id", gameId)
        .eq("last_score_state", row!.last)
        .select("game_id");
      claimed = (upd?.length ?? 0) > 0;
    }
    if (!claimed) {
      skipped += 1; // 다른 cron 인스턴스가 선점 — 중복 발송 방지
      continue;
    }

    // claim 이후 실패는 전부 transient 취급 → bounded revert로 다음 틱 재시도.
    const revertOnTransient = async () => {
      if (!shouldRevertWidgetCursor(attempts)) return; // 상한 도달 — 전진 유지(포기)
      await supabase
        .from("ios_widget_push_state")
        .update({
          last_score_state: row ? row.last : WIDGET_RETRY_SENTINEL,
          attempts: attempts + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("game_id", gameId)
        .eq("last_score_state", nextState); // CAS — 이후 다른 틱이 이미 전진시켰으면 no-op
    };

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)].filter(
      (v): v is number => v !== null,
    );
    const fans = await fansOfTeams(teamIds);
    if (!fans.ok) {
      failed += 1;
      await revertOnTransient();
      continue;
    }
    if (fans.ids.length === 0) {
      continue; // 팬 없음(legit) — 커서 전진 유지, 다음 틱 반복 스킵
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

    // 무음(content-available) push — 배너 없이 앱 백그라운드 wake. iOS build 17+ 전용(⑤).
    // 라이브 필드만 실음: 단말이 기존 스냅샷(팀/최애팀/next 보존)에 이 값들만 덮어쓴다.
    const payload: PushPayload = {
      title: "",
      body: "",
      dataOnly: true,
      apnsBackground: true,
      apnsCollapseId: `wl-${gameId}`, // ③ 경기별 합침 — 미배달 백로그 대신 최신 1건
      apnsExpirationSeconds: 90, // ③ 다음 점수 변화가 곧 덮어씀 — stale 배달 폐기
      data: {
        kind: "widget_live",
        gameId,
        w_ev: String(tickMs), // ③ 단말 로컬 fence 기준(늦은 배달 점수 회귀 방지)
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

    const res = await sendFcmToUsers(fans.ids, payload, undefined, "ios", {
      minAppBuild: IOS_WIDGET_LIVE_MIN_BUILD,
    });
    sent += res.sent;
    failed += res.failed;
    cleaned += res.cleaned;
    skipped += res.skipped;

    // ④ invalid 정리분 제외 transient 실패가 남으면 bounded revert — 다음 틱 재발송.
    if (widgetTransientFailures(res) > 0) {
      await revertOnTransient();
      continue;
    }
    pushedGames += 1;
  }

  return { games: pushedGames, sent, failed, skipped, cleaned };
}
