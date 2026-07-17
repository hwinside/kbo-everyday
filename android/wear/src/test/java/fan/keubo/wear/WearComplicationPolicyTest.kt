package fan.keubo.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * 슬라이스 B 컴플리케이션 정책 유닛테스트 — 상태별 SHORT/LONG/RANGED 매핑과
 * rankLine 파싱 경계를 검증한다(순수 함수, androidx 불필요).
 */
class WearComplicationPolicyTest {

    private val kst = ZoneId.of("Asia/Seoul")

    /** 2026-07-16 12:00 KST — 06시 롤오버 이후의 평범한 낮 시각. */
    private val noonMs = ZonedDateTime.of(2026, 7, 16, 12, 0, 0, 0, kst)
        .toInstant().toEpochMilli()

    // 기본 픽스처: 롯데(LT) @ 삼성(SS), 내팀 = 삼성(홈)
    private fun snap(
        kind: String,
        my: String = "SS",
        away: String = "LT",
        home: String = "SS",
        aScore: Int = 1,
        hScore: Int = 4,
        line: String = "",
        rankLine: String = "2위 · 1.5G",
        startAt: Long? = null,
    ) = WearSnapshot(
        kind = kind, myTeamCode = my, awayCode = away, homeCode = home,
        awayScore = aScore, homeScore = hScore, line = line, rankLine = rankLine,
        updatedAt = noonMs, startAt = startAt, bases = null,
    )

    // ── 경기 SHORT_TEXT ──

    @Test
    fun `live short는 이닝 title + 내팀 우선 라벨 스코어`() {
        val s = snap("live", line = "LIVE 8회말 · 2사")
        val spec = WearComplicationPolicy.gameShort(s, noonMs)
        assertEquals("8회말", spec.title)
        assertEquals("삼성 4:1", spec.text) // 내팀 SS(홈) 4점이 앞 + 약어
        assertNull(spec.countdownToMs)
    }

    @Test
    fun `final short는 종료 title + 내팀 우선 스코어`() {
        val spec = WearComplicationPolicy.gameShort(snap("final"), noonMs)
        assertEquals("종료", spec.title)
        assertEquals("삼성 4:1", spec.text)
    }

    // ── myTeamShort 표기 규칙 ──

    @Test
    fun `myTeamShort는 내팀 점수가 앞 - 원정이어도`() {
        // 내팀 LG가 원정(away=LG 1, home=SS 6) → "LG 1:6"
        val s = snap("live", my = "LG", away = "LG", home = "SS", aScore = 1, hScore = 6)
        assertEquals("LG 1:6", WearComplicationPolicy.myTeamShort(s, "8회말").text)
        // 내팀 LG가 홈(away=KT 6, home=LG 1) → 여전히 내 점수 1이 앞
        val s2 = snap("live", my = "LG", away = "KT", home = "LG", aScore = 6, hScore = 1)
        assertEquals("LG 1:6", WearComplicationPolicy.myTeamShort(s2, "8회말").text)
    }

    @Test
    fun `myTeamShort 7자 초과 시 공백 제거 - title은 그대로`() {
        // "KIA 10:4" = 8자 → 공백 제거 "KIA10:4" = 7자 OK
        val s = snap("live", my = "HT", away = "HT", home = "SS", aScore = 10, hScore = 4)
        val spec = WearComplicationPolicy.myTeamShort(s, "8회말")
        assertEquals("8회말", spec.title)
        assertEquals("KIA10:4", spec.text)
    }

    @Test
    fun `myTeamShort 양쪽 두 자릿수 overflow에서도 팀 식별 보존 - KIA 홈과 원정`() {
        // #666 삼순 블로커: 약어를 버리면 "10:12"로 퇴행 → 약어는 title로 이동해 보존
        // KIA 원정(away=HT 10, home=SS 12): "KIA10:12" = 8자 초과 → title "8회말·KIA", text "10:12"
        val away = snap("live", my = "HT", away = "HT", home = "SS", aScore = 10, hScore = 12)
        val awaySpec = WearComplicationPolicy.myTeamShort(away, "8회말")
        assertEquals("8회말·KIA", awaySpec.title)
        assertEquals("10:12", awaySpec.text) // 내 점수 10이 앞
        // KIA 홈(away=SS 12, home=HT 10): 내 점수 10이 여전히 앞
        val home = snap("live", my = "HT", away = "SS", home = "HT", aScore = 12, hScore = 10)
        val homeSpec = WearComplicationPolicy.myTeamShort(home, "8회말")
        assertEquals("8회말·KIA", homeSpec.title)
        assertEquals("10:12", homeSpec.text)
    }

