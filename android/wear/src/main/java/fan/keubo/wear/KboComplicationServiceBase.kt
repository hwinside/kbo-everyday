package fan.keubo.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.CountDownTimeReference
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.TimeDifferenceComplicationText
import androidx.wear.watchface.complications.data.TimeDifferenceStyle
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 컴플리케이션 데이터소스 공통 베이스 — 타일(KboGameTileService)과 동일한
 * cache-first + single-flight 백그라운드 sync 패턴. onComplicationRequest는
 * 어떤 경로에서도 네트워크를 기다리지 않는다(캐시/placeholder 즉시 응답).
 */
abstract class KboComplicationServiceBase : ComplicationDataSourceService() {

    companion object {
        // 두 데이터소스가 공유하는 sync 게이트 — 캐시(WearStore)가 공유라 fetch도 1개면 충분
        private val syncInFlight = AtomicBoolean(false)
    }

    protected fun plain(t: String): PlainComplicationText =
        PlainComplicationText.Builder(t).build()

    /** 시작 시각까지 플랫폼 자동 갱신 카운트다운(재요청 예산 0) — 타일 Dynamic Expressions 대응물. */
    protected fun countdownText(toMs: Long): ComplicationText =
        TimeDifferenceComplicationText.Builder(
            TimeDifferenceStyle.SHORT_DUAL_UNIT,
            CountDownTimeReference(Instant.ofEpochMilli(toMs)),
        ).build()

    /** 탭 → 워치 앱 열기(타일 클릭과 동일 동선). NEW_TASK 불필요 — PendingIntent는 시스템이 처리(lint WearRecents). */
    protected fun tapAction(): PendingIntent =
        PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** 캐시 스냅샷(팀 불일치 방어 포함). 캐시 없으면 loading/noTeam placeholder. */
    protected fun currentSnapshot(): WearSnapshot {
        val myTeam = WearStore.loadMyTeam(this)
        if (myTeam.isEmpty()) return WearSnapshot.noTeam()
        val cached = WearStore.loadCachedSnapshot(this)
            ?.takeIf { it.myTeamCode.equals(myTeam, ignoreCase = true) }
        return cached ?: WearSnapshot.loading(myTeam)
    }

    /**
     * stale 캐시일 때만 single-flight 백그라운드 sync — 스로틀(MIN_SYNC_RETRY_MS)로
     * requestUpdate ↔ onComplicationRequest 재귀 루프 차단, 캐시가 실제로 바뀌었을 때만 재요청.
     */
    protected fun maybeStartSync() {
        val ctx = applicationContext
        if (WearStore.loadMyTeam(ctx).isEmpty()) return
        val now = System.currentTimeMillis()
        val cached = WearStore.loadCachedSnapshot(ctx)
        val stale = cached == null ||
            WearTilePolicy.isStale(cached, WearStore.lastSyncAt(ctx), now)
        if (!stale) return
        if (!WearTilePolicy.canAttemptSync(WearStore.lastSyncAttemptAt(ctx), now)) return
        if (!syncInFlight.compareAndSet(false, true)) return
        WearStore.markSyncAttemptNow(ctx)
        thread(name = "kbo-comp-sync") {
            try {
                val before = WearStore.loadCachedSnapshot(ctx)
                WearFetcher.fetch(ctx)
                val after = WearStore.loadCachedSnapshot(ctx)
                // 삼순 blocker 2: contentSignature(updatedAt 제외)로 실제 변화 시에만 재요청.
                if (after != null &&
                    (before == null || after.contentSignature() != before.contentSignature())
                ) {
                    WearComplicationUpdater.requestUpdateAll(ctx)
                }
            } finally {
                syncInFlight.set(false)
            }
        }
    }
}

/** 두 데이터소스 일괄 재요청 — 최애팀 변경(MyTeamListenerService)·sync 완료 시 사용. */
object WearComplicationUpdater {
    fun requestUpdateAll(ctx: Context) {
        listOf(
            KboGameComplicationService::class.java,
            KboRankComplicationService::class.java,
        ).forEach { cls ->
            ComplicationDataSourceUpdateRequester
                .create(ctx, ComponentName(ctx, cls))
                .requestUpdateAll()
        }
    }
}
