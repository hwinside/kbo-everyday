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
}
