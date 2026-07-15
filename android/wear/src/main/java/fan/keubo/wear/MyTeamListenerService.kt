package fan.keubo.wear

import androidx.wear.tiles.TileService
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

/**
 * 폰 → 워치 최애팀 동기화 수신 — 애플워치 WCSession applicationContext의 안드로이드판.
 * 폰앱 GameNotificationPlugin.setMyTeam이 /kbo/my_team DataItem으로 push한 값을 저장하고
 * 타일을 재렌더한다.
 */
class MyTeamListenerService : WearableListenerService() {

    override fun onDataChanged(dataEvents: DataEventBuffer) {
        var changed = false
        for (event in dataEvents) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            val item = event.dataItem
            if (item.uri.path != "/kbo/my_team") continue
            val code = DataMapItem.fromDataItem(item).dataMap.getString("code") ?: continue
            // 빈 코드 = 최애팀 해제 — saveMyTeam이 변경 시 이전 팀 캐시까지 atomic 무효화
            if (WearStore.saveMyTeam(this, code)) changed = true
        }
        if (changed) {
            TileService.getUpdater(this).requestUpdate(KboGameTileService::class.java)
        }
    }
}
