/** Read-only upstream regression. Run by independent QA with normal server env. */
import assert from "node:assert/strict";
import { fetchBoxScore, fetchGameLinescore, fetchKboGamesOnly } from "../../src/lib/crawler/kbo-api";
import { fetchNaverGames } from "../../src/lib/crawler/naver-games";
import { fetchLineupConfirmed } from "../../src/lib/crawler/lineup-confirmed";
import { naverGameId } from "../../src/lib/crawler/naver-game-id";

const fixtures = [
  ["20251006NCSS0", "4"], ["20251009SSSK0", "3"],
  ["20251018SSHH0", "5"], ["20251026HHLG0", "7"],
  ["20260729WOLG0", "0"],
] as const;
async function main() {
  for (const [id, srId] of fixtures) {
    const games = await fetchKboGamesOnly(id.slice(0, 8));
    assert.equal(games.find(g => g.gameId === id)?.srId, srId, `${id}: KBO series`);
    const naverGames = await fetchNaverGames(id.slice(0, 8));
    assert.equal(naverGames.find(g => g.gameId === id)?.srId, srId, `${id}: Naver series`);
    const [box, score, ck] = await Promise.all([
      fetchBoxScore(id), fetchGameLinescore(id), fetchLineupConfirmed(id, { srId, timeoutMs: 10000 }),
    ]);
    assert.ok(box && box.awayBatters.length && box.homeBatters.length, `${id}: box`);
    assert.ok(score?.away.innings.some(i => i !== null), `${id}: linescore`);
    assert.equal(ck, true, `${id}: confirmed lineup`);
    const naverId = naverGameId(id, srId);
    for (const path of ["record", "relay?inning=1"]) {
      const r = await fetch(`https://api-gw.sports.naver.com/schedule/games/${naverId}/${path}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(r.status, 200, `${id}: ${path}`);
    }
    console.log(`PASS ${id} srId=${srId}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