    @Test
    fun `myTeamShort 양쪽 두 자릿수 overflow에서도 팀 식별 보존 - SSG 홈과 원정`() {
        // SSG 원정(away=SK 11, home=LG 10): "SSG11:10" = 8자 초과 → title로 이동
        val away = snap("live", my = "SK", away = "SK", home = "LG", aScore = 11, hScore = 10)
        val awaySpec = WearComplicationPolicy.myTeamShort(away, "9회초")
        assertEquals("9회초·SSG", awaySpec.title)
        assertEquals("11:10", awaySpec.text)
        // SSG 홈(away=LG 10, home=SK 11): 내 점수 11이 앞
        val home = snap("live", my = "SK", away = "LG", home = "SK", aScore = 10, hScore = 11)
        val homeSpec = WearComplicationPolicy.myTeamShort(home, "9회초")
        assertEquals("9회초·SSG", homeSpec.title)
        assertEquals("11:10", homeSpec.text)
    }

    @Test
    fun `overflow가 gameShort final에서도 title 병기로 전파`() {
        // final + KIA 10:12 → title "종료·KIA", text "10:12"
        val s = snap("final", my = "HT", away = "HT", home = "SS", aScore = 10, hScore = 12)
        val spec = WearComplicationPolicy.gameShort(s, noonMs)
        assertEquals("종료·KIA", spec.title)
        assertEquals("10:12", spec.text)
    }

    @Test
    fun `myTeamShort 한글 약어도 7자 이내 유지`() {
        // "삼성 10:4" = 7자 → 공백 포함 그대로
        val s = snap("live", aScore = 4, hScore = 10)
        assertEquals("삼성 10:4", WearComplicationPolicy.myTeamShort(s, "8회말").text)
        // 한글 약어 × 양쪽 두 자릿수: "삼성 10:12" = 8자 → 공백 제거 "삼성10:12" = 7자 OK
        val s2 = snap("live", aScore = 12, hScore = 10)
        assertEquals("삼성10:12", WearComplicationPolicy.myTeamShort(s2, "8회말").text)
    }

    @Test
    fun `오늘 시작 전 scheduled는 카운트다운 모드`() {
        val start = noonMs + 5 * 3600_000L // 오늘 17:00
        val spec = WearComplicationPolicy.gameShort(snap("scheduled", startAt = start), noonMs)
        assertEquals("vs 롯데", spec.title) // 내팀 SS(홈) → 상대는 원정 LT
        assertEquals(start, spec.countdownToMs)
    }

    @Test
    fun `오늘 시작시각 지난 scheduled는 곧 시작`() {
        val start = noonMs - 10 * 60_000L
        val spec = WearComplicationPolicy.gameShort(snap("scheduled", startAt = start), noonMs)
        assertEquals("곧 시작", spec.text)
        assertNull(spec.countdownToMs)
    }

    @Test
    fun `미래 날짜 scheduled는 날짜 라벨`() {
        val start = ZonedDateTime.of(2026, 7, 18, 18, 30, 0, 0, kst)
            .toInstant().toEpochMilli()
        val spec = WearComplicationPolicy.gameShort(snap("scheduled", startAt = start), noonMs)
        assertEquals("7/18", spec.text)
        assertNull(spec.countdownToMs)
    }

    @Test
    fun `startAt 없는 scheduled는 예정 폴백`() {
        val spec = WearComplicationPolicy.gameShort(snap("scheduled"), noonMs)
        assertEquals("예정", spec.text)
    }

    @Test
    fun `scheduled title은 내팀 제외 상대팀`() {
        // LG가 홈: away=KT, home=LG → 상대는 KT
        val s = snap("scheduled", my = "LG", away = "KT", home = "LG")
        assertEquals("vs KT", WearComplicationPolicy.gameShort(s, noonMs).title)
        // LG가 원정: away=LG, home=SS → 상대는 삼성
        val s2 = snap("scheduled", my = "LG", away = "LG", home = "SS")
        assertEquals("vs 삼성", WearComplicationPolicy.gameShort(s2, noonMs).title)
    }

