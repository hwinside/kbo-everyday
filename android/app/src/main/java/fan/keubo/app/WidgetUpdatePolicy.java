package fan.keubo.app;

/**
 * 홈 위젯 FCM 업데이트 적용 판정 — 순수 함수(삼순 vc14 딥리뷰: ApplyResult 상태머신).
 *
 * GameScoreWidget.writeInternal / markFinal이 SharedPreferences 값을 읽어 이 판정을 위임하고,
 * WidgetUpdatePolicyTest(JVM)가 경계값을 고정한다. Android 의존 없음.
 *
 * 배경: game_live data 푸시는 이미 FCM→prefs→AppWidget 직결이라 지연은 서버 전송 주기가
 * 결정한다(추가 폴링은 삼순 NO-GO). 네이티브가 더할 수 있는 건 '정확도' — 순서 역전 차단과
 * 불필요한 재렌더 제거다.
 *
 * seq = 서버 send-time(ms, w_ts). 같은 밀리초 동률은 무조건 버리지 않고 내용/종료 우선순위로 가른다.
 */
final class WidgetUpdatePolicy {
    private WidgetUpdatePolicy() {}

    /**
     * 적용 판정 결과(삼순 딥리뷰 명명):
     *  APPLIED   = 새 상태 반영 + RemoteViews 재렌더
     *  NO_CHANGE = seq/liveness만 전진, 재렌더 금지(동일 payload)
     *  STALE     = 순서 역전(옛 상태) → 어떤 UI 부수효과도 금지, 폐기
     *  INVALID   = 동일 ts인데 내용이 다른 비-terminal(모호) → 폐기
     */
    enum ApplyResult { APPLIED, NO_CHANGE, STALE, INVALID }

    /**
     * @param seq             수신 seq(서버 send-time ms). &lt;0이면 가드 비활성(구버전 서버/JS 포그라운드).
     * @param prevSeq         마지막 적용 seq(prefs, 기본 -1).
     * @param gameChanged     경기 전환(다른 gameId) — 새 경기라 seq 리셋 대상 → 항상 적용.
     * @param sig             수신 렌더 시그니처.
     * @param prevSig         마지막 적용 렌더 시그니처(null 허용).
     * @param incomingTerminal 수신이 종료/취소(terminal)인지 — 동일 ts 동률에서 terminal 우선.
     */
    static ApplyResult decide(long seq, long prevSeq, boolean gameChanged,
                              String sig, String prevSig, boolean incomingTerminal) {
        String prev = prevSig == null ? "" : prevSig;
        boolean sameSig = sig.equals(prev);

        // seq 가드 비활성(구버전 서버 w_ts 미전달 / JS 포그라운드 경로) → 시그니처로만 no-op 판정.
        // (경기 전환은 seq 없이도 반영 — 구버전 폴백)
        if (seq < 0) {
            if (gameChanged) return ApplyResult.APPLIED;
            return sameSig ? ApplyResult.NO_CHANGE : ApplyResult.APPLIED;
        }

        // seq watermark 우선 (경기 전환 여부와 무관, 삼순 #723 fault-matrix):
        // 늦게 도착한 이전 경기(낮은 seq)는 gid가 달라도 STALE — 새 경기로 역전 방지.
        // 정상 새 경기는 서버 send-time(seq)이 항상 더 크므로 아래 gameChanged 분기를 통과한다.
        if (seq < prevSeq) return ApplyResult.STALE;

        // 경기 전환: 새 경기(더 높은/같은 seq 통과) → 시그니처 우연 일치여도 반드시 재렌더
        if (gameChanged) return ApplyResult.APPLIED;

        // 같은 경기, seq >= prevSeq
        if (seq == prevSeq) {
            if (sameSig) return ApplyResult.NO_CHANGE;             // 동일 ts + 동일 내용 = 중복
            // 동일 ts + 다른 내용: terminal(종료/취소)이면 우선 수락, 아니면 모호 → 폐기
            return incomingTerminal ? ApplyResult.APPLIED : ApplyResult.INVALID;
        }
        // seq > prevSeq (최신) — 내용 같으면 no-op(seq만 전진), 다르면 반영
        return sameSig ? ApplyResult.NO_CHANGE : ApplyResult.APPLIED;
    }

    /** 상태 문자열이 종료/취소(terminal)인지 — 동일 ts 동률 우선순위 판정용. */
    static boolean isTerminalStatus(String status) {
        if (status == null) return false;
        String s = status.toUpperCase(java.util.Locale.US);
        return s.contains("FINAL") || s.contains("CANCEL");
    }
}
