package fan.keubo.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 위젯 FCM 업데이트 적용/렌더 판정 유닛테스트 — stale 역전 차단 + 동일 payload no-op(삼순 vc14).
 * WidgetUpdatePolicy는 Android 비의존 순수 함수라 JVM에서 검증한다.
 */
public class WidgetUpdatePolicyTest {

    // ── isStaleOrDuplicate: 순서 역전/중복 FCM 차단 ──

    @Test
    public void olderSeqSameGameIsDropped() {
        // 딥슬립 복귀로 옛 상태(작은 seq)가 최신(큰 prevSeq) 뒤에 도착 → 버린다
        assertTrue(WidgetUpdatePolicy.isStaleOrDuplicate(1000L, 2000L, false));
    }

    @Test
    public void equalSeqSameGameIsDropped() {
        // 동일 seq 중복 배달 → 버린다
        assertTrue(WidgetUpdatePolicy.isStaleOrDuplicate(2000L, 2000L, false));
    }

    @Test
    public void newerSeqSameGameIsApplied() {
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(2001L, 2000L, false));
    }

    @Test
    public void gameChangedAlwaysApplied() {
        // 경기가 바뀌면 새 경기라 seq 리셋 대상 — 낮은 seq여도 적용
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(1L, 999999L, true));
    }

    @Test
    public void negativeSeqDisablesGuard() {
        // 구버전 서버(w_ts 미전달) / JS 포그라운드 경로 = seq<0 → 가드 비활성(항상 적용)
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(-1L, 2000L, false));
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(-1L, -1L, false));
    }

    @Test
    public void firstUpdateNoPrevSeqApplied() {
        // prevSeq 기본값 -1 → 어떤 seq든 적용(첫 업데이트)
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(0L, -1L, false));
        assertFalse(WidgetUpdatePolicy.isStaleOrDuplicate(5000L, -1L, false));
    }

    // ── shouldRefresh: 동일 payload no-op ──

    @Test
    public void identicalSigSameGameSkipsRefresh() {
        assertFalse(WidgetUpdatePolicy.shouldRefresh("A\u001fB\u001f3", "A\u001fB\u001f3", false));
    }

    @Test
    public void changedSigRefreshes() {
        assertTrue(WidgetUpdatePolicy.shouldRefresh("A\u001fB\u001f4", "A\u001fB\u001f3", false));
    }

    @Test
    public void gameChangedAlwaysRefreshesEvenIfSigMatches() {
        // 새 경기는 시그니처가 우연히 같아도 반드시 재렌더
        assertTrue(WidgetUpdatePolicy.shouldRefresh("same", "same", true));
    }

    @Test
    public void nullPrevSigRefreshes() {
        // 저장된 시그니처 없음(최초) → 재렌더
        assertTrue(WidgetUpdatePolicy.shouldRefresh("A\u001fB", null, false));
    }

    @Test
    public void emptyPrevSigVsNonEmptyRefreshes() {
        assertTrue(WidgetUpdatePolicy.shouldRefresh("A\u001fB", "", false));
    }
}
