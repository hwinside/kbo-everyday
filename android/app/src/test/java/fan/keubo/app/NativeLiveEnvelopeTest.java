package fan.keubo.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * FCM 위젯 제어 봉투 파싱 유닛테스트(삼순 vc14 coordinator) — RemoteMessage 비의존 Map 경로.
 */
public class NativeLiveEnvelopeTest {

    private static Map<String, String> map(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static final long RECV = 1_700_000_000_000L;

    @Test
    public void nullDataReturnsNull() {
        assertNull(NativeLiveEnvelope.parse((Map<String, String>) null, RECV));
    }

    @Test
    public void nonWidgetKindReturnsNull() {
        assertNull(NativeLiveEnvelope.parse(map("kind", "news"), RECV));
        assertNull(NativeLiveEnvelope.parse(map("title", "hi"), RECV)); // kind 없음
    }

    @Test
    public void gameLiveParsesGameIdFromUrlAndTimestamps() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_live", "url", "/games/20260720LGKT0",
                "w_ts", "1700000005000", "w_source_at", "1700000004000"), RECV);
        assertNotNull(e);
        assertEquals(NativeLiveEnvelope.KIND_LIVE, e.kind);
        assertEquals("20260720LGKT0", e.gameId);
        assertEquals(1700000005000L, e.sourceTs); // w_ts
        assertEquals(1700000004000L, e.orderTs);   // w_source_at
        assertFalse(e.isTerminal());
    }

    @Test
    public void missingTimestampsFallBack() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_live", "url", "/games/G1"), RECV);
        assertNotNull(e);
        assertEquals(-1L, e.sourceTs);   // w_ts 없음 → 가드 비활성
        assertEquals(RECV, e.orderTs);   // w_source_at 없음 → 수신 시각
    }

    @Test
    public void gameEndUsesDataGameIdDirect() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_end", "gameId", "20260720LGKT0", "w_ts", "1700000009000"), RECV);
        assertNotNull(e);
        assertEquals(NativeLiveEnvelope.KIND_END, e.kind);
        assertEquals("20260720LGKT0", e.gameId);
        assertTrue(e.isTerminal());
    }

    @Test
    public void gameEndFallsBackToUrlWhenNoGameId() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_end", "url", "/games/G9"), RECV);
        assertNotNull(e);
        assertEquals("G9", e.gameId);
    }

    @Test
    public void gameCancelIsTerminal() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_cancel", "url", "/games/G2"), RECV);
        assertNotNull(e);
        assertTrue(e.isTerminal());
    }

    @Test
    public void badTimestampFallsBack() {
        NativeLiveEnvelope e = NativeLiveEnvelope.parse(
            map("kind", "game_live", "url", "/games/G3", "w_ts", "abc", "w_source_at", "xyz"), RECV);
        assertNotNull(e);
        assertEquals(-1L, e.sourceTs);
        assertEquals(RECV, e.orderTs);
    }
}
