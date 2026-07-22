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
        // 방금 push(syncedAt) → 20초 이내는 fresh, 20초 초과는 stale(폴백 pull 발동)
        assertFalse(WearTilePolicy.isStale(cached, syncedAt, syncedAt + 20_000L))
        assertTrue(WearTilePolicy.isStale(cached, syncedAt, syncedAt + 20_001L))
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

    // ── 삼순 #723 재리뷰 P0 — ① pull CAS + ④ NoOp lastSeenAt ──

    private fun finalSnap(team: String) = WearSnapshot(
        kind = "final", myTeamCode = team, awayCode = team, homeCode = "KT",
        awayScore = 5, homeScore = 2, line = "경기 종료 · 승", rankLine = "2위",
        updatedAt = 2_000L, startAt = null, bases = null, gameId = "G1", sourceAt = 200L,
    )

    @Test
    fun `pull commit is dropped when a push arrived during the pull (CAS by rev)`() {
        // 시나리오: pull 시작(rev 측정) → final push 커밋(rev+1) → 늦은 pull 완료
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        val revBefore = WearStore.pushRevision(p) // pull 시작 시점
        // pull 진행 중 final push 도착·커밋
        WearStore.savePushSnapshot(p, finalSnap("LG"), ts = 200L, gid = "G1")
        // 늦은 pull이 stale live로 덮으려 시도 → CAS가 막음
        val committed = WearStore.commitPullSnapshot(p, liveSnap("LG"), revBefore)
        assertFalse(committed)
        assertEquals("final", WearStore.loadCachedSnapshot(p)!!.kind)
    }

    @Test
    fun `pull commit dropped for same-ts terminal during pull (samsoon 723 rev CAS)`() {
        // 삼순 #723 2차: 동일-ts terminal(live ts=100 → final ts=100)은 ts만 보면 100→100이라
        // 변화 미감지되던 케이스 — pushRevision은 +1 되므로 CAS가 정상 차단.
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        val revBefore = WearStore.pushRevision(p)
        // pull 중 *동일 ts=100* final push(정책상 동일-ts terminal 허용)
        WearStore.savePushSnapshot(p, finalSnap("LG").copy(sourceAt = 100L), ts = 100L, gid = "G1")
        val committed = WearStore.commitPullSnapshot(p, liveSnap("LG"), revBefore)
        assertFalse(committed) // rev 불일치 → 늦은 pull 폐기(FINAL 보존)
        assertEquals("final", WearStore.loadCachedSnapshot(p)!!.kind)
    }

    @Test
    fun `pull commit succeeds when no push arrived during the pull`() {
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        val revBefore = WearStore.pushRevision(p)
        val next = liveSnap("LG").copy(line = "LIVE 8회초", sourceAt = 150L)
        val committed = WearStore.commitPullSnapshot(p, next, revBefore)
        assertTrue(committed)
        assertEquals("LIVE 8회초", WearStore.loadCachedSnapshot(p)!!.line)
    }

    @Test
    fun `push meta (NoOp) advances snapshot updatedAt to prevent false stale badge`() {
        // 삼순 #723 — NoOp lastSeenAt: 내용 동일이어도 updatedAt을 갱신해 5분 뒤 가짜 '지연' 배지 방지
        val p = FakeSharedPreferences()
        WearStore.saveMyTeam(p, "LG")
        WearStore.savePushSnapshot(p, liveSnap("LG"), ts = 100L, gid = "G1")
        val before = WearStore.loadCachedSnapshot(p)!!.updatedAt
        WearStore.savePushMeta(p, ts = 200L, gid = "G1")
        val after = WearStore.loadCachedSnapshot(p)!!.updatedAt
        assertTrue("updatedAt must advance on NoOp", after > before)
        // 내용(line)은 그대로 — 재렌더 트리거 아님
        assertEquals("LIVE 7회말 · 2사", WearStore.loadCachedSnapshot(p)!!.line)
    }
}
