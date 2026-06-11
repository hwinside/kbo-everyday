package fan.keubo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 잠금화면 실시간 스코어 = ongoing notification (iOS Live Activity의 안드로이드판, A4 B1).
 * 상단 고정(ongoing) 알림에 스코어 표시 + 동일 ID re-notify로 갱신 + cancel로 제거.
 * 채널은 IMPORTANCE_LOW(갱신마다 소리/진동 없음).
 */
@CapacitorPlugin(name = "GameNotification")
public class GameNotificationPlugin extends Plugin {

    private static final String CHANNEL_ID = "game_live";
    private static final int NOTIFICATION_ID = 7001;

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "실시간 경기", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("잠금화면 실시간 스코어 (ongoing)");
            channel.setShowBadge(false);
            NotificationManager mgr = context.getSystemService(NotificationManager.class);
            if (mgr != null) mgr.createNotificationChannel(channel);
        }
    }

    private static Notification build(Context context, String title, String body) {
        ensureChannel(context);
        Intent launch = context.getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            context, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi)
            .build();
    }

    /** ongoing notification 게시/갱신 (동일 ID라 갱신은 re-notify). */
    static void post(Context context, String title, String body) {
        try {
            NotificationManagerCompat.from(context)
                .notify(NOTIFICATION_ID, build(context, title, body));
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS 미허용 — 무시 (권한 UX가 별도 처리)
        }
    }

    static void clear(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    @PluginMethod
    public void start(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""));
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""));
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        clear(getContext());
        call.resolve();
    }
}
