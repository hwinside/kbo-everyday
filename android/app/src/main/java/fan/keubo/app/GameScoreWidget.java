package fan.keubo.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/**
 * 홈 화면 App Widget — 실시간 경기 스코어 (A4 B3, "둘 다"의 위젯 파트).
 * 데이터는 SharedPreferences(kbo_game_widget)에서 읽는다. 앱이 라이브 경기 시
 * title/sub를 기록 + AppWidgetManager로 갱신(데이터 연결은 후속 슬라이스).
 * 값이 없으면 빈 상태("경기 정보가 없어요")를 보여 실유저에게 가짜 스코어 노출 방지.
 */
public class GameScoreWidget extends AppWidgetProvider {

    static final String PREFS = "kbo_game_widget";
    static final String KEY_TITLE = "title";
    static final String KEY_SUB = "sub";

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String title = p.getString(KEY_TITLE, "");
        String sub = p.getString(KEY_SUB, "");

        Intent launch = context.getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            context, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_game_score);
            views.setTextViewText(R.id.widget_score, title.isEmpty() ? "크보팬" : title);
            views.setTextViewText(R.id.widget_sub, sub.isEmpty() ? "경기 정보가 없어요" : sub);
            views.setOnClickPendingIntent(R.id.widget_root, pi);
            mgr.updateAppWidget(id, views);
        }
    }
}
