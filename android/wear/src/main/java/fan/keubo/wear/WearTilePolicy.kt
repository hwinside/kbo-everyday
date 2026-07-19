package fan.keubo.wear

import java.util.Locale

/**
 * 타일 캐시 신선도·freshness·카운트다운 정책 — 시각(nowMs)을 주입받는 순수 함수 모음.
 * KboGameTileService가 위임 호출하고, 유닛테스트(WearTilePolicyTest)가 경계값을 검증한다.
 */
object WearTilePolicy {

    // kind별 캐시 신선도 임계(이보다 오래되면 백그라운드 re-sync).
    // ⚠️ 이 pull 경로는 폰 단절 시 *폴백*이다. 라이브 20~40초 실시간 갱신의 주경로는
    // 폰 KboMessagingService → Data Layer(/kbo/game_state) → GameStateListenerService push
    // bridge(WearPushPolicy)다. STALE_LIVE_MS(20초)는 그 push가 끊겼을 때 tile 재요청(freshness 30초)
    // 시 재sync를 트리거하는 폴백 임계.
    const val STALE_LIVE_MS = 20_000L
    const val STALE_TODAY_MS = 5 * 60_000L
    const val STALE_IDLE_MS = 15 * 60_000L

    // live 캐시 5분 초과 → "업데이트 지연" 표시 (삼순 조건 1)
    const val LIVE_DELAY_BADGE_MS = 5 * 60_000L

    // 백그라운드 sync 최소 재시도 간격 — requestUpdate ↔ onTileRequest 루프 방지.
    // renderer inter-update 하한 20초 선례(삼순 정정). push bridge가 주경로라 실 pull sync는 폰 단절
    // 시에만 발생하므로 이 임계가 20초여도 상시 20초 폴링이 아니다(배터리 영향 미미).
    const val MIN_SYNC_RETRY_MS = 20_000L

    /** 캐시가 백그라운드 re-sync 대상일 만큼 오래됐는지. */
    fun isStale(snap: WearSnapshot, lastSyncAtMs: Long, nowMs: Long): Boolean {
        val age = nowMs - lastSyncAtMs
        val threshold = when {
            snap.isLive -> STALE_LIVE_MS
            snap.kind == "scheduled" && snap.startAt?.let {
                WearFetcher.isCountdownToday(it, nowMs)
            } == true -> STALE_TODAY_MS
            else -> STALE_IDLE_MS
        }
        return age > threshold
    }

    /** 직전 시도로부터 MIN_SYNC_RETRY_MS 지나야 새 sync 허용(실패 루프 스로틀). */
    fun canAttemptSync(lastAttemptAtMs: Long, nowMs: Long): Boolean =
        nowMs - lastAttemptAtMs >= MIN_SYNC_RETRY_MS

    // push bridge가 최근 캐시를 갱신했으면(수락 시 lastSyncAt 갱신 — WearStore.savePushSnapshot/savePushMeta)
    // freshness/stale이 자연히 fresh로 잡혀 폴백 pull이 생략된다(삼순: "Data Layer snapshot 신선하면 pull 생략").

    /**
     * freshness 힌트(OS best-effort — SLA 아님, 스펙 v2 §3):
     * live 30초(fallback — setFreshnessIntervalMillis에 60초 하한 없음, renderer inter-update 20초 선례.
     *   20~40초 실시간은 push bridge(/kbo/game_state)가 주경로로 달성, 이 pull은 폰 단절 폴백) /
     * loading 1분 / 예정(시작 전) min(30분, 시작까지) /
     * startedButStillScheduled 4분(#635 retry) / 그 외 30분.
     * ⚠️ Wear OS는 짧은 freshness를 저전력/앰비언트에서 늘릴 수 있어 SLA가 아니라 "목표"다.
     */
    fun freshnessForMs(snap: WearSnapshot, nowMs: Long): Long {
        val thirtyMin = 30 * 60_000L
        return when (snap.kind) {
            "live" -> 30_000L
            "loading" -> 60_000L
            "scheduled" -> {
                val start = snap.startAt ?: return thirtyMin
                if (!WearFetcher.isCountdownToday(start, nowMs)) return thirtyMin
                val untilStart = start - nowMs
                if (untilStart <= 0) 4 * 60_000L // 시작됐는데 API 아직 scheduled — #635 4분 retry
                else untilStart.coerceIn(60_000L, thirtyMin)
            }
            else -> thirtyMin
        }
    }

    /**
     * 렌더 시점 정적 카운트다운 라벨(Dynamic Expressions 폴백) — 하린아빠 7/16 워치 실기기 피드백:
     * 시작 전 1h 이상 "5시간 27분 후 시작" / 1h 미만 "27분 후 시작"(0분은 "1분 후 시작") / 시작 후 "곧 시작".
     */
    fun staticCountdownLabel(startAtMs: Long, nowMs: Long): String {
        val secs = (startAtMs - nowMs) / 1000
        if (secs <= 0) return "곧 시작"
        val mins = (secs / 60).toInt()
        val h = mins / 60
        val m = mins % 60
        return if (h > 0) "${h}시간 ${m}분 후 시작" else "${maxOf(1, m)}분 후 시작"
    }
}
