package fan.keubo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 잠금화면 실시간 스코어 = 커스텀 레이아웃 ongoing notification (iOS Live Activity의 안드로이드판).
 * 삼성 One UI 잠금화면은 서드파티 위젯을 허용하지 않으므로(시스템 앱 전용), 잠금화면 카드는
 * 위젯이 아니라 *위젯과 동일한 RemoteViews 카드*를 알림 커스텀 뷰로 그려서 표시한다(네이버 방식).
 * 카드 데이터는 GameScoreWidget의 SharedPreferences(kbo_game_widget)를 공유 — 위젯/알림 동일.
 * 잠금화면 노출 위해 IMPORTANCE_DEFAULT + VISIBILITY_PUBLIC. Android 16+/One UI 8.5는
 * Promoted Ongoing으로 잠금화면 라이브 업데이트 카드 승격을 요청한다.
 * 동일 ID re-notify로 갱신, cancel로 제거.
 */
@CapacitorPlugin(name = "GameNotification")
public class GameNotificationPlugin extends Plugin {

    // v3: 커스텀 카드 + 잠금화면 가시성(IMPORTANCE_DEFAULT). 채널 importance는 생성 후 못 올리므로 새 ID.
    private static final String CHANNEL_ID = "game_live_card";
    private static final int NOTIFICATION_ID = 7001;

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "실시간 경기", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("잠금화면 실시간 스코어 카드");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager mgr = context.getSystemService(NotificationManager.class);
            if (mgr != null) {
                mgr.createNotificationChannel(channel);
                // 구 LOW 채널 제거(잔존 시 잠금화면 숨김 + 중복 노출).
                mgr.deleteNotificationChannel("game_live");
            }
        }
    }

    /** 카드 탭 시 열 앱 내 경로(예: /games/20260612...). MainActivity가 이 extra를 읽어 웹뷰 이동. */
    static final String EXTRA_PATH = "kbo_path";

    private static Notification build(Context context, String title, String body, String path) {
        ensureChannel(context);
        // 카드 탭 → 해당 경기룸 딥링크(②). path가 있으면 MainActivity를 extra와 함께 열고,
        // 없으면(레거시/직접 호출) 기존대로 앱 홈을 연다.
        PendingIntent pi;
        if (path != null && !path.isEmpty()) {
            Intent i = new Intent(context, MainActivity.class);
            i.putExtra(EXTRA_PATH, path);
            // 이미 떠 있는 인스턴스로 전달(onNewIntent) — 새 액티비티 스택 쌓지 않음.
            i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            // request code 1 = 딥링크용(홈은 0). FLAG_UPDATE_CURRENT로 path 갱신 반영.
            pi = PendingIntent.getActivity(
                context, 1, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } else {
            Intent launch = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
            pi = PendingIntent.getActivity(
                context, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
            // 모노크롬 small icon — 컬러 launcher를 쓰면 상태바에 흰 사각형으로 뭉개짐.
            .setSmallIcon(R.drawable.ic_stat_kbo)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setRequestPromotedOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi);

        // 위젯과 동일한 카드 RemoteViews를 알림 커스텀 뷰로 — 잠금화면에 리치 카드 표시.
        // 접힌 뷰(잠금화면 기본) = 점수 한 줄 컴팩트 카드, 펼친 뷰 = 전체 카드.
        if (GameScoreWidget.hasGame(context)) {
            RemoteViews compact = GameScoreWidget.buildCompactCard(context);
            RemoteViews full = GameScoreWidget.buildNotifFullCard(context);
            full.setOnClickPendingIntent(R.id.widget_root, pi);
            b.setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                .setCustomContentView(compact != null ? compact : full)
                .setCustomBigContentView(full);
        }
        return b.build();
    }

    /** ongoing notification 게시/갱신 (동일 ID라 갱신은 re-notify) + 홈 위젯 동기 갱신.
     *  path = 카드 탭 시 열 경기룸 경로(없으면 홈). */
    static void post(Context context, String title, String body, String path) {
        try {
            NotificationManagerCompat.from(context)
                .notify(NOTIFICATION_ID, build(context, title, body, path));
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS 미허용 — 무시 (권한 UX가 별도 처리)
        }
        // 위젯(GameScoreWidget)은 구조화 데이터로 별도 구동(KboMessagingService / JS updateWidget).
        // 여기서 title/sub로 위젯을 건드리지 않는다.
    }

    static void clear(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    @PluginMethod
    public void start(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""),
            call.getString("path", ""));
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""),
            call.getString("path", ""));
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        clear(getContext());
        call.resolve();
    }

    /** 경기룸(포그라운드)에서 풀 라이브 데이터로 위젯 갱신 (OUT/주자/투수·타자 소속 포함). */
    @PluginMethod
    public void updateWidget(PluginCall call) {
        String myTeam = call.getString("myTeam", "");
        String away = call.getString("away", "");
        String home = call.getString("home", "");
        String as = call.getString("awayScore", "0");
        String hs = call.getString("homeScore", "0");
        String status = call.getString("status", "");
        String pitcher = call.getString("pitcher", "");
        String pteam = call.getString("pitcherTeam", "");
        String batter = call.getString("batter", "");
        String bteam = call.getString("batterTeam", "");
        String outs = call.getString("outs", "");
        String diamond = call.getString("diamond", "000");
        String stadium = call.getString("stadium", "");
        String astarter = call.getString("awayStarter", "");
        String hstarter = call.getString("homeStarter", "");
        String gameId = call.getString("gameId", "");
        JSObject next = call.getObject("next");
        if (next != null) {
            GameScoreWidget.writeAndRefreshWithNext(
                getContext(), myTeam, away, home, as, hs, status, pitcher, pteam,
                batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId,
                next.optString("away", ""), next.optString("home", ""),
                next.optString("stadium", ""), next.optString("time", ""),
                next.optString("date", ""), next.optString("astarter", ""),
                next.optString("hstarter", ""));
        } else {
            GameScoreWidget.writeAndRefresh(
                getContext(), myTeam, away, home, as, hs, status, pitcher, pteam,
                batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId, null);
        }
        call.resolve();
    }

    /** 위젯 빈 상태로 전환 (경기 종료). */
    @PluginMethod
    public void clearWidget(PluginCall call) {
        GameScoreWidget.clear(getContext());
        call.resolve();
    }

    /** 디바이스 최애팀 코드 기록 (위젯 배경/워터마크 색 결정). */
    @PluginMethod
    public void setMyTeam(PluginCall call) {
        GameScoreWidget.setMyTeam(getContext(), call.getString("code", ""));
        // 순위 위젯은 최애팀 행 하이라이트가 바뀌므로 캐시로 즉시 재렌더
        TeamRankWidget.renderAllFromCache(getContext());
        call.resolve();
    }

    /** 최애선수 목록 동기화 — 선수 카드 위젯 config(선수 선택 목록)가 읽는다.
     *  json = [{playerId,name,teamId,position,number}] (FavoritePlayer 직렬화). */
    @PluginMethod
    public void setFavPlayers(PluginCall call) {
        String json = call.getString("json", "");
        getContext().getSharedPreferences(PlayerCardWidget.PREFS, Context.MODE_PRIVATE).edit()
            .putString(PlayerCardWidget.KEY_FAV_PLAYERS, json == null ? "" : json)
            .apply();
        call.resolve();
    }
}
