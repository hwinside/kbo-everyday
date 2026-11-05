package fan.keubo.app;
import org.junit.Test;
import static org.junit.Assert.*;

public class WidgetRolloverPolicyTest {
    private final String current = "20261012KTSS0";
    private final long cutoff = 1791838800000L; // 2026-10-13 06:00 KST
    @Test public void exactKstBoundary() {
        assertEquals(Long.valueOf(cutoff), WidgetRolloverPolicy.expiry(current));
        for (String status : new String[]{"FINAL", "CANCELLED", "SCHEDULED|18:30"}) {
            assertEquals(0, WidgetRolloverPolicy.resolve(true,status,current,false,"",cutoff-1));
            assertEquals(2, WidgetRolloverPolicy.resolve(true,status,current,false,"",cutoff));
        }
    }
    @Test public void futureAndExpiredNext() {
        String next = "20261014OBLG0";
        assertEquals(1, WidgetRolloverPolicy.resolve(true,"FINAL",current,true,next,cutoff));
        assertEquals(2, WidgetRolloverPolicy.resolve(true,"FINAL",current,true,next,
            WidgetRolloverPolicy.expiry(next)));
        assertEquals(2, WidgetRolloverPolicy.resolve(true,"FINAL",current,true,"",cutoff));
    }
    @Test public void liveAndInvalidCurrentArePreserved() {
        assertEquals(0, WidgetRolloverPolicy.resolve(true,"LIVE 12회",current,false,"",cutoff));
        assertEquals(0, WidgetRolloverPolicy.resolve(true,"FINAL","bad",false,"",cutoff));
        assertNull(WidgetRolloverPolicy.expiry("20260230OBLG0"));
        assertEquals(0, WidgetRolloverPolicy.resolve(false,"FINAL",current,false,"",cutoff));
        assertEquals(0, WidgetRolloverPolicy.resolve(true,"SCHEDULED|18:30","20261014OBLG0",false,"",cutoff));
    }
    @Test public void yearRollover() {
        assertEquals(24L*60*60*1000, WidgetRolloverPolicy.expiry("20270101OBLG0")
            - WidgetRolloverPolicy.expiry("20261231OBLG0"));
    }
}
