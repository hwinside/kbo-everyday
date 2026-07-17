package fan.keubo.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * 슬라이스 B 컴플리케이션 정책 유닛테스트 — 경기 LONG_TEXT, 순위 SHORT/LONG/RANGED 매핑과
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
