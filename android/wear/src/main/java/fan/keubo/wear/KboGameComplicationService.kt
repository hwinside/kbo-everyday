package fan.keubo.wear

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest

/**
 * 데이터소스 ① 최애팀 경기 — 다음경기·카운트다운·라이브 스코어 (스펙 §4, 애플워치 #621 패리티).
 * LONG_TEXT만 지원: 매치업 + 상황 줄. 원형 SHORT_TEXT 슬롯은 상태별 팀 식별 문제 반복으로 제거(#666).
 */
class KboGameComplicationService : KboComplicationServiceBase() {

    override fun onComplicationRequest(
        request: ComplicationRequest,
        listener: ComplicationRequestListener,
    ) {
        val snap = currentSnapshot()
        val data = when (request.complicationType) {
            ComplicationType.LONG_TEXT -> longData(snap)
            else -> null
        }
        listener.onComplicationData(data)
        maybeStartSync()
    }

    // 캐러셀 미리보기 — 익명 더미(수달스·돌고래스), 위젯 피커 폴리시(#564/#576) 동일
    override fun getPreviewData(type: ComplicationType): ComplicationData? = when (type) {
        ComplicationType.LONG_TEXT ->
            LongTextComplicationData.Builder(plain("LIVE 8회말 · 2사"), plain("크보팬 경기 미리보기"))
                .setTitle(plain("수달스 3:2 돌고래스"))
                .build()
        else -> null
    }

    private fun longData(s: WearSnapshot): ComplicationData {
        val spec = WearComplicationPolicy.gameLong(s)
        val b = LongTextComplicationData.Builder(plain(spec.text), plain(contentDesc(s)))
            .setTapAction(tapAction())
        spec.title?.let { b.setTitle(plain(it)) }
        return b.build()
    }

    private fun contentDesc(s: WearSnapshot): String {
        val spec = WearComplicationPolicy.gameLong(s)
        return listOfNotNull(spec.title, spec.text).joinToString(" · ")
    }
}
