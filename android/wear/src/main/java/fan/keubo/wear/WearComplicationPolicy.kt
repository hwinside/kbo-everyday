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

    /**
     * SHORT_TEXT 스코어 — 내 팀 점수를 앞에 + 팀 약어(하린아빠 갤워치 피드백: "6:1"만으로는
     * 어느 점수가 내 팀인지 알 수 없음 — 애플워치 원형 컴플리케이션 #635 동일 원칙).
     * SHORT_TEXT 권장 한도(7자) 초과 시: 공백 제거 → 그래도 초과면 약어 생략(내 점수 앞 순서는 유지).
     */
    fun myTeamScore(s: WearSnapshot): String {
        val myIsAway = s.awayCode.equals(s.myTeamCode, ignoreCase = true)
        val my = if (myIsAway) s.awayScore else s.homeScore
        val opp = if (myIsAway) s.homeScore else s.awayScore
        val abbr = WearTeam.short(s.myTeamCode)
        if (abbr.isEmpty()) return "$my:$opp"
        val spaced = "$abbr $my:$opp"
        val tight = "$abbr$my:$opp"
        return when {
            spaced.length <= 7 -> spaced
            tight.length <= 7 -> tight
            else -> "$my:$opp"
        }
    }

    private fun matchupVs(s: WearSnapshot): String =
        "${WearTeam.short(s.awayCode)} vs ${WearTeam.short(s.homeCode)}"

    private fun opponentShort(s: WearSnapshot): String {
        val opp = if (s.awayCode.equals(s.myTeamCode, ignoreCase = true)) s.homeCode else s.awayCode
        return WearTeam.short(opp)
    }

    /** live line "LIVE 8회말 · 2사" → "8회말"(이닝만). 형식 벗어나면 "LIVE" 폴백. */
    fun liveInningLabel(line: String): String {
        val inning = line.removePrefix("LIVE").trim().substringBefore("·").trim()
        return inning.ifEmpty { "LIVE" }
    }

    // ── ① 경기 데이터소스 ──

    fun gameShort(s: WearSnapshot, nowMs: Long): ShortSpec = when (s.kind) {
        "live" -> ShortSpec(liveInningLabel(s.line), myTeamScore(s))
        "final" -> ShortSpec("종료", myTeamScore(s))
        "cancelled" -> ShortSpec(WearTeam.short(s.myTeamCode), "취소")
        "scheduled" -> {
            val title = "vs ${opponentShort(s)}"
            val start = s.startAt
            when {
                start == null -> ShortSpec(title, "예정")
                // 오늘(06시 롤오버 기준) 경기: 시작 전엔 자동 카운트다운, 시작 후 API 지연엔 "곧 시작"
                WearFetcher.isCountdownToday(start, nowMs) ->
                    if (start > nowMs) ShortSpec(title, "", countdownToMs = start)
                    else ShortSpec(title, "곧 시작")
                else -> ShortSpec(title, WearFetcher.futureDateLabel(start))
            }
        }
        "noTeam" -> ShortSpec(null, "팀 선택")
        "loading" -> ShortSpec(WearTeam.short(s.myTeamCode), "…")
        else -> ShortSpec(WearTeam.short(s.myTeamCode), "경기없음") // noGame
    }

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
