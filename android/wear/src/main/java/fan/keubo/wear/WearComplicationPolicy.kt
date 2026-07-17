package fan.keubo.wear

/**
 * 슬라이스 B 컴플리케이션 표시 정책 — 애플워치 #621(KBOWatchGameComplication) 정보 패리티.
 * 순수 함수 모음: 시각(nowMs) 주입, androidx 의존 없음 → WearComplicationPolicyTest가 검증.
 * 서비스(KboGame/KboRankComplicationService)는 이 스펙을 androidx ComplicationData로 변환만 한다.
 */
object WearComplicationPolicy {

    /**
     * SHORT_TEXT 슬롯 스펙(각 필드 ~7자 이내 유지).
     * countdownToMs != null이면 text 대신 플랫폼 TimeDifference 카운트다운(자동 갱신)으로 렌더.
     */
    data class ShortSpec(val title: String?, val text: String, val countdownToMs: Long? = null)

    /** LONG_TEXT 슬롯 스펙 — 워치페이스가 title/text 2줄 또는 한 줄로 배치. */
    data class LongSpec(val title: String?, val text: String)

    /** RANGED_VALUE 게이지 스펙 — 1위=10 … 10위=1 (게이지 가득 = 상위). */
    data class RankGauge(val value: Float, val min: Float, val max: Float, val label: String)

    // ── 공통 헬퍼 ──

    /** "롯데 1:4 삼성" — 홈/원정 순서 고정(#650 삼순 조건: 전 상태 원정 좌·홈 우). */
    private fun matchupScore(s: WearSnapshot): String =
        "${WearTeam.short(s.awayCode)} ${s.awayScore}:${s.homeScore} ${WearTeam.short(s.homeCode)}"

    private fun matchupVs(s: WearSnapshot): String =
        "${WearTeam.short(s.awayCode)} vs ${WearTeam.short(s.homeCode)}"

    // ── ① 경기 데이터소스 ──

    fun gameLong(s: WearSnapshot): LongSpec = when (s.kind) {
        // line = "LIVE 8회말 · 2사" / "경기 종료 · 승" — WearFetcher.compose가 이미 합성
        "live", "final" -> LongSpec(matchupScore(s), s.line)
        // line = "오늘 18:30 · 잠실" / "7/18(토) 18:30 · 잠실" / "경기 취소"
        "scheduled", "cancelled" -> LongSpec(matchupVs(s), s.line)
        "noTeam" -> LongSpec("크보팬", "앱에서 최애팀을 선택하세요")
        else -> LongSpec(WearTeam.short(s.myTeamCode), s.line) // loading / noGame
    }

    // ── ② 순위 데이터소스 ──

    /** rankLine "2위 · 1.5G" | "2위" | "" → 순위(1..10) 또는 null(미확보). */
    fun parseRank(rankLine: String): Int? {
        val m = Regex("^(\\d{1,2})위").find(rankLine.trim()) ?: return null
        val r = m.groupValues[1].toIntOrNull() ?: return null
        return if (r in 1..10) r else null
    }

    fun rankShort(s: WearSnapshot): ShortSpec {
        if (s.kind == "noTeam" || s.myTeamCode.isEmpty()) return ShortSpec(null, "팀 선택")
        val rank = parseRank(s.rankLine)
        return ShortSpec(WearTeam.short(s.myTeamCode), if (rank != null) "${rank}위" else "-")
    }

    fun rankLong(s: WearSnapshot): LongSpec {
        if (s.kind == "noTeam" || s.myTeamCode.isEmpty()) {
            return LongSpec("크보팬", "앱에서 최애팀을 선택하세요")
        }
        // rankLine 문구는 WearFetcher가 SSOT — 표기 변경(#657 등) 자동 상속
        return LongSpec(WearTeam.short(s.myTeamCode), s.rankLine.ifEmpty { "순위 정보 없음" })
    }

    fun rankGauge(s: WearSnapshot): RankGauge? {
        val rank = parseRank(s.rankLine) ?: return null
        return RankGauge((11 - rank).toFloat(), 0f, 10f, "${rank}위")
    }
}
