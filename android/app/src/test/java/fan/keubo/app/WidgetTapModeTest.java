package fan.keubo.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 위젯 탭 동작 모드 해석 유닛테스트 — resolveRefreshOnly는 Android 비의존 순수 함수라
 * JVM에서 SharedPreferences 없이 검증한다(WidgetUpdatePolicyTest 스타일).
 */
public class WidgetTapModeTest {

    @Test
    public void nullDefaultsToOpen() {
        assertFalse(WidgetTapMode.resolveRefreshOnly(null));
    }

    @Test
    public void openIsNotRefresh() {
        assertFalse(WidgetTapMode.resolveRefreshOnly("open"));
    }

    @Test
    public void refreshIsRefresh() {
        assertTrue(WidgetTapMode.resolveRefreshOnly("refresh"));
    }

    @Test
    public void unknownDefaultsToOpen() {
        assertFalse(WidgetTapMode.resolveRefreshOnly("garbage"));
        assertFalse(WidgetTapMode.resolveRefreshOnly(""));
    }

    /**
     * 삼순 ③ 회귀 — 탭 PendingIntent 종류(activity=open vs broadcast=refresh) 결정이
     * 저장 모드에 *즉시* 종속됨을 고정한다. tapIntent가 isRefreshOnly(=resolveRefreshOnly)
     * 단일 판정으로 분기하므로, 저장값이 바뀌면 다음 tapIntent 종류가 곧바로 뒤집힌다.
     * (setter가 applyToAllWidgets로 즉시 재렌더를 트리거해 첫 탭부터 새 모드 적용.)
     */
    @Test
    public void modeSwitchImmediatelyFlipsIntentKind() {
        // open → refresh 전환: activity(false) → broadcast(true)
        assertFalse(WidgetTapMode.resolveRefreshOnly(WidgetTapMode.MODE_OPEN));
        assertTrue(WidgetTapMode.resolveRefreshOnly(WidgetTapMode.MODE_REFRESH));
        // refresh → open 역전환: broadcast(true) → activity(false)
        assertFalse(WidgetTapMode.resolveRefreshOnly(WidgetTapMode.MODE_OPEN));
    }
}
