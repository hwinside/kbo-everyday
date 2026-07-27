package fan.keubo.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

/**
 * 홈 위젯 탭 동작 모드 — 디바이스 로컬(SharedPreferences). 4개 위젯이 같은 위치를 읽는 단일 소스.
 *  - "open"  (기본): 탭 → 앱 실행 (현행)
 *  - "refresh": 탭 → 앱을 열지 않고 self broadcast(ACTION_APPWIDGET_UPDATE)로 onUpdate 재실행,
 *               최신 prefs 기준으로 위젯만 다시 렌더(온디바이스 네트워크 fetch 없음).
 */
public final class WidgetTapMode {

    static final String PREFS = "kbo_widget_tap";
    static final String KEY_MODE = "tap_mode";
    static final String MODE_OPEN = "open";
    static final String MODE_REFRESH = "refresh";

    private WidgetTapMode() {}

    /** 순수 함수 — 저장값 → refresh 여부. null/"open"/그 외 → false, "refresh" → true. (JVM 유닛테스트 대상) */
    static boolean resolveRefreshOnly(String stored) {
        return MODE_REFRESH.equals(stored);
    }

    static boolean isRefreshOnly(Context context) {
        return resolveRefreshOnly(
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_MODE, MODE_OPEN));
    }

    /** mode 검증 후 저장 — open|refresh만 허용, 그 외 open fallback. */
    static void setMode(Context context, String mode) {
        String normalized = MODE_REFRESH.equals(mode) ? MODE_REFRESH : MODE_OPEN;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_MODE, normalized)
            .apply();
    }

    /** 위젯 탭 PendingIntent — 모드에 따라 앱 실행(getActivity) vs 위젯 self 재렌더(getBroadcast).
     *  requestCode = appWidgetId로 위젯별 고유(getActivity/getBroadcast 충돌 방지). */
    static PendingIntent tapIntent(Context context, Class<? extends AppWidgetProvider> widgetClass, int appWidgetId) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (isRefreshOnly(context)) {
            Intent refresh = new Intent(context, widgetClass);
            refresh.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            refresh.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, new int[] { appWidgetId });
            return PendingIntent.getBroadcast(context, appWidgetId, refresh, flags);
        }
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        return PendingIntent.getActivity(context, appWidgetId, launch, flags);
    }

    /** 홈 위젯 provider 4종 — 모드 변경 즉시 재렌더 대상(설치된 인스턴스만).
     *  package-visible 상수로 노출해 setter(applyToAllWidgets)가 이 목록을 직접 참조하고,
     *  유닛테스트가 4종 완전성을 고정한다(삼순 #904 왕복2 ④: 목록을 지우면 컴파일/테스트 깨짐). */
    static final Class<?>[] WIDGET_PROVIDERS = {
        GameScoreWidget.class,
        GameScoreWidgetSmall.class,
        PlayerCardWidget.class,
        TeamRankWidget.class,
    };

    /** setMode 직후 호출 — 설치된 4종 위젯 provider의 모든 인스턴스를 즉시 재렌더한다
     *  (self ACTION_APPWIDGET_UPDATE broadcast → onUpdate가 새 모드로 tapIntent 재빌드).
     *  이게 없으면 prefs만 바뀌고 기존 PendingIntent가 남아 첫 탭이 옛 모드로 동작(삼순 ③).
     *  설치 인스턴스가 없는 provider는 broadcast를 보내지 않는다(빈 id 배열 skip). */
    static void applyToAllWidgets(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        if (mgr == null) return;
        for (Class<?> provider : WIDGET_PROVIDERS) {
            int[] ids = mgr.getAppWidgetIds(new ComponentName(context, provider));
            if (ids == null || ids.length == 0) continue;
            Intent update = new Intent(context, provider);
            update.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            update.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            context.sendBroadcast(update);
        }
    }
}
