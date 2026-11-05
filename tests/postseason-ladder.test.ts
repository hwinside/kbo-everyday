import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPostseasonLadder, type Seed } from "../src/lib/postseason/ladder";
import type { KboGame } from "../src/lib/crawler/kbo-api";
const seeds: Seed[] = [{rank:4,teamId:1,name:"LG"},{rank:5,teamId:2,name:"두산"},{rank:3,teamId:3,name:"KT"},{rank:2,teamId:4,name:"SSG"},{rank:1,teamId:9,name:"한화"}];
const game = (id="20261014OBLG0", srId="4", opts: Partial<KboGame>={}): KboGame => ({gameId:id,date:id.slice(0,8),srId,gameLabel:"WC1",awayTeamId:2,homeTeamId:1,awayName:"두산",homeName:"LG",status:"scheduled",awayScore:0,homeScore:0,time:"18:30",stadium:"잠실",...opts} as KboGame);
test("WC advantage is not a fabricated actual win; registered next game links retain identity",()=>{
 const s=buildPostseasonLadder(2026,[game(),game("20261015OBLG0","4",{gameLabel:"WC2"})],seeds,1);
 assert.deepEqual(s.rounds[0].participants.map(p=>p.wins),[0,0]);
 assert.equal(s.rounds[0].winnerId,null);
 assert.match(s.rounds[0].games[1].displayLabel,/2차전 · 필요시/);
 assert.equal(s.currentStage,"4");assert.equal(s.rounds[1].placeholder,"KT · WC 승자");
});
for(const [away,home] of [[1,2],[2,2]]) test(`WC fourth-place win or draw advances (${away}:${home})`,()=>{
 const s=buildPostseasonLadder(2026,[game(undefined,undefined,{status:"final",awayScore:away,homeScore:home}),game("20261015OBLG0","4",{gameLabel:"WC2"})],seeds,1);
 assert.equal(s.rounds[0].winnerId,1);assert.equal(s.rounds[0].games[1].notNeeded,true);
 assert.equal(s.rounds[0].participants.find(p=>p.teamId===1)?.wins,away===home?0:1);
});
test("fifth seed must win both, missing seeds never imply home advantage",()=>{
 const wins=[game(undefined,undefined,{status:"final",awayScore:2,homeScore:0}),game("20261015OBLG0","4",{status:"final",awayScore:3,homeScore:1})];
 assert.equal(buildPostseasonLadder(2026,wins.slice(0,1),seeds,1).rounds[0].winnerId,null);
 assert.equal(buildPostseasonLadder(2026,wins,seeds,1).rounds[0].winnerId,2);
 assert.equal(buildPostseasonLadder(2026,[game(undefined,undefined,{status:"final",awayScore:0,homeScore:1})],[],1).rounds[0].winnerId,null);
});
for(const [id,srId,stage] of [["20251006NCSS0","4",0],["20251009SSSK0","3",1],["20251018SSHH0","5",2],["20251026HHLG0","7",3]] as const) test(`2025 PS identity ${id}`,()=>{
 const s=buildPostseasonLadder(2025,[game(id,srId,{status:"final",awayScore:1,homeScore:0})],[],1);
 assert.equal(s.rounds[stage].games[0].gameId,id);assert.equal(s.rounds[stage].participants[0].wins,1);
});
test("regular/other years excluded; cancelled and live scores never count",()=>{
 const rows=[game("20260729WOLG0","0",{status:"final",awayScore:9,homeScore:0}),game("20251006NCSS0","4"),game(undefined,undefined,{status:"cancelled",awayScore:8,homeScore:0})];
 const r=buildPostseasonLadder(2026,rows,seeds,1).rounds[0];assert.equal(r.games.length,1);assert.equal(r.state,"changed");assert.equal(r.participants[0].wins,0);
 assert.equal(buildPostseasonLadder(2026,[game(undefined,undefined,{status:"live",awayScore:10,homeScore:0})],seeds,1).rounds[0].winnerId,null);
});
for(const [srId,needed] of [["3",3],["5",3],["7",4]] as const) test(`${srId} series closes at ${needed} real wins, not empty future dates`,()=>{
 const rows=Array.from({length:needed},(_,i)=>game(`202610${20+i}OBLG0`,srId,{status:"final",awayScore:0,homeScore:1}));
 const index=srId==="3"?1:srId==="5"?2:3;
 assert.equal(buildPostseasonLadder(2026,rows.slice(1),[],1).rounds[index].winnerId,null);
 assert.equal(buildPostseasonLadder(2026,rows,[],1).rounds[index].winnerId,1);
});
test("duplicate identities and missing final scores fail closed",()=>{
 assert.throws(()=>buildPostseasonLadder(2026,[game(),game()],seeds,1),/Duplicate/);
 assert.throws(()=>buildPostseasonLadder(2026,[game(undefined,undefined,{status:"final",awayScore:null})],seeds,1),/Missing/);
});
