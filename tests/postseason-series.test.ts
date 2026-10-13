import assert from "node:assert/strict";
import { test } from "node:test";
import { naverGameId, resolveNaverGameId } from "../src/lib/crawler/naver-game-id";
import { seriesIdFromNaverId } from "../src/lib/crawler/game-series";
import { parseGame, fetchGameLinescore, fetchBoxScore } from "../src/lib/crawler/kbo-api";
import { mapNaverGameToKbo } from "../src/lib/crawler/naver-games";
import { fetchLineupConfirmed } from "../src/lib/crawler/lineup-confirmed";
import { fetchNaverLiveEvidence } from "../src/lib/notifications/kbo-live-games";

const cases = [
  ["20251006NCSS0", "4", "44441006NCSS02025"],
  ["20251009SSSK0", "3", "33331009SSSK02025"],
  ["20251018SSHH0", "5", "55551018SSHH02025"],
  ["20251026HHLG0", "7", "77771026HHLG02025"],
  ["20260729WOLG0", "0", "20260729WOLG02026"],
] as const;

for (const [gameId, srId, naverId] of cases) {
  test(`${gameId}: identity survives both sources and reaches detail/first-pitch APIs`, async () => {
    const game = parseGame({ G_ID: gameId, G_DT: gameId.slice(0,8), SR_ID: srId,
      GAME_STATE_SC: "1", CANCEL_SC_ID: "0", AWAY_ID: gameId.slice(8,10), HOME_ID: gameId.slice(10,12),
    } as Parameters<typeof parseGame>[0]);
    assert.equal(game.srId, srId);
    assert.equal(naverGameId(gameId, srId), naverId);
    assert.equal(await resolveNaverGameId(gameId), naverId);
    if (srId !== "0") assert.equal(seriesIdFromNaverId(naverId), srId);
    const naverGame = mapNaverGameToKbo({ gameId: naverId, awayTeamCode: gameId.slice(8,10),
      homeTeamCode: gameId.slice(10,12), statusCode: "READY" }, gameId.slice(0,8));
    assert.equal(naverGame.gameId, gameId);
    assert.equal(naverGame.srId, srId);

    const original = globalThis.fetch;
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); requests.push({ url, body: String(init?.body ?? "") });
      if (url.includes("GetLineUpAnalysis")) return Response.json([[{ LINEUP_CK: false }]]);
      return Response.json([]);
    };
    try {
      // Correct-series false is authoritative; do NOT manufacture a confirmed Naver fallback.
      assert.equal(await fetchLineupConfirmed(gameId, { srId, timeoutMs: 500 }), false);
      assert.equal(requests.length, 1);
      await fetchGameLinescore(gameId);
      await fetchBoxScore(gameId);
      await fetchNaverLiveEvidence(gameId, AbortSignal.timeout(500), srId);
      const kbo = requests.filter(r => r.url.includes("Schedule.asmx"));
      assert.equal(kbo.length, 3);
      for (const req of kbo) {
        const body = new URLSearchParams(req.body);
        assert.equal(body.get("srId"), srId);
        assert.equal(body.get("seasonId"), gameId.slice(0,4));
      }
      assert.ok(requests.some(r => r.url.includes(`/${naverId}/relay?inning=1`)));
      // Empty KBO boxscore must fall through to the SAME series Naver record.
      assert.ok(requests.some(r => r.url.includes(`/${naverId}/record`)));
    } finally { globalThis.fetch = original; }
  });
}
test("all-star and doubleheader suffixes stay intact", () => {
  assert.equal(naverGameId("20260711WEEA0", "9"), "99990711WEEA02026");
  assert.equal(naverGameId("20260901OBLG2", "0"), "20260901OBLG22026");
});

test("unknown identity fails closed and remains retryable; caller abort is respected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ game: [], result: { games: [] } });
  try {
    await assert.rejects(resolveNaverGameId("20271014OBLG0", { signal: AbortSignal.timeout(100) }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveNaverGameId("20251026HHLG0", { signal: controller.signal }));
  } finally { globalThis.fetch = original; }
  // A previous miss is not negative-cached when official identity becomes available.
  assert.equal(await resolveNaverGameId("20271014OBLG0", { srId: "4" }), "44441014OBLG02027");
});
