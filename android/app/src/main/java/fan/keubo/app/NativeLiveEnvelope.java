package fan.keubo.app;

import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * FCM 위젯 제어 메시지(game_live/game_cancel/game_end)를 1회 파싱한 불변 봉투(삼순 vc14 coordinator).
 *
 * kind/gameId/sourceTs/orderTs를 확정하고 원본 data map을 보존한다. 위젯 제어 kind가 아니면
 * parse가 null을 반환해 KboMessagingService가 곧바로 빠진다(super가 이미 JS 이벤트/알림 처리).
 *
 * - sourceTs = 서버 send-time(w_ts, ms). seq 가드 기준. 미전달(구버 서버)이면 -1(가드 비활성).
 * - orderTs  = 워치 DataItem 순서 기준. 서버 원천 w_source_at 우선(FCM 재정렬 강건), 없으면 수신 시각.
 */
final class NativeLiveEnvelope {
    static final String KIND_LIVE = "game_live";
    static final String KIND_CANCEL = "game_cancel";
    static final String KIND_END = "game_end";

    final String kind;
    final String gameId;
    final long sourceTs;
    final long orderTs;
    final Map<String, String> data;

    private NativeLiveEnvelope(String kind, String gameId, long sourceTs, long orderTs,
                              Map<String, String> data) {
        this.kind = kind;
        this.gameId = gameId;
        this.sourceTs = sourceTs;
        this.orderTs = orderTs;
        this.data = data;
    }

    boolean isTerminal() {
        return KIND_CANCEL.equals(kind) || KIND_END.equals(kind);
    }

    /** 위젯 제어 kind면 봉투, 아니면 null. recvMs는 w_source_at 폴백용. */
    static NativeLiveEnvelope parse(RemoteMessage msg, long recvMs) {
        return msg == null ? null : parse(msg.getData(), recvMs);
    }

    /** RemoteMessage 비의존 순수 파싱(유닛테스트 진입점). */
    static NativeLiveEnvelope parse(Map<String, String> data, long recvMs) {
        if (data == null) {
            return null;
        }
        String kind = data.get("kind");
        if (!KIND_LIVE.equals(kind) && !KIND_CANCEL.equals(kind) && !KIND_END.equals(kind)) {
            return null;
        }
        String gameId = resolveGameId(kind, data);
        // fail-closed(삼순 #723): 경기 식별자 없으면 봉투 자체를 버린다 — 특히 terminal(종료/취소)이
        // gid 없이 적용되면 엉복 카드/다른 경기를 오종료시킬 수 있다(identity 강제).
        if (gameId == null || gameId.isEmpty()) {
            return null;
        }
        long sourceTs = parseLong(data.get("w_ts"), -1L);
        // 순서 기준 orderTs 단일 계약(삼순 #723 clock domain 통일): w_source_at → w_ts → 수신시각.
        // live/cancel/end 전부 동일 규칙 — 폰 시계/서버 시각이 섞이지 않게.
        long orderTs = parseLong(data.get("w_source_at"), sourceTs >= 0 ? sourceTs : recvMs);
        return new NativeLiveEnvelope(kind, gameId, sourceTs, orderTs, data);
    }

    /**
     * gameId 확정 — game_end는 data.gameId 직접(game-status.ts), 그 외/폴백은 url("/games/{id}")
     * 마지막 세그먼트.
     */
    private static String resolveGameId(String kind, Map<String, String> data) {
        if (KIND_END.equals(kind)) {
            String g = data.get("gameId");
            if (g != null) {
                return g;
            }
        }
        String path = data.get("url");
        if (path == null) {
            return "";
        }
        int slash = path.lastIndexOf('/');
        return slash >= 0 ? path.substring(slash + 1) : path;
    }

    private static long parseLong(String s, long fallback) {
        if (s == null || s.isEmpty()) {
            return fallback;
        }
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
