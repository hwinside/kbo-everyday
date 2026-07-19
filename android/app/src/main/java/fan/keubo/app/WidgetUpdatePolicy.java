package fan.keubo.app;

/**
 * 홈 위젯 FCM 업데이트 적용/렌더 판정 — 순수 함수(삼순 vc14 네이티브 견고화).
 *
 * GameScoreWidget.writeInternal이 SharedPreferences 값을 읽어 이 판정을 위임 호출하고,
 * WidgetUpdatePolicyTest(JVM)가 경계값을 검증한다. Android 의존 없음.
 *
 * 배경: game_live data 푸시는 이미 FCM→prefs→AppWidget 직결이라 지연은 서버 전송 주기가
 * 결정한다(추가 폴링은 삼순 NO-GO). 네이티브가 더할 수 있는 건 "정확도" — 순서 역전 차단과
 * 불필요한 재렌더 제거다.
 */
final class WidgetUpdatePolicy {
    private WidgetUpdatePolicy() {}

    /**
     * stale 역전/중복 판정: 같은 경기에서 seq(서버 send-time ms)가 이전 적용분보다 작거나
     * 같으면 버린다 — 딥슬립 복귀 등으로 순서 역전 배달된 옛 상태가 최신을 덮는 걸 차단.
     * seq<0(구버전 서버가 w_ts 미전달 / JS 포그라운드 경로)이면 가드 비활성 → 항상 적용(구버전 호환).
     * 경기가 바뀌면(gameChanged) 새 경기라 seq 리셋 대상 → 항상 적용.
     */
    static boolean isStaleOrDuplicate(long seq, long prevSeq, boolean gameChanged) {
        return seq >= 0 && !gameChanged && seq <= prevSeq;
    }

    /**
     * 동일 payload no-op 판정: 경기가 그대로이고 렌더 시그니처가 이전과 같으면 RemoteViews
     * 재빌드를 생략(깜빡임·비용 0). 경기가 바뀌었거나 시그니처가 달라지면 재렌더.
     */
    static boolean shouldRefresh(String sig, String prevSig, boolean gameChanged) {
        return gameChanged || !sig.equals(prevSig == null ? "" : prevSig);
    }
}
