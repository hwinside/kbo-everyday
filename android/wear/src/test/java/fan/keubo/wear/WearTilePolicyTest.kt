package fan.keubo.wear

import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 캐시 신선도·sync 스로틀·카운트다운 경계값 테스트 (삼순 NO-GO ③ — cache/team-switch/countdown).
 * 모든 시각은 nowMs 주입 — 시스템 시계 의존 없음.
 */
class WearTilePolicyTest {

    private val kst = ZoneId.of("Asia/Seoul")

    private fun kstMillis(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        ZonedDateTime.of(y, mo, d, h, mi, 0, 0, kst).toInstant().toEpochMilli()

    // 기준 시각: 2026-07-15(수) 12:00 KST
    private val now = kstMillis(2026, 7, 15, 12, 0)

    private fun snap(kind: String, startAt: Long? = null) = WearSnapshot(
        kind = kind, myTeamCode = "LG", awayCode = "LG", homeCode = "KT",
        awayScore = 0, homeScore = 0, line = "", rankLine = "",
        updatedAt = now, startAt = startAt, bases = null,
    )

    // --- isStale: kind별 임계 경계 ---

    @Test
    fun `live cache stale strictly after 20s`() {
        // push bridge가 주경로 — STALE_LIVE_MS는 폰 단절 시 pull 폴백 임계(20초, freshness 30초보다 짧음)
        val live = snap("live")
        assertFalse(WearTilePolicy.isStale(live, now - 20_000L, now))
        assertTrue(WearTilePolicy.isStale(live, now - 20_001L, now))
    }

    @Test
    fun `today scheduled cache stale after 5m`() {
        val todayGame = snap("scheduled", startAt = kstMillis(2026, 7, 15, 18, 30))
        assertFalse(WearTilePolicy.isStale(todayGame, now - 5 * 60_000L, now))
        assertTrue(WearTilePolicy.isStale(todayGame, now - 5 * 60_000L - 1, now))
    }

    @Test
    fun `future scheduled and idle kinds stale after 15m`() {
        val futureGame = snap("scheduled", startAt = kstMillis(2026, 7, 16, 18, 30))
        val final = snap("final")
        for (s in listOf(futureGame, final)) {
            assertFalse(WearTilePolicy.isStale(s, now - 15 * 60_000L, now))
            assertTrue(WearTilePolicy.isStale(s, now - 15 * 60_000L - 1, now))
        }
    }

    // --- canAttemptSync: 재시도 스로틀 경계 ---

    @Test
    fun `sync throttled within 20s of last attempt`() {
        // renderer inter-update 20초 선례(삼순 정정) — push bridge 주경로라 실 pull은 폰 단절 시만
        assertFalse(WearTilePolicy.canAttemptSync(now - 19_999L, now))
        assertTrue(WearTilePolicy.canAttemptSync(now - 20_000L, now))
        assertTrue(WearTilePolicy.canAttemptSync(0L, now)) // 첫 시도
    }

    // --- freshnessForMs: kind별 힌트 ---

    @Test
    fun `freshness hints per kind`() {
        // live 60초 — AndroidX Tiles 계약 준수(1분 미만 throttle), 20~40초는 push bridge가 달성
        // live 30초 fallback(60초 하한 없음), 20~40초는 push bridge가 달성
        assertEquals(30_000L, WearTilePolicy.freshnessForMs(snap("live"), now))
        assertEquals(60_000L, WearTilePolicy.freshnessForMs(snap("loading"), now))
        assertEquals(30 * 60_000L, WearTilePolicy.freshnessForMs(snap("final"), now))
        // 오늘 아닌 예정 경기 → 30분
        val future = snap("scheduled", startAt = kstMillis(2026, 7, 16, 18, 30))
        assertEquals(30 * 60_000L, WearTilePolicy.freshnessForMs(future, now))
    }

    @Test
    fun `today scheduled freshness clamps between 1m and 30m`() {
        // 시작 10분 전 → untilStart 그대로
        val in10m = snap("scheduled", startAt = now + 10 * 60_000L)
        assertEquals(10 * 60_000L, WearTilePolicy.freshnessForMs(in10m, now))
        // 시작 10초 전 → 1분 하한
        val in10s = snap("scheduled", startAt = now + 10_000L)
        assertEquals(60_000L, WearTilePolicy.freshnessForMs(in10s, now))
        // 시작 6시간 전(같은 날) → 30분 상한
        val evening = snap("scheduled", startAt = kstMillis(2026, 7, 15, 18, 30))
        assertEquals(30 * 60_000L, WearTilePolicy.freshnessForMs(evening, now))
    }

    @Test
    fun `started but still scheduled retries at 4m`() {
        // 시작시각이 지났는데 API가 아직 scheduled — #635 4분 retry 패리티
        val started = snap("scheduled", startAt = now - 60_000L)
        assertEquals(4 * 60_000L, WearTilePolicy.freshnessForMs(started, now))
    }

    // --- staticCountdownLabel: 애플워치 #635 라벨 규칙 ---

    @Test
    fun `countdown label uses sentence form`() {
        // 하린아빠 7/16 실기기 피드백: "5:27 후" → "5시간 27분 후 시작"
        assertEquals("5시간 41분 후 시작", WearTilePolicy.staticCountdownLabel(now + (5 * 60 + 41) * 60_000L, now))
        assertEquals("41분 후 시작", WearTilePolicy.staticCountdownLabel(now + 41 * 60_000L, now))
        assertEquals("1시간 0분 후 시작", WearTilePolicy.staticCountdownLabel(now + 60 * 60_000L, now))
        assertEquals("59분 후 시작", WearTilePolicy.staticCountdownLabel(now + 60 * 60_000L - 1_000L, now))
        assertEquals("1분 후 시작", WearTilePolicy.staticCountdownLabel(now + 30_000L, now)) // 0분은 1분으로
        assertEquals("곧 시작", WearTilePolicy.staticCountdownLabel(now, now))
        assertEquals("곧 시작", WearTilePolicy.staticCountdownLabel(now - 1_000L, now))
    }

    // --- isCountdownToday: 06시 롤오버 ---

    @Test
    fun `countdown today follows 6am rollover`() {
        val game = kstMillis(2026, 7, 15, 18, 30)
        assertTrue(WearFetcher.isCountdownToday(game, kstMillis(2026, 7, 15, 12, 0)))
        // 익일 01시(06시 롤오버 전)는 아직 "오늘"
        assertTrue(WearFetcher.isCountdownToday(game, kstMillis(2026, 7, 16, 1, 0)))
        // 익일 06시 이후는 내일
        assertFalse(WearFetcher.isCountdownToday(game, kstMillis(2026, 7, 16, 6, 0)))
        // 전날 기준으로는 미래 경기
        assertFalse(WearFetcher.isCountdownToday(game, kstMillis(2026, 7, 14, 12, 0)))
    }

    // --- WearSnapshot: 캐시 JSON 라운드트립 (cache-first 렌더의 원천) ---

    @Test
    fun `snapshot json roundtrip preserves all fields`() {
        val original = WearSnapshot(
            kind = "live", myTeamCode = "LG", awayCode = "LG", homeCode = "KT",
            awayScore = 3, homeScore = 2, line = "LIVE 7회말 · 1사", rankLine = "2위 · 1위와 1.5경기차",
            updatedAt = now, startAt = null,
            bases = WearBases(first = true, second = false, third = true),
        )
        assertEquals(original, WearSnapshot.fromJson(original.toJson()))
    }

    @Test
    fun `snapshot json roundtrip with nullable fields absent`() {
        val scheduled = snap("scheduled", startAt = kstMillis(2026, 7, 15, 18, 30))
        assertEquals(scheduled, WearSnapshot.fromJson(scheduled.toJson()))
        val noBases = snap("final")
        assertNull(WearSnapshot.fromJson(noBases.toJson())?.bases)
    }

    @Test
    fun `corrupt snapshot json returns null instead of crashing tile`() {
        assertNull(WearSnapshot.fromJson(null))
        assertNull(WearSnapshot.fromJson(""))
        assertNull(WearSnapshot.fromJson("{not json"))
    }

    // --- 카드 팀컬러 틴트 (삼순 조건 — 다크 테마 명도 유지) ---

    @Test
    fun `card tint is translucent (API30 image bug guard), dark, neutral for unknown team`() {
        for (id in 1..10) {
            val c = WearTeam.cardTint(id)
            // 불투명(0xFF) 금지 — Wear OS 3 렌더러에서 불투명 Box 배경이 Image 자식을 가림
            assertEquals(0xE6, (c ushr 24))
            for (shift in intArrayOf(16, 8, 0)) {
                val ch = (c shr shift) and 0xFF
                assertTrue("team $id channel too bright: $ch", ch <= 0x48) // 은은한 다크 틴트
            }
        }
        assertEquals(0xE61C1C1F.toInt(), WearTeam.cardTint(0))
        assertEquals(0xE61C1C1F.toInt(), WearTeam.cardTint(99))
    }

    @Test
    fun `bases any true only when runner on base`() {
        assertFalse(WearBases(false, false, false).any) // 주자 0명 → 다이아몬드 미렌더(#635 패리티)
        assertTrue(WearBases(true, false, false).any)
        assertTrue(WearBases(false, false, true).any)
    }
}
