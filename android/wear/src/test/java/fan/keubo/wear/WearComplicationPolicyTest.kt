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
    fun `live short는 이닝 title + away-home 스코어`() {
        val s = snap("live", line = "LIVE 8회말 · 2사")
        val spec = WearComplicationPolicy.gameShort(s, noonMs)
        assertEquals("8회말", spec.title)
        assertEquals("1:4", spec.text)
        assertNull(spec.countdownToMs)
    }

    @Test
    fun `final short는 종료 title + 스코어`() {
        val spec = WearComplicationPolicy.gameShort(snap("final"), noonMs)
        assertEquals("종료", spec.title)
        assertEquals("1:4", spec.text)
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
