package fan.keubo.wear

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 팀 변경/해제 atomic invalidation 테스트 (삼순 NO-GO ② — team-switch).
 * FakeSharedPreferences 주입 — Context 불필요.
 */
class WearStoreTest {

    private fun prefsWithLiveCache(team: String): SharedPreferences {
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, team)
        WearStore.saveCachedSnapshot(
            p,
            WearSnapshot(
                kind = "live", myTeamCode = team, awayCode = team, homeCode = "KT",
                awayScore = 3, homeScore = 2, line = "LIVE 7회말", rankLine = "2위",
                updatedAt = 1_000L, startAt = null, bases = null,
            ),
        )
        p.edit().putLong("last_sync_at", 1_000L).putLong("last_sync_attempt_at", 1_000L).apply()
        return p
    }

    @Test
    fun `team change invalidates snapshot and sync markers atomically`() {
        val p = prefsWithLiveCache("LG")
        assertTrue(WearStore.saveMyTeam(p, "SS"))
        assertEquals("SS", WearStore.loadMyTeam(p))
        assertNull(WearStore.loadCachedSnapshot(p)) // 이전 팀(LG) 캐시 잔존 금지
        assertEquals(0L, WearStore.lastSyncAt(p))
        assertEquals(0L, WearStore.lastSyncAttemptAt(p)) // 스로틀 마커도 리셋 → 즉시 재sync 허용
    }

    @Test
    fun `team unset (empty code) also invalidates cache`() {
        val p = prefsWithLiveCache("LG")
        assertTrue(WearStore.saveMyTeam(p, ""))
        assertEquals("", WearStore.loadMyTeam(p))
        assertNull(WearStore.loadCachedSnapshot(p))
    }

    @Test
    fun `same team reselect keeps cache and returns false`() {
        val p = prefsWithLiveCache("LG")
        assertFalse(WearStore.saveMyTeam(p, "LG"))
        assertFalse(WearStore.saveMyTeam(p, " lg ")) // 정규화(trim+upper) 후 동일 판정
        assertNotNull(WearStore.loadCachedSnapshot(p))
        assertEquals(1_000L, WearStore.lastSyncAt(p))
    }

    @Test
    fun `team code is normalized on save`() {
        val p = FakeSharedPreferences()
        assertTrue(WearStore.saveMyTeam(p, " lg "))
        assertEquals("LG", WearStore.loadMyTeam(p))
    }

    @Test
    fun `stale cache from previous team never renders for new team`() {
        // KboGameTileService 렌더 가드와 동일 판정 — 캐시 팀코드 ≠ 현재 팀이면 폐기
        val p = prefsWithLiveCache("LG")
        val cached = WearStore.loadCachedSnapshot(p)!!
        WearStore.saveMyTeam(p, "SS")
        val guard = cached.takeIf { it.myTeamCode.equals(WearStore.loadMyTeam(p), ignoreCase = true) }
        assertNull(guard)
    }
}
