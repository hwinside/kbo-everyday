package fan.keubo.wear

import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest

/**
 * 데이터소스 ② 최애팀 순위 — "LG · 2위 · 1.5G" (스펙 §4, 애플워치 #621 순위 표시 패리티).
 * SHORT_TEXT: 팀명 + "2위". LONG_TEXT: rankLine 전체. RANGED_VALUE: 1위=10 게이지(대표 슬롯형 QA).
 */
class KboRankComplicationService : KboComplicationServiceBase() {

    override fun onComplicationRequest(
        request: ComplicationRequest,
        listener: ComplicationRequestListener,
    ) {
        val snap = currentSnapshot()
        val data = when (request.complicationType) {
            ComplicationType.SHORT_TEXT -> shortData(snap)
            ComplicationType.LONG_TEXT -> longData(snap)
            ComplicationType.RANGED_VALUE -> rangedData(snap)
            else -> null
        }
        listener.onComplicationData(data)
        maybeStartSync()
    }

    // 캐러셀 미리보기 — 익명 더미(수달스), 위젯 피커 폴리시(#564/#576) 동일
    override fun getPreviewData(type: ComplicationType): ComplicationData? = when (type) {
        ComplicationType.SHORT_TEXT ->
            ShortTextComplicationData.Builder(plain("2위"), plain("크보팬 순위 미리보기"))
                .setTitle(plain("수달스"))
                .build()
        ComplicationType.LONG_TEXT ->
            LongTextComplicationData.Builder(plain("2위 · 1.5G"), plain("크보팬 순위 미리보기"))
                .setTitle(plain("수달스"))
                .build()
        ComplicationType.RANGED_VALUE ->
            RangedValueComplicationData.Builder(9f, 0f, 10f, plain("크보팬 순위 미리보기"))
                .setText(plain("2위"))
                .setTitle(plain("수달스"))
                .build()
        else -> null
    }

    private fun shortData(s: WearSnapshot): ComplicationData {
        val spec = WearComplicationPolicy.rankShort(s)
        val b = ShortTextComplicationData.Builder(plain(spec.text), plain(contentDesc(s)))
            .setTapAction(tapAction())
        spec.title?.let { b.setTitle(plain(it)) }
        return b.build()
    }

    private fun longData(s: WearSnapshot): ComplicationData {
        val spec = WearComplicationPolicy.rankLong(s)
        val b = LongTextComplicationData.Builder(plain(spec.text), plain(contentDesc(s)))
            .setTapAction(tapAction())
        spec.title?.let { b.setTitle(plain(it)) }
        return b.build()
    }

    private fun rangedData(s: WearSnapshot): ComplicationData {
        val g = WearComplicationPolicy.rankGauge(s) ?: return NoDataComplicationData()
        return RangedValueComplicationData.Builder(g.value, g.min, g.max, plain(contentDesc(s)))
            .setText(plain(g.label))
            .setTitle(plain(WearTeam.short(s.myTeamCode)))
            .setTapAction(tapAction())
            .build()
    }

    private fun contentDesc(s: WearSnapshot): String {
        val spec = WearComplicationPolicy.rankLong(s)
        return listOfNotNull(spec.title, spec.text).joinToString(" · ")
    }
}
