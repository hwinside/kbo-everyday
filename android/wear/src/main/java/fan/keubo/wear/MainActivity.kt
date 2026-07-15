package fan.keubo.wear

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.wear.tiles.TileService
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlin.concurrent.thread

/**
 * 슬라이스 A 최소 액티비티 — 타일 추가 안내 + 현재 스냅샷 확인용.
 * 본격 앱 화면(Wear Compose)은 슬라이스 C 스코프.
 *
 * 콜드 스타트 폴백: 워치앱 설치 전에 폰이 push한 my_team DataItem을 리스너가 못 받았을 수
 * 있으므로, 실행 시 Data Layer에서 직접 읽어 저장한다.
 */
class MainActivity : Activity() {

    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(WearTeam.COLOR_BG)
            setPadding(24, 24, 24, 24)
        }
        root.addView(
            TextView(this).apply {
                text = "크보팬"
                textSize = 18f
                setTextColor(WearTeam.COLOR_TEXT_PRIMARY)
                gravity = Gravity.CENTER
            },
        )
        statusView = TextView(this).apply {
            textSize = 13f
            setTextColor(WearTeam.COLOR_TEXT_SECONDARY)
            gravity = Gravity.CENTER
            setPadding(0, 12, 0, 0)
        }
        root.addView(statusView)
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        renderStatus()
        syncMyTeamFromPhone()
    }

    private fun renderStatus() {
        val snap = WearStore.loadCachedSnapshot(this)
        val myTeam = WearStore.loadMyTeam(this)
        statusView.text = when {
            myTeam.isEmpty() -> "폰 크보팬 앱에서\n최애팀을 선택하면 연동됩니다"
            snap == null -> "${WearTeam.short(myTeam)} 팬\n타일을 추가해 주세요"
            else -> "${WearTeam.short(myTeam)} 팬 · ${snap.line}\n워치페이스에서 타일을 추가해 주세요"
        }
        statusView.setTextColor(Color.WHITE)
    }

    /** Data Layer에서 my_team 직접 read (리스너 미수신 대비 콜드 스타트 폴백) */
    private fun syncMyTeamFromPhone() {
        Wearable.getDataClient(this).dataItems
            .addOnSuccessListener { buffer ->
                try {
                    // DataItem 부재(폰 미연동)와 빈 코드(최애팀 해제)를 구분 —
                    // 부재 시엔 기존 저장값을 건드리지 않는다.
                    var found = false
                    var code = ""
                    for (item in buffer) {
                        if (item.uri.path == "/kbo/my_team") {
                            found = true
                            code = DataMapItem.fromDataItem(item).dataMap.getString("code") ?: ""
                        }
                    }
                    if (found && WearStore.saveMyTeam(this, code)) {
                        TileService.getUpdater(this)
                            .requestUpdate(KboGameTileService::class.java)
                        if (code.isNotEmpty()) {
                            // 새 팀 기준 스냅샷 즉시 준비(백그라운드)
                            thread(name = "kbo-app-sync") {
                                WearFetcher.fetch(this)
                                runOnUiThread { renderStatus() }
                            }
                        } else {
                            renderStatus()
                        }
                    }
                } finally {
                    buffer.release()
                }
            }
    }
}
