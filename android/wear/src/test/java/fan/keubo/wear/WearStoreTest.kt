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

    // ── push bridge 마커(디스커넥트 fallback 억제 + 팀변경 무효화) ──

    private fun liveSnap(team: String) = WearSnapshot(
        kind = "live", myTeamCode = team, awayCode = team, homeCode = "KT",
        awayScore = 3, homeScore = 2, line = "LIVE 7회말 · 2사", rankLine = "2위",
        updatedAt = 1_000L, startAt = null, bases = null,
    )

    @Test
    fun `push snapshot marks synced so fallback pull is suppressed`() {
        // 삼순 조건: Data Layer snapshot이 신선하면 direct pull 생략 →
        // savePushSnapshot이 last_sync_at=now로 갱신해 isStale=false(방금 push는 최신).
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        assertEquals(100L, WearStore.lastPushTs(p))
        assertEquals("G1", WearStore.lastPushGid(p))
        val syncedAt = WearStore.lastSyncAt(p)
        val cached = WearStore.loadCachedSnapshot(p)!!
        // 방금 push(syncedAt) → 45초 이내는 fresh, 45초 초과는 stale(폴백 pull 발동)
        assertFalse(WearTilePolicy.isStale(cached, syncedAt, syncedAt + 45_000L))
        assertTrue(WearTilePolicy.isStale(cached, syncedAt, syncedAt + 45_001L))
    }

    @Test
    fun `push meta advances ts without changing snapshot`() {
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        WearStore.savePushMeta(p, ts = 200L, gid = "G1")
        assertEquals(200L, WearStore.lastPushTs(p))
        // 스냅샷은 그대로(NoOp)
        assertEquals("LIVE 7회말 · 2사", WearStore.loadCachedSnapshot(p)!!.line)
    }

    @Test
    fun `team change clears push markers`() {
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        WearStore.saveMyTeam(p, "SS")
        assertEquals(0L, WearStore.lastPushTs(p))
        assertEquals("", WearStore.lastPushGid(p))
    }
}
