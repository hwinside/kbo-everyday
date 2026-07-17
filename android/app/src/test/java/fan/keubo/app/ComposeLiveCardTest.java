package fan.keubo.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * 승격(Live Update) 카드 텍스트 조합 유닛테스트 — composeLiveCard는 Android API 비의존
 * 순수 함수라 JVM에서 검증한다. (실기기 렌더는 A17 QA 별도)
 */
public class ComposeLiveCardTest {

    private static GameScoreWidget.Eff eff(String away, String home, String as, String hs,
                                           String status, String lastPlay, String stadium) {
        GameScoreWidget.Eff e = new GameScoreWidget.Eff();
        e.hasGame = true;
        e.away = away; e.home = home; e.as = as; e.hs = hs;
        e.status = status; e.lastPlay = lastPlay; e.stadium = stadium;
        return e;
    }

    @Test
    public void live_scoreInningAndLastPlay() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("LT", "SS", "1", "3", "8회초", "한동희 삼진 아웃", "사직"), "크보팬", "");
        assertEquals("롯데 1 : 3 삼성 · 8회초", tb[0]);
        assertEquals("한동희 삼진 아웃", tb[1]);
    }

    @Test
    public void live_noLastPlay_fallsBackToPushBody() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("LG", "KT", "2", "0", "3회말", "", "잠실"), "크보팬", "실시간 중계 확인");
        assertEquals("LG 2 : 0 KT · 3회말", tb[0]);
        assertEquals("실시간 중계 확인", tb[1]);
    }

    @Test
    public void live_noLastPlayNoBody_fallsBackToStadium() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("HT", "WO", "0", "0", "1회초", "", "고척"), "크보팬", "");
        assertEquals("KIA 0 : 0 키움 · 1회초", tb[0]);
        assertEquals("고척", tb[1]);
    }

    @Test
    public void scheduled_showsMatchupAndTime() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("LT", "SS", "0", "0", "SCHEDULED|18:30|7월 17일 (금)", "", "사직"), "크보팬", "곧 시작");
        assertEquals("롯데 vs 삼성 · 18:30 경기 예정", tb[0]);
        assertEquals("곧 시작", tb[1]);
    }

    @Test
    public void finalStatus_showsGameOver() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("LT", "SS", "1", "3", "FINAL", "경기 종료", ""), "크보팬", "");
        assertEquals("롯데 1 : 3 삼성 · 경기 종료", tb[0]);
    }

    @Test
    public void cancelled_showsCancelled() {
        String[] tb = GameNotificationPlugin.composeLiveCard(
            eff("HH", "NC", "0", "0", "CANCELLED", "", ""), "크보팬", "");
        assertEquals("한화 0 : 0 NC · 경기 취소", tb[0]);
    }

    @Test
    public void noGameData_fallsBackToPushText() {
        GameScoreWidget.Eff e = new GameScoreWidget.Eff(); // hasGame=false
        String[] tb = GameNotificationPlugin.composeLiveCard(e, "크보팬", "본문");
        assertEquals("크보팬", tb[0]);
        assertEquals("본문", tb[1]);
    }

    @Test
    public void nullEff_fallsBackToPushText() {
        String[] tb = GameNotificationPlugin.composeLiveCard(null, "크보팬", "본문");
        assertEquals("크보팬", tb[0]);
        assertEquals("본문", tb[1]);
    }
}
