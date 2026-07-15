package fan.keubo.wear

/**
 * 팀 메타 — 애플워치 WatchTeam(WatchData.swift) + 폰 위젯 TeamRankWidget 매핑의 Kotlin 포트.
 * 값은 웹 SSOT(src/lib/constants/teams.ts)·폰 위젯과 동일하게 유지한다(임의 변경 금지).
 */
object WearTeam {

    /** teamId(1~10) → KBO 2자리 코드 (FCM/위젯/워치 공통 화폐) */
    fun code(fromId: Int): String = when (fromId) {
        1 -> "LG"; 2 -> "OB"; 3 -> "KT"; 4 -> "SK"; 5 -> "NC"
        6 -> "HT"; 7 -> "LT"; 8 -> "SS"; 9 -> "HH"; 10 -> "WO"
        else -> ""
    }

    fun id(fromCode: String): Int = when (fromCode.uppercase()) {
        "LG" -> 1; "OB" -> 2; "KT" -> 3; "SK" -> 4; "NC" -> 5
        "HT" -> 6; "LT" -> 7; "SS" -> 8; "HH" -> 9; "WO" -> 10
        else -> 0
    }

    /** 표시용 짧은 팀명 (GameScoreWidget.SHORT 동일) */
    fun short(code: String): String = when (code.uppercase()) {
        "LG" -> "LG"; "OB" -> "두산"; "KT" -> "KT"; "SK" -> "SSG"; "NC" -> "NC"
        "HT" -> "KIA"; "LT" -> "롯데"; "SS" -> "삼성"; "HH" -> "한화"; "WO" -> "키움"
        else -> code
    }

    /** /api/team-schedule 은 slug를 받는다 (TEAMS.slug 동일) */
    fun slug(fromId: Int): String = when (fromId) {
        1 -> "lg"; 2 -> "doosan"; 3 -> "kt"; 4 -> "ssg"; 5 -> "nc"
        6 -> "kia"; 7 -> "lotte"; 8 -> "samsung"; 9 -> "hanwha"; 10 -> "kiwoom"
        else -> ""
    }

    /**
     * 다크 서페이스용 팀 하이라이트 컬러 — 폰 TeamRankWidget.HL_BY_ID와 동일
     * (badgeOverride > colorLight-if-too-dark > colorPrimary 적용 완료값).
     */
    fun highlightColor(fromId: Int): Int = when (fromId) {
        1 -> 0xFFC60C30.toInt()   // LG
        2 -> 0xFF9BA8D4.toInt()   // 두산
        3 -> 0xFFE85050.toInt()   // KT
        4 -> 0xFFCE0E2D.toInt()   // SSG
        5 -> 0xFF315288.toInt()   // NC
        6 -> 0xFFEA0029.toInt()   // KIA
        7 -> 0xFF6BC4E8.toInt()   // 롯데
        8 -> 0xFF074CA1.toInt()   // 삼성
        9 -> 0xFFFF6600.toInt()   // 한화
        10 -> 0xFFC97088.toInt()  // 키움
        else -> COLOR_TEXT_PRIMARY
    }

    // 크보팬 다크 테마 토큰 (TeamRankWidget 동일)
    const val COLOR_BG = 0xFF0A0A0B.toInt()
    const val COLOR_TEXT_PRIMARY = 0xFFF5F5F7.toInt()
    const val COLOR_TEXT_SECONDARY = 0xFFBCBCC1.toInt()
    const val COLOR_TEXT_TERTIARY = 0xFF8E8E93.toInt()

    // 임박(1h 이내) 카운트다운 앰버 — 애플워치 #635 동일 (1.0, 0.58, 0.0)
    const val COLOR_AMBER = 0xFFFF9400.toInt()

    // 라이브 강조 / 잔루 다이아몬드 점유색 — 애플워치 BaseDiamond onColor (1.0, 0.42, 0.48)
    const val COLOR_LIVE = 0xFFFF6B7A.toInt()
}
