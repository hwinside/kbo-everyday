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

    /** 팀 로고 drawable (폰앱 teamlogo_* 96px 동일 에셋). 미지의 코드는 0(미렌더). */
    fun logoRes(code: String): Int = when (code.uppercase()) {
        "LG" -> R.drawable.teamlogo_lg; "OB" -> R.drawable.teamlogo_ob
        "KT" -> R.drawable.teamlogo_kt; "SK" -> R.drawable.teamlogo_sk
        "NC" -> R.drawable.teamlogo_nc; "HT" -> R.drawable.teamlogo_ht
        "LT" -> R.drawable.teamlogo_lt; "SS" -> R.drawable.teamlogo_ss
        "HH" -> R.drawable.teamlogo_hh; "WO" -> R.drawable.teamlogo_wo
        else -> 0
    }

    /** 타일 리소스 매핑 id — "logo_LG" 형식(양팀 이미지 구분) */
    fun logoResourceId(code: String): String = "logo_${code.uppercase()}"

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

    /**
     * 최애팀 컬러 은은한 카드 틴트 — highlightColor를 다크 베이스에 18% 블렌딩
     * (다크 테마 명도 유지, 삼순 조건: 팀컬러 틴트). 미지의 팀은 중립 카드색.
     */
    fun cardTint(fromId: Int): Int {
        // ⚠️ 알파는 반드시 < 0xFF — Wear OS 3(API 30) 타일 렌더러는 불투명 Box 배경이
        // Image 자식을 가리는 버그가 있다(불투명=로고 미렌더, 반투명=정상 실측).
        // 타일 바탕이 순검정이라 E6(90%) 반투명도 시각적으론 동일한 다크 틴트.
        if (fromId !in 1..10) return 0xE61C1C1F.toInt()
        val c = highlightColor(fromId)
        fun ch(shift: Int): Int =
            (((c shr shift) and 0xFF) * 0.20f + 0x14).toInt().coerceAtMost(0xFF)
        return (0xE6 shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
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
