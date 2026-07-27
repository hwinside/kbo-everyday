package fan.keubo.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/**
 * 스몰(2x2) 홈 위젯 — iOS systemSmall 등가. 데이터(prefs)는 GameScoreWidget과 공유하고
 * 렌더만 컴팩트 카드(GameScoreWidget.buildSmallCard). 미디엄 4x2와 별도 프로바이더라
 * 위젯 피커에 별도 항목으로 노출(안드는 iOS처럼 사이즈 패밀리 자동 제공 안 함).
 */
public class GameScoreWidgetSmall extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            RemoteViews v = GameScoreWidget.buildSmallCard(context);
            v.setOnClickPendingIntent(R.id.widget_small_root,
                WidgetTapMode.tapIntent(context, GameScoreWidgetSmall.class, id));
            mgr.updateAppWidget(id, v);
        }
    }
}
