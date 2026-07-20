package fan.keubo.app;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;

/**
 * FCM 수신 서비스 — capawesome MessagingService를 확장해서, 앱이 꺼져 있어도
 * 경기 라이브 data 푸시를 받으면 잠금화면 ongoing notification + 홈 위젯 + 갤럭시워치를 갱신한다.
 *
 * super 호출로 플러그인의 기존 동작(토큰 갱신, JS 이벤트 전달, notification 메시지 표시)은
 * 그대로 유지. 추가로 위젯 제어 kind(game_live/game_cancel/game_end)를 네이티브로 처리한다.
 *
 * ── 단일 apply coordinator (삼순 vc14 딥리뷰) ──
 * onMessageReceived는 얇은 dispatcher다:
 *   1) NativeLiveEnvelope.parse — kind/gameId/sourceTs를 1회 확정
 *   2) NativeLiveState.apply — prefs 원자 저장 + 위젯 재렌더 → ApplyResult
 *   3) 결과 분기 — STALE/INVALID는 어떤 UI 부수효과도 금지, NO_CHANGE는 재게시/재푸시 금지,
 *      APPLIED만 잠금카드 post/clear·갤럭시워치 DataItem·종료 후 rank/player 갱신을 수행
 * 이렇게 세 서피스(위젯·잠금카드·워치)가 하나의 상태머신을 공유해 순서 역전·오종료·중복 렌더를
 * 한 곳에서 닫는다.
 *
 * 매니페스트에서 이 서비스가 플러그인 MessagingService를 대체 등록한다(tools:node="remove").
 */
