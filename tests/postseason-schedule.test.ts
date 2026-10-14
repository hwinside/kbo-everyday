import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPostseasonLadder } from "../src/lib/postseason/ladder";
import { mergePostseasonSchedule, reconcilePostseasonSchedule } from "../src/lib/postseason/schedule";
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
