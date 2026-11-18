import assert from "node:assert/strict";
import { resolveBoxscorePlayer } from "@/lib/game-logs/resolve-boxscore-player";
import { buildGameLogRows, type GameBoxscore } from "@/lib/game-logs/ingest";
import { buildGameIngestion } from "@/lib/game-logs/completeness";
import type { KboGame } from "@/lib/crawler/kbo-api";

// Real provider IDs observed in the 2026-09/10 incident, including same-role names.
for (const [name, teamId, sourceId] of [
  ["김민준",4,"56840"],["김민준",4,"53893"],
  ["김태훈",8,"62360"],["김태훈",8,"65040"],
  ["이승현",8,"60146"],["이승현",8,"51454"],
  ["박준영",9,"52731"],["박준영",9,"56709"],
] as const) {
  assert.equal(resolveBoxscorePlayer({name,teamId,sourceId})?.kboId, sourceId);
}
assert.equal(resolveBoxscorePlayer({name:"디아즈",teamId:8,sourceId:"54400"})?.numericId,"54400");
// Non-vacuous fallback guard: this name resolves uniquely when the ID is absent.
assert.equal(resolveBoxscorePlayer({name:"디아즈",teamId:8})?.numericId,"54400");
for (const sourceId of ["99999", "abc", {}, "5440x"]) {
  assert.equal(resolveBoxscorePlayer({name:"디아즈",teamId:8,sourceId}),null,
    `invalid ID must not fall back to unique name: ${JSON.stringify(sourceId)}`);
}
assert.equal(resolveBoxscorePlayer({name:"김민준",teamId:4}),null);
for (const sourceId of ["99999", "김민준", {}, " ", "56840oops"]) {
  assert.equal(resolveBoxscorePlayer({name:"김민준",teamId:4,sourceId}),null);
}
assert.equal(resolveBoxscorePlayer({name:"김민준",teamId:8,sourceId:"56840"}),null);
assert.equal(resolveBoxscorePlayer({name:"김태훈",teamId:4,sourceId:"56840"}),null);

const game={gameId:"20260905SSLG0",date:"20260905",homeTeamId:1,awayTeamId:8,homeScore:5,awayScore:3,status:"final"} as KboGame;
const pitcher=(name:string,pcode:string)=>({name,pcode,inn:"1",hit:0,er:0,kk:1,bb:0});
const batter=(name:string,playerCode:string)=>({name,playerCode,ab:1,hit:0,hr:0,rbi:0,bb:0,kk:1});
const box:GameBoxscore={homeBatters:[],homePitchers:[],awayBatters:[batter("김태훈","65040")],awayPitchers:[pitcher("김태훈","62360"),pitcher("이승현","60146"),pitcher("이승현","51454")]};
for (const data of [box,{...box,awayPitchers:[...box.awayPitchers].reverse()}]) {
  const strict=buildGameIngestion(game,data);
  assert.equal(strict.unresolved.length,0);
  assert.equal(strict.rawRowCount,4);
  assert.equal(strict.rows.length,4);
  assert.deepEqual(strict.rows.map(r=>r.kbo_id).sort(),["65040","62360","60146","51454"].sort());
  assert.equal(buildGameLogRows(game,data).length,4);
}
const invalid={...box,awayPitchers:[pitcher("김태훈","99999")]};
assert.equal(buildGameIngestion(game,invalid).unresolved.length,1);
assert.equal(buildGameLogRows(game,invalid).length,1);
// A pitcher legitimately batting must not be rejected by roster position.
assert.equal(buildGameIngestion(game,{...box,awayBatters:[batter("김태훈","62360")],awayPitchers:[]}).rows[0]?.kbo_id,"62360");
console.log("PASS game-log-player-identity");