public class KboMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        final long recvMs = System.currentTimeMillis();
        final long recvElapsed = android.os.SystemClock.elapsedRealtime(); // handler_to_dispatch 기준(단조)

        NativeLiveEnvelope env = NativeLiveEnvelope.parse(remoteMessage, recvMs);
        if (env == null) {
            return; // 위젯 제어 kind 아님 — super가 이미 JS 이벤트/알림 메시지 처리
        }

        // 1) 상태 적용(prefs 원자 저장 + 위젯 재렌더) → ApplyResult
        WidgetUpdatePolicy.ApplyResult result = NativeLiveState.apply(this, env);

        // 2) 수신→dispatch 지연 계측(적용 여부와 무관하게 배달 지연 자체를 잰다)
        GameScoreWidget.recordDeliveryLatency(this, env.sourceTs, recvMs,
            android.os.SystemClock.elapsedRealtime() - recvElapsed);

        // 3) STALE/INVALID = 순서 역전/모호 동률 → 어떤 UI 부수효과도 금지(삼순)
        if (result == WidgetUpdatePolicy.ApplyResult.STALE
            || result == WidgetUpdatePolicy.ApplyResult.INVALID) {
            return;
        }
        final boolean applied = result == WidgetUpdatePolicy.ApplyResult.APPLIED;
        final Map<String, String> data = env.data;

        if (NativeLiveEnvelope.KIND_LIVE.equals(env.kind)) {
            // 잠금화면 카드 — 새 상태(APPLIED)일 때만 재게시. NO_CHANGE는 이미 떠 있어 재게시 불필요.
            if (applied) {
                String title = data.get("title");
                String body = data.get("body");
                String path = data.get("url"); // 카드 탭 → 경기룸 딥링크
                GameNotificationPlugin.post(
                    this,
                    title == null || title.isEmpty() ? "크보팬" : title,
                    body == null ? "" : body,
                    path == null ? "" : path);
            }
            // APPLIED에서만 부수효과(삼순 #723 — NO_CHANGE는 계약상 부수효과 0).
            if (applied) {
                // 선수 카드 위젯 — 라이브 틱 편승 재조회(55초 스로틀, 미배치면 no-op)
                PlayerCardWidget.onLiveTick(this);
                // 갤럭시워치 — 경기 전(SCHEDULED)은 pushGameStateToWatch가 스킵.
                pushGameStateToWatch("live", data, env.gameId, env.orderTs);
            }
        } else if (NativeLiveEnvelope.KIND_CANCEL.equals(env.kind)) {
            // 취소 → APPLIED에서만 잠금화면 정리+워치 push. NO_CHANGE(중복 취소)는 부수효과 0.
            // STALE(다른/이전 경기 취소)은 위에서 이미 return돼 현재 카드 보존.
            if (applied) {
                GameNotificationPlugin.clear(this);
                pushGameStateToWatch("cancelled", data, env.gameId, env.orderTs);
            }
        } else { // game_end
            // 종료 → APPLIED에서만 잠금화면 정리+후속. STALE(다른/이전 경기 종료)은 return돼 최신 카드 오종료 방지.
            if (applied) {
                GameNotificationPlugin.clear(this);
                // 순위 위젯 — 종료 직후 순위 갱신(미배치면 no-op)
                TeamRankWidget.fetchAndRefresh(this);
                // 선수 카드 위젯 — 종료 직후 오늘 경기 라인/최근 3경기 갱신(미배치면 no-op)
                PlayerCardWidget.fetchAndRefresh(this);
                // 갤럭시워치 — 종료 상태 수렴(위젯 prefs의 현재 경기/팀/점수를 읽어 push)
                pushGameEndToWatch();
            }
        }
    }

    // ── 폰 → 갤럭시워치 push bridge (#719 Wear Data Layer 주경로) ──

    /**
     * 폰 → 갤럭시워치 경기 상태 push(주경로) — /kbo/game_state DataItem(urgent, latest-value).
     * game_live/game_cancel의 w_* data를 그대로 실어 워치 GameStateListenerService가 게이트 후
     * 타일/컴플리케이션을 재렌더한다. 워치 미연결/GMS 이상은 조용히 무시(폰 기능 무영향).
     * ts는 서버 w_source_at 우선(FCM 재정렬에도 강건), 없으면 폰 수신 시각.
     */
    private void pushGameStateToWatch(String kind, Map<String, String> data, String gameId, long orderTs) {
        String status = data.get("w_status");
        // 경기 전(SCHEDULED)은 워치가 카운트다운/pull로 처리 — 라이브 스냅샷으로 오합성 방지.
        if ("live".equals(kind) && status != null && status.startsWith("SCHEDULED")) {
            return;
        }
        try {
            com.google.android.gms.wearable.PutDataMapRequest req =
                    com.google.android.gms.wearable.PutDataMapRequest.create("/kbo/game_state");
            com.google.android.gms.wearable.DataMap m = req.getDataMap();
            m.putString("kind", kind);
            m.putString("gid", gameId == null ? "" : gameId);
            // 순서 기준 ts = 봉투 orderTs(w_source_at→w_ts→수신시각 단일 계약, 삼순 #723 clock domain 통일).
            m.putLong("ts", orderTs);
            putIf(m, "w_away", data.get("w_away"));
            putIf(m, "w_home", data.get("w_home"));
            putIf(m, "w_as", data.get("w_as"));
            putIf(m, "w_hs", data.get("w_hs"));
            putIf(m, "w_status", status);
            putIf(m, "w_outs", data.get("w_outs"));
            putIf(m, "w_diamond", data.get("w_diamond"));
            putIf(m, "w_stadium", data.get("w_stadium"));
            putIf(m, "w_pitcher", data.get("w_pitcher"));
            putIf(m, "w_batter", data.get("w_batter"));
            putIf(m, "w_lastplay", data.get("w_lastplay"));
            com.google.android.gms.wearable.Wearable.getDataClient(this)
                    .putDataItem(req.asPutDataRequest().setUrgent());
        } catch (Exception ignored) {
        }
    }

    /**
     * game_end 전용 워치 push — game_end FCM엔 w_ 필드가 없어, GameScoreWidget prefs의
     * 현재 경기(gameId·팀·점수·구장)를 읽어 종료 스냅샷으로 수렴시킨다. 경기 없음이면 no-op.
     */
    private void pushGameEndToWatch() {
        try {
            android.content.SharedPreferences p = getSharedPreferences(
                    GameScoreWidget.PREFS, android.content.Context.MODE_PRIVATE);
            if (!p.getBoolean(GameScoreWidget.KEY_HAS_GAME, false)) return;
            String away = p.getString(GameScoreWidget.KEY_AWAY, "");
            String home = p.getString(GameScoreWidget.KEY_HOME, "");
            if (away.isEmpty() || home.isEmpty()) return;
            com.google.android.gms.wearable.PutDataMapRequest req =
                    com.google.android.gms.wearable.PutDataMapRequest.create("/kbo/game_state");
            com.google.android.gms.wearable.DataMap m = req.getDataMap();
            m.putString("kind", "final");
            m.putString("gid", p.getString(GameScoreWidget.KEY_GAME_ID, ""));
            m.putLong("ts", System.currentTimeMillis());
            m.putString("w_away", away);
            m.putString("w_home", home);
            m.putString("w_as", p.getString(GameScoreWidget.KEY_AS, "0"));
            m.putString("w_hs", p.getString(GameScoreWidget.KEY_HS, "0"));
            putIf(m, "w_stadium", p.getString(GameScoreWidget.KEY_STADIUM, ""));
            com.google.android.gms.wearable.Wearable.getDataClient(this)
                    .putDataItem(req.asPutDataRequest().setUrgent());
        } catch (Exception ignored) {
        }
    }

    private static void putIf(com.google.android.gms.wearable.DataMap m, String key, String value) {
        if (value != null && !value.isEmpty()) {
            m.putString(key, value);
        }
    }

    /** 서버 w_source_at(epoch millis 문자열) 파싱 — 없거나 불량하면 폰 수신 시각 fallback. */
    private static long parseSourceAt(String raw) {
        if (raw != null && !raw.isEmpty()) {
            try {
                return Long.parseLong(raw.trim());
            } catch (NumberFormatException ignored) {
            }
        }
        return System.currentTimeMillis();
    }
}
