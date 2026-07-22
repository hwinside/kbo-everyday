package fan.keubo.wear

import org.junit.Assert.assertTrue
import org.junit.Test

class Pr723WearFaultMatrixTest {
    private fun snapshot(gid: String, ts: Long) = WearSnapshot(
        kind = "live", myTeamCode = "LG", awayCode = "LG", homeCode = "KT",
        awayScore = 0, homeScore = 0, line = "LIVE 1회초", rankLine = "",
        updatedAt = 1_000L, startAt = null, bases = null, gameId = gid, sourceAt = ts,
    )

    private fun push(gid: String, ts: Long, away: String = "LG", home: String = "KT") =
        WearPushPolicy.PushState(
            gid = gid, ts = ts, kind = "live", away = away, home = home,
            awayScore = 0, homeScore = 0, statusRaw = "LIVE 1회초",
            outs = null, diamond = null, stadium = null, pitcher = null,
            batter = null, lastPlay = null,
        )

    @Test
    fun delayedPreviousGameCannotReplaceNewerGame() {
        val decision = WearPushPolicy.evaluate(
            myTeam = "LG", push = push("G1", 100L), cached = snapshot("G2", 200L),
            lastPushTs = 200L, lastPushGid = "G2", nowMs = 2_000L,
        )
        assertTrue(decision is WearPushPolicy.Decision.Drop)
    }

    @Test
    fun sameVisibleStateForNewGameStillAdvancesIdentity() {
        val decision = WearPushPolicy.evaluate(
            myTeam = "LG", push = push("G2", 300L), cached = snapshot("G1", 200L),
            lastPushTs = 200L, lastPushGid = "G1", nowMs = 2_000L,
        )
        assertTrue(decision is WearPushPolicy.Decision.Render)
    }

    @Test
    fun wrongTeamFinalFailsClosed() {
        val p = push("G3", 300L, away = "SS", home = "NC").copy(kind = "final")
        val decision = WearPushPolicy.evaluate(
            myTeam = "LG", push = p, cached = snapshot("G2", 200L),
            lastPushTs = 200L, lastPushGid = "G2", nowMs = 2_000L,
        )
        assertTrue(decision is WearPushPolicy.Decision.Drop)
    }
}
