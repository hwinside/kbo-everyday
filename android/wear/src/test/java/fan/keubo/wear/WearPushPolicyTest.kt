package fan.keubo.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * push bridge(/kbo/game_state) 게이트 회귀 테스트 (삼순 NO-GO 주경로 전환).
 * 삼순 요구 게이트: stale/out-of-order 역전 차단 · duplicate no-op · wrong-team drop ·
 * cancel/end 즉시 수렴 · terminal 고착 · content signature(무변화 재렌더 방지) · disconnected fallback.
 */
class WearPushPolicyTest {

    private val now = 1_800_000_000_000L

    private fun push(
        kind: String = "live",
        gid: String = "G1",
        ts: Long = now,
        away: String = "LG",
        home: String = "KT",
        awayScore: Int = 3,
        homeScore: Int = 2,
        status: String = "LIVE 7회말",
        outs: Int? = 2,
        diamond: String? = "101",
        stadium: String? = "잠실",
        pitcher: String? = "손아섭",
        batter: String? = "오지환",
        lastPlay: String? = null,
    ) = WearPushPolicy.PushState(
        gid, ts, kind, away, home, awayScore, homeScore, status,
        outs, diamond, stadium, pitcher, batter, lastPlay,
    )

    private fun cachedLive(
        away: String = "LG", home: String = "KT",
        awayScore: Int = 3, homeScore: Int = 2,
        kind: String = "live", line: String = "LIVE 7회말 · 2사",
    ) = WearSnapshot(
        kind = kind, myTeamCode = "LG", awayCode = away, homeCode = home,
        awayScore = awayScore, homeScore = homeScore, line = line, rankLine = "2위",
        updatedAt = now - 30_000L, startAt = null,
        bases = WearBases(first = true, second = false, third = true),
        venue = "잠실", outs = 2, pitcher = "손아섭", batter = "오지환",
    )

    private fun eval(
        push: WearPushPolicy.PushState,
        myTeam: String = "LG",
        cached: WearSnapshot? = null,
        lastPushTs: Long = 0L,
        lastPushGid: String = "",
    ) = WearPushPolicy.evaluate(myTeam, push, cached, lastPushTs, lastPushGid, now)

    // ── accept / render ──

    @Test
    fun `live push renders snapshot from w fields`() {
        val d = eval(push()) as WearPushPolicy.Decision.Render
        val s = d.snapshot
        assertEquals("live", s.kind)
        assertEquals("LG", s.awayCode)
        assertEquals("KT", s.homeCode)
        assertEquals(3, s.awayScore)
        assertEquals("LIVE 7회말 · 2사", s.line)      // status + outs 정규화
        assertEquals(true, s.bases?.first)             // diamond "101" → 1·3루
        assertEquals(false, s.bases?.second)
        assertEquals(true, s.bases?.third)
        assertEquals("잠실", s.venue)
        assertEquals(now, s.updatedAt)
    }

    @Test
    fun `changed score renders`() {
        val d = eval(push(awayScore = 4, ts = now + 1), cached = cachedLive(), lastPushTs = now, lastPushGid = "G1")
        assertTrue(d is WearPushPolicy.Decision.Render)
    }

    // ── duplicate no-op ──

    @Test
    fun `duplicate content is noop`() {
        // 캐시와 렌더 영향 필드가 동일한 push(ts만 다름) → NoOp(재렌더 없음)
        val cached = cachedLive()
        val d = eval(push(ts = now + 5_000), cached = cached, lastPushTs = now, lastPushGid = "G1")
        assertTrue(d is WearPushPolicy.Decision.NoOp)
    }

    // ── stale / out-of-order ──

    @Test
    fun `out of order same game dropped`() {
        val d = eval(push(ts = now - 10_000), cached = cachedLive(), lastPushTs = now, lastPushGid = "G1")
        assertEquals("stale-ts", (d as WearPushPolicy.Decision.Drop).reason)
    }

