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
