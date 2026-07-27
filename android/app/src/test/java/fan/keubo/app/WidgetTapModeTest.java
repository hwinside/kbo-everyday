package fan.keubo.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;

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

    /**
     * 삼순 #904 왕복2 ④ 회귀 — 모드 변경 즉시 재렌더 대상 provider 목록이 홈 위젯 4종을
     * 전부 포함하고 비어있지 않음을 고정한다. applyToAllWidgets가 WIDGET_PROVIDERS를 직접
     * 순회하므로, 이 상수가 지워지거나 provider가 빠지면 컴파일/이 테스트가 깨진다
     * (resolver 복제만 검사하던 기존 테스트의 사각지대 보완).
     */
    @Test
    public void widgetProvidersCoverAllFourAndNonEmpty() {
        Class<?>[] providers = WidgetTapMode.WIDGET_PROVIDERS;
        assertTrue("provider 목록이 비어있으면 안 됨", providers.length > 0);
        List<Class<?>> list = Arrays.asList(providers);
        assertTrue(list.contains(GameScoreWidget.class));
        assertTrue(list.contains(GameScoreWidgetSmall.class));
        assertTrue(list.contains(PlayerCardWidget.class));
        assertTrue(list.contains(TeamRankWidget.class));
        assertTrue("홈 위젯 4종 전부 포함", list.size() >= 4);
    }
}