    @Test
    fun `noGame-noTeam-cancelled short 폴백`() {
        assertEquals("경기없음", WearComplicationPolicy.gameShort(snap("noGame"), noonMs).text)
        assertEquals("팀 선택", WearComplicationPolicy.gameShort(snap("noTeam", my = ""), noonMs).text)
        assertEquals("취소", WearComplicationPolicy.gameShort(snap("cancelled"), noonMs).text)
    }

    // ── 경기 LONG_TEXT ──

    @Test
    fun `live long은 매치업 스코어 title + 상황 줄`() {
        val s = snap("live", line = "LIVE 8회말 · 2사")
        val spec = WearComplicationPolicy.gameLong(s)
        assertEquals("롯데 1:4 삼성", spec.title) // 원정 좌·홈 우 고정(#650)
        assertEquals("LIVE 8회말 · 2사", spec.text)
    }

    @Test
    fun `scheduled long은 vs 매치업 + line`() {
        val s = snap("scheduled", line = "오늘 18:30 · 잠실")
        val spec = WearComplicationPolicy.gameLong(s)
        assertEquals("롯데 vs 삼성", spec.title)
        assertEquals("오늘 18:30 · 잠실", spec.text)
    }

    // ── liveInningLabel 파싱 ──

    @Test
    fun `liveInningLabel은 이닝만 추출하고 형식 이탈 시 LIVE 폴백`() {
        assertEquals("8회말", WearComplicationPolicy.liveInningLabel("LIVE 8회말 · 2사"))
        assertEquals("1회초", WearComplicationPolicy.liveInningLabel("LIVE 1회초 · 0사"))
        assertEquals("LIVE", WearComplicationPolicy.liveInningLabel("LIVE"))
        assertEquals("LIVE", WearComplicationPolicy.liveInningLabel(""))
    }

    // ── 순위 파싱/게이지 ──

    @Test
    fun `parseRank 경계값`() {
        assertEquals(2, WearComplicationPolicy.parseRank("2위 · 1.5G"))
        assertEquals(10, WearComplicationPolicy.parseRank("10위"))
        assertEquals(1, WearComplicationPolicy.parseRank("1위"))
        assertNull(WearComplicationPolicy.parseRank(""))
        assertNull(WearComplicationPolicy.parseRank("위"))
        assertNull(WearComplicationPolicy.parseRank("순위 정보 없음"))
        assertNull(WearComplicationPolicy.parseRank("11위")) // 범위 밖
    }

    @Test
    fun `rankShort는 팀명 title + N위`() {
        val spec = WearComplicationPolicy.rankShort(snap("noGame"))
        assertEquals("삼성", spec.title)
        assertEquals("2위", spec.text)
        // 순위 미확보 → "-"
        assertEquals("-", WearComplicationPolicy.rankShort(snap("noGame", rankLine = "")).text)
        // noTeam → 팀 선택
        assertEquals("팀 선택", WearComplicationPolicy.rankShort(snap("noTeam", my = "")).text)
    }

    @Test
    fun `rankLong은 rankLine을 그대로 상속`() {
        val spec = WearComplicationPolicy.rankLong(snap("noGame", rankLine = "2위 · 1.5G"))
        assertEquals("삼성", spec.title)
        assertEquals("2위 · 1.5G", spec.text)
        assertEquals("순위 정보 없음", WearComplicationPolicy.rankLong(snap("noGame", rankLine = "")).text)
    }

    @Test
    fun `rankGauge는 1위=10 게이지, 미확보면 null`() {
        val g = WearComplicationPolicy.rankGauge(snap("noGame", rankLine = "2위 · 1.5G"))
        assertNotNull(g)
        assertEquals(9f, g!!.value)
        assertEquals(0f, g.min)
        assertEquals(10f, g.max)
        assertEquals("2위", g.label)
        val first = WearComplicationPolicy.rankGauge(snap("noGame", rankLine = "1위"))
        assertEquals(10f, first!!.value)
        assertNull(WearComplicationPolicy.rankGauge(snap("noGame", rankLine = "")))
    }
}
