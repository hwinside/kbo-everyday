package fan.keubo.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class Pr723FaultMatrixTest {
    @Test
    public void delayedPreviousGameCannotReplaceNewerGame() {
        assertEquals(WidgetUpdatePolicy.ApplyResult.STALE,
            WidgetUpdatePolicy.decide(100L, 200L, true, "old-game", "new-game", false));
    }

    @Test
    public void terminalWithoutCompleteIdentityFailsClosed() {
        Map<String, String> data = new HashMap<>();
        data.put("kind", "game_end");
        data.put("w_ts", "300");
        assertNull(NativeLiveEnvelope.parse(data, 400L));
    }

    // ── 삼순 #723 재리뷰 P0 — terminal retry seq watermark ──
    // 시나리오: live100 → end200(FINAL, seq=200) → end300 재전송 → late live250
    // end300 재전송이 watermark를 300으로 올려야 late live250이 STALE로 막혀 FINAL이 부활 안 함.

    @Test
    public void terminalRetryAdvancesSeqWatermark() {
        // 이미 FINAL(seq=200)인데 더 큰 seq(300) 종료 재전송 → watermark 전진
        assertEquals(WidgetUpdatePolicy.TerminalResult.RETRY_ADVANCE_SEQ,
            WidgetUpdatePolicy.decideTerminal(true, true, true, 300L, 200L));
    }

    @Test
    public void lateLiveAfterAdvancedTerminalWatermarkIsStale() {
        // end300으로 watermark=300 전진 후, 늦게 도착한 live250(seq=250 < 300) → STALE(FINAL 부활 방지)
        assertEquals(WidgetUpdatePolicy.ApplyResult.STALE,
            WidgetUpdatePolicy.decide(250L, 300L, false, "live-sig", "final-sig", false));
    }

    @Test
    public void terminalFirstTimeApplies() {
        assertEquals(WidgetUpdatePolicy.TerminalResult.APPLY,
            WidgetUpdatePolicy.decideTerminal(true, true, false, 200L, 100L));
    }

    @Test
    public void terminalDifferentGameIsStale() {
        assertEquals(WidgetUpdatePolicy.TerminalResult.STALE,
            WidgetUpdatePolicy.decideTerminal(true, false, false, 200L, 100L));
    }

    @Test
    public void terminalRetrySameSeqNoAdvance() {
        assertEquals(WidgetUpdatePolicy.TerminalResult.NOOP,
            WidgetUpdatePolicy.decideTerminal(true, true, true, 200L, 200L));
    }
}