    @Test
    fun `older ts on new game is not stale`() {
        // gid가 다르면 새 경기 → ts 역전 게이트 우회(정상 렌더)
        val d = eval(push(gid = "G2", ts = now - 10_000, awayScore = 9), lastPushTs = now, lastPushGid = "G1")
        assertTrue(d is WearPushPolicy.Decision.Render)
    }

    // ── wrong-team ──

    @Test
    fun `wrong team dropped`() {
        val d = eval(push(away = "SS", home = "HH"), myTeam = "LG")
        assertEquals("wrong-team", (d as WearPushPolicy.Decision.Drop).reason)
    }

    @Test
    fun `my team as home not dropped`() {
        val d = eval(push(away = "KT", home = "LG"), myTeam = "LG")
        assertTrue(d is WearPushPolicy.Decision.Render)
    }

    @Test
    fun `empty team drops`() {
        val d = eval(push(), myTeam = "")
        assertEquals("no-team", (d as WearPushPolicy.Decision.Drop).reason)
    }

    // ── cancel / end 수렴 ──

    @Test
    fun `cancel converges`() {
        val d = eval(push(kind = "cancelled"), cached = cachedLive()) as WearPushPolicy.Decision.Render
        assertEquals("cancelled", d.snapshot.kind)
        assertEquals("경기 취소", d.snapshot.line)
    }

    @Test
    fun `final with teams renders win`() {
        val d = eval(
            push(kind = "final", away = "LG", home = "KT", awayScore = 5, homeScore = 3),
            cached = cachedLive(),
        ) as WearPushPolicy.Decision.Render
        assertEquals("final", d.snapshot.kind)
        assertEquals("경기 종료 · 승", d.snapshot.line) // LG(원정) 5 > KT 3
    }

    @Test
    fun `final minimal flips cached live to final`() {
        // game_end 최소 payload(팀 없음) → 캐시 live를 종료로 flip
        val d = eval(
            push(kind = "final", away = "", home = "", status = ""),
            cached = cachedLive(awayScore = 5, homeScore = 3),
        ) as WearPushPolicy.Decision.Render
        assertEquals("final", d.snapshot.kind)
        assertEquals("경기 종료 · 승", d.snapshot.line)
        assertNull(d.snapshot.bases)
    }

    @Test
    fun `final minimal does not flip scheduled card`() {
        // 예정/다음경기 카드를 0:0 종료로 오변환하면 안 됨
        val sched = WearSnapshot(
            kind = "scheduled", myTeamCode = "LG", awayCode = "LG", homeCode = "KT",
            awayScore = 0, homeScore = 0, line = "오늘 18:30", rankLine = "2위",
            updatedAt = now, startAt = now + 3_600_000L, bases = null,
        )
        val d = eval(push(kind = "final", away = "", home = "", status = ""), cached = sched)
        assertEquals("unbuildable", (d as WearPushPolicy.Decision.Drop).reason)
    }

    // ── terminal 고착 ──

    @Test
    fun `late live after final dropped`() {
        val cachedFinal = cachedLive(kind = "final", line = "경기 종료 · 승")
        val d = eval(push(kind = "live", ts = now + 1), cached = cachedFinal, lastPushTs = now, lastPushGid = "G1")
        assertEquals("after-terminal", (d as WearPushPolicy.Decision.Drop).reason)
    }

    // ── diamond 파싱 ──

    @Test
    fun `empty diamond yields no runners`() {
        assertNull(WearPushPolicy.basesFromDiamond("000"))
        assertNull(WearPushPolicy.basesFromDiamond(null))
        assertNull(WearPushPolicy.basesFromDiamond("00"))
        val b = WearPushPolicy.basesFromDiamond("010")
        assertEquals(true, b?.second)
    }

    // ── content signature: updatedAt 제외(blocker 2) ──

    @Test
    fun `content signature ignores updatedAt`() {
        val a = cachedLive().copy(updatedAt = 1L)
        val b = cachedLive().copy(updatedAt = 999_999L)
        assertEquals(a.contentSignature(), b.contentSignature())
        // 점수가 바뀌면 시그니처도 달라짐
        val c = cachedLive(awayScore = 4).copy(updatedAt = 1L)
        assertTrue(a.contentSignature() != c.contentSignature())
    }
}
