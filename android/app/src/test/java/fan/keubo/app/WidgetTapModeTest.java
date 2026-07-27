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
}
