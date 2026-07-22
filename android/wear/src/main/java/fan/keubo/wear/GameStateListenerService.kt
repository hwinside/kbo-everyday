package fan.keubo.wear

import androidx.wear.tiles.TileService
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

/**
 * 폰 → 워치 경기 상태 push 수신(주경로) — 애플워치 WCSession live push의 안드로이드판.
 * 폰 KboMessagingService가 game_live/cancel/end FCM 수신 시 /kbo/game_state DataItem(urgent,
 * latest-value)으로 최신 상태를 밀면, 여기서 WearPushPolicy로 게이트 후 캐시 저장 +
 * Tile/Complication requestUpdate → 라이브 20~40초 실시간 갱신(freshness pull에 의존하지 않음).
 *
 * ts/gid 순서·중복·wrong-team·terminal 게이트는 전부 WearPushPolicy(순수)에서 판정한다.
 */
class GameStateListenerService : WearableListenerService() {

    override fun onDataChanged(dataEvents: DataEventBuffer) {
        for (event in dataEvents) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val item = event.dataItem
            if (item.uri.path != "/kbo/game_state") continue
            handle(DataMapItem.fromDataItem(item).dataMap)
        }
    }

    private fun handle(map: DataMap) {
        val recvElapsed = android.os.SystemClock.elapsedRealtime()
        val myTeam = WearStore.loadMyTeam(this)
        val push = parse(map)
        val now = System.currentTimeMillis()
        val decision = WearPushPolicy.evaluate(
            myTeam = myTeam,
            push = push,
            cached = WearStore.loadCachedSnapshot(this),
            lastPushTs = WearStore.lastPushTs(this),
            lastPushGid = WearStore.lastPushGid(this),
            nowMs = now,
        )
        when (decision) {
            is WearPushPolicy.Decision.Render -> {
                WearStore.savePushSnapshot(this, decision.snapshot, push.ts, push.gid)
                TileService.getUpdater(this).requestUpdate(KboGameTileService::class.java)
                WearComplicationUpdater.requestUpdateAll(this)
            }
            is WearPushPolicy.Decision.NoOp ->
                WearStore.savePushMeta(this, push.ts, push.gid)
            is WearPushPolicy.Decision.Drop -> Unit // 무시(wrong-team/stale/terminal/unbuildable)
        }
        val decisionLabel = when (decision) {
            is WearPushPolicy.Decision.Render -> "render"
            is WearPushPolicy.Decision.NoOp -> "noop"
            is WearPushPolicy.Decision.Drop -> "drop:${decision.reason}"
        }
        logPipeline(
            map,
            now,
            android.os.SystemClock.elapsedRealtime() - recvElapsed,
            decisionLabel,
        )
    }

    /** source→KBO fetch→FCM send→폰 receive/apply→워치 receive/apply 구간별 구조화 로그. */
    private fun logPipeline(map: DataMap, wearRecvMs: Long, wearRecvToDispatchMs: Long, decision: String) {
        val sourceAt = map.getLong("source_at", -1L)
        val fetchedAt = map.getLong("fetched_at", -1L)
        val sentAt = map.getLong("sent_at", -1L)
        val phoneRecvAt = map.getLong("phone_recv_at", -1L)
        val phoneApplyAt = map.getLong("phone_apply_at", -1L)
        fun d(end: Long, start: Long): Long =
            if (end < 0L || start < 0L) -1L else maxOf(0L, end - start)
        val sourceToWearRecv = d(wearRecvMs, sourceAt)
        val sourceToWearDispatch =
            if (sourceToWearRecv < 0L) -1L else sourceToWearRecv + maxOf(0L, wearRecvToDispatchMs)
        android.util.Log.i(
            "kbo-wear-pipeline",
            "source_to_fetch_ms=${d(fetchedAt, sourceAt)}" +
                " fetch_to_send_ms=${d(sentAt, fetchedAt)}" +
                " send_to_phone_recv_ms=${d(phoneRecvAt, sentAt)}" +
                " phone_recv_to_apply_ms=${d(phoneApplyAt, phoneRecvAt)}" +
                " phone_apply_to_wear_recv_ms=${d(wearRecvMs, phoneApplyAt)}" +
                " wear_recv_to_dispatch_ms=${maxOf(0L, wearRecvToDispatchMs)}" +
                " source_to_wear_dispatch_ms=$sourceToWearDispatch" +
                " decision=$decision",
        )
    }

    /** DataMap → PushState. 폰 KboMessagingService.pushGameStateToWatch가 넣는 키와 1:1. */
    private fun parse(m: DataMap): WearPushPolicy.PushState {
        fun s(k: String): String = m.getString(k) ?: ""
        fun sn(k: String): String? = m.getString(k)?.ifEmpty { null }
        fun i(k: String): Int? = m.getString(k)?.trim()?.toIntOrNull()
        return WearPushPolicy.PushState(
            gid = s("gid"),
            ts = m.getLong("ts"),
            kind = s("kind"),
            away = s("w_away"),
            home = s("w_home"),
            awayScore = i("w_as") ?: 0,
            homeScore = i("w_hs") ?: 0,
            statusRaw = s("w_status"),
            outs = i("w_outs"),
            diamond = sn("w_diamond"),
            stadium = sn("w_stadium"),
            pitcher = sn("w_pitcher"),
            batter = sn("w_batter"),
            lastPlay = sn("w_lastplay"),
        )
    }
}
