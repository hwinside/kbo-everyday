package fan.keubo.app;

import android.content.Context;

/**
 * FCM 위젯 상태 적용 coordinator(삼순 vc14 딥리뷰).
 *
 * 봉투 1개를 받아 홈 위젯 prefs를 원자적으로 적용하고 {@link WidgetUpdatePolicy.ApplyResult}를
 * 반환한다. game_live/game_cancel/game_end가 모두 같은 상태머신(GameScoreWidget)을 통과하며,
 * 순서 역전/모호 동률(STALE/INVALID)은 prefs 무변경, 동일 payload(NO_CHANGE)는 seq만 전진,
 * 새 상태(APPLIED)만 위젯을 재렌더한다.
 *
 * UI 부수효과(잠금카드 post/clear, 갤럭시워치 DataItem, 종료 후 rank/player 갱신)는 호출자
 * (KboMessagingService)가 ApplyResult에 따라 분기한다 — 이 클래스는 위젯 상태만 책임진다.
 */
final class NativeLiveState {
    private NativeLiveState() {}

    static WidgetUpdatePolicy.ApplyResult apply(Context ctx, NativeLiveEnvelope env) {
        if (NativeLiveEnvelope.KIND_END.equals(env.kind)) {
            // 종료도 별도 특례가 아니라 같은 게이트(gameId 일치 + sourceTs 통과)를 통과.
            return GameScoreWidget.markFinal(ctx, env.gameId, env.sourceTs);
        }
        // live / cancel — 같은 writeInternal 상태머신. cancel은 문자중계(lastPlay)를 비운다.
        boolean cancel = NativeLiveEnvelope.KIND_CANCEL.equals(env.kind);
        return GameScoreWidget.writeAndRefresh(
            ctx,
            env.data.get("w_my"),
            env.data.get("w_away"),
            env.data.get("w_home"),
            env.data.get("w_as"),
            env.data.get("w_hs"),
            env.data.get("w_status"),
            env.data.get("w_pitcher"),
            env.data.get("w_pteam"),
            env.data.get("w_batter"),
            env.data.get("w_bteam"),
            env.data.get("w_outs"),
            env.data.get("w_diamond"),
            env.data.get("w_stadium"),
            env.data.get("w_astarter"),
            env.data.get("w_hstarter"),
            env.gameId,
            cancel ? "" : env.data.get("w_lastplay"),
            env.sourceTs);
    }
}
