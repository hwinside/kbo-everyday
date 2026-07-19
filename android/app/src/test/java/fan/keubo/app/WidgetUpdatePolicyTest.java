package fan.keubo.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import fan.keubo.app.WidgetUpdatePolicy.ApplyResult;
import org.junit.Test;

/**
 * 위젯 FCM 업데이트 적용 판정 유닛테스트 — ApplyResult 상태머신(삼순 vc14 딥리뷰).
 * WidgetUpdatePolicy는 Android 비의존 순수 함수라 JVM에서 검증한다.
 */
public class WidgetUpdatePolicyTest {

    private static final String SIG_A = "A\u001fB\u001f3";
    private static final String SIG_B = "A\u001fB\u001f4";

    // ── seq 역전/최신 ──

    @Test
    public void olderSeqSameGameIsStale() {
        assertEquals(ApplyResult.STALE,
            WidgetUpdatePolicy.decide(1000L, 2000L, false, SIG_B, SIG_A, false));
    }

    @Test
    public void newerSeqDifferentContentApplies() {
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(2001L, 2000L, false, SIG_B, SIG_A, false));
    }

    @Test
    public void newerSeqSameContentIsNoChange() {
        // 최신 ts지만 내용 동일 → seq만 전진, 재렌더 금지
        assertEquals(ApplyResult.NO_CHANGE,
            WidgetUpdatePolicy.decide(2001L, 2000L, false, SIG_A, SIG_A, false));
    }

    // ── 동일 ts(same millisecond) 동률 규칙 (삼순 핵심 지적) ──

    @Test
    public void equalSeqSameContentIsDuplicateNoChange() {
        assertEquals(ApplyResult.NO_CHANGE,
            WidgetUpdatePolicy.decide(2000L, 2000L, false, SIG_A, SIG_A, false));
    }

    @Test
    public void equalSeqDifferentContentNonTerminalIsInvalid() {
        // 동일 ts인데 내용이 다른 비-terminal → 모호 → 폐기(무조건 drop 아님)
        assertEquals(ApplyResult.INVALID,
            WidgetUpdatePolicy.decide(2000L, 2000L, false, SIG_B, SIG_A, false));
    }

    @Test
    public void equalSeqDifferentContentTerminalWins() {
        // 동일 ts + 다른 내용이라도 terminal(종료/취소)이면 우선 수락
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(2000L, 2000L, false, SIG_B, SIG_A, true));
    }

    // ── 경기 전환 / 구버전 호환 ──

    @Test
    public void gameChangedAlwaysApplies() {
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(1L, 999999L, true, SIG_A, SIG_A, false));
    }

    @Test
    public void negativeSeqDisablesGuardUsesSignature() {
        // 구버전 서버(w_ts 미전달) / JS 포그라운드 = seq<0 → 시그니처로만 판정
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(-1L, 2000L, false, SIG_B, SIG_A, false));
        assertEquals(ApplyResult.NO_CHANGE,
            WidgetUpdatePolicy.decide(-1L, 2000L, false, SIG_A, SIG_A, false));
    }

    @Test
    public void firstUpdateNoPrevSeqApplies() {
        // prevSeq 기본값 -1 → 어떤 seq든 신규 적용(prevSig 없음)
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(5000L, -1L, false, SIG_A, "", false));
    }

    @Test
    public void nullPrevSigTreatedAsEmpty() {
        assertEquals(ApplyResult.APPLIED,
            WidgetUpdatePolicy.decide(10L, -1L, false, SIG_A, null, false));
    }

    // ── isTerminalStatus ──

    @Test
    public void terminalStatusDetection() {
        assertTrue(WidgetUpdatePolicy.isTerminalStatus("FINAL"));
        assertTrue(WidgetUpdatePolicy.isTerminalStatus("경기 종료 CANCELLED"));
        assertFalse(WidgetUpdatePolicy.isTerminalStatus("LIVE 7회말 · 1사"));
        assertFalse(WidgetUpdatePolicy.isTerminalStatus("SCHEDULED|18:30"));
        assertFalse(WidgetUpdatePolicy.isTerminalStatus(null));
    }
}
