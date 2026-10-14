import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPostseasonLadder } from "../src/lib/postseason/ladder";
import { filterPostseasonGamesBestEffort, postseasonSupplementDates, mergePostseasonSchedule, reconcilePostseasonSchedule, refreshPostseasonSchedule, filterNeededPostseasonGames, excludeNotNeeded } from "../src/lib/postseason/schedule";
import type { KboGame } from "../src/lib/crawler/kbo-api";
const seeds = [{rank:4,teamId:1,name:"LG"},{rank:5,teamId:2,name:"두산"}];
const wc = {gameId:"20261014OBLG0",date:"20261014",srId:"4",status:"final",awayTeamId:2,homeTeamId:1,awayName:"두산",homeName:"LG",awayScore:1,homeScore:4} as KboGame;
const second = {...wc,gameId:"20261015OBLG0",date:"20261015",status:"scheduled",awayScore:null,homeScore:null} as KboGame;
const semi = {...second,gameId:"20261017LGHT0",date:"20261017",srId:"3",awayTeamId:1,homeTeamId:6,awayName:"LG",homeName:"KIA",gameLabel:"준PO1"};
test("KBO-only next round survives Naver lag and duplicate identities",()=>{
 const rows=mergePostseasonSchedule([wc,second], [wc,semi]);
 assert.equal(rows.length,3);
 const snap=buildPostseasonLadder(2026,rows,seeds,1);
 assert.equal(snap.currentStage,"3");
 assert.deepEqual(reconcilePostseasonSchedule([second],snap,"20261015"),[]);
 assert.equal(reconcilePostseasonSchedule([],snap,"20261017")[0].gameId,semi.gameId);
 assert.deepEqual(reconcilePostseasonSchedule([wc,second],snap,"20261001","20261031").map(g=>g.gameId),[wc.gameId,semi.gameId]);
});
test("live score, fifth seed game1 win and missing seeds never remove WC2",()=>{
 for (const [first,seedList] of [[{...wc,status:"live"},seeds],[{...wc,awayScore:4,homeScore:1},seeds],[wc,[]]] as const) {
  const snap=buildPostseasonLadder(2026,[first as KboGame,second],[...seedList],1);
  assert.equal(reconcilePostseasonSchedule([second],snap,"20261015").length,1);
 }
});
test("WC draw removes unnecessary fixture, preserving regular games and cancelled history",()=>{
 const cancelled={...second,status:"cancelled"} as KboGame;
 const regular={...second,gameId:"20261015SSKT0",srId:"0"};
 const snap=buildPostseasonLadder(2026,[{...wc,awayScore:4},cancelled],seeds,1);
 assert.equal(reconcilePostseasonSchedule([regular,cancelled],snap,"20261015").length,2);
 const draw=buildPostseasonLadder(2026,[{...wc,awayScore:4},second],seeds,1);
 assert.deepEqual(reconcilePostseasonSchedule([regular,second],draw,"20261015").map(g=>g.gameId),[regular.gameId]);
});

test("home source failure preserves original games", async () => {
 const games=[second];
 assert.equal(await refreshPostseasonSchedule(games,"20261015","20261015",Date.now()+100,async()=>{throw new Error("offline");}),games);
});
test("home slow ladder is bounded and retains original response", async () => {
 const games=[second]; const start=Date.now();
 assert.equal(await refreshPostseasonSchedule(games,"20261015","20261015",start+20,()=>new Promise(()=>{})),games);
 assert.ok(Date.now()-start<250);
});
test("event and preview eligibility removes WC2 without injecting KBO rows", async () => {
 const snap=buildPostseasonLadder(2026,[wc,second,semi],seeds,1);
 const raw=[{G_ID:wc.gameId},{G_ID:second.gameId}];
 assert.deepEqual(excludeNotNeeded(raw,snap,g=>g.G_ID),[raw[0]]);
 assert.deepEqual(await filterNeededPostseasonGames([second.gameId],"20261015",id=>id,Date.now()+100,async()=>snap),[]);
 assert.deepEqual(await filterNeededPostseasonGames([semi.gameId],"20261017",id=>id,Date.now()+100,async()=>snap),[semi.gameId]);
});
test("event source failure fails closed, never authorizes stale WC2", async () => {
 await assert.rejects(filterNeededPostseasonGames([second],"20261015",g=>g.gameId,Date.now()+100,async()=>{throw new Error("offline");}),/offline/);
 await assert.rejects(filterNeededPostseasonGames([second],"20261015",g=>g.gameId,Date.now()+20,()=>new Promise(()=>{})),/deadline/);
});

 test("general collectors preserve rows on failed or timed-out ladder without injecting fixtures", async () => {
 const games=[second];
 assert.equal(await filterPostseasonGamesBestEffort(games,"20261015",Date.now()+100,async()=>{throw new Error("offline");}),games);
 assert.equal(await filterPostseasonGamesBestEffort(games,"20261015",Date.now()+20,()=>new Promise(()=>{})),games);
 const snap=buildPostseasonLadder(2026,[wc,second,semi],seeds,1);
 assert.deepEqual(await filterPostseasonGamesBestEffort(games,"20261015",Date.now()+100,async()=>snap),[]);
 });
 test("KBO supplement remains bounded late in postseason and never queries past dates", () => {
 for (const today of ["20261014","20261110"]) {
 const dates=postseasonSupplementDates(today);
 assert.equal(dates.length,15);
 assert.equal(dates[0],today);
 assert.ok(dates.every(date=>date>=today));
 }
 assert.deepEqual(postseasonSupplementDates("20261130"),["20261130"]);
 });
