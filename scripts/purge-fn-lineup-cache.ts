/**
 * FN(false negative) 라인업 캐시 삭제
 * 실제 변경이 있었는데 "동일한 라인업" 문구로 잘못 캐시된 건 제거
 *
 * 안전장치: 실제 KBO 데이터와 재검증한 뒤, FN 확정 시에만 삭제
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

const envFile = fs.readFileSync(".env.local", "utf8");
const envVars: Record<string,string> = {};
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) envVars[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SUPABASE_URL = envVars.NEXT_PUBLIC_SUPABASE_URL || "https://lbmbdjgsnenqjwjotoei.supabase.co";
const SUPABASE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
// 2026-05-20: KBO Referer 검증 적용 → koreabaseball.com Referer 필수.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0",
  "Referer": "https://www.koreabaseball.com/Schedule/LineUp.aspx",
};
const POS_MAP: Record<string,string> = {
  "투수":"P","포수":"C","1루수":"1B","2루수":"2B","3루수":"3B","유격수":"SS",
  "좌익수":"LF","중견수":"CF","우익수":"RF","지명타자":"DH",
};
function safeStr(v:unknown){ if (v==null) return ""; const s=String(v).trim(); return s==="&nbsp;"?"":s; }
function safeInt(v:unknown){ if (v==null||v===""||v==="&nbsp;") return 0; const n=parseInt(String(v),10); return isNaN(n)?0:n; }
function stripHtml(s:string){ return s.replace(/<[^>]*>/g,"").trim(); }
interface Player { order:number; position:string; name:string; }
function parseLineupRows(raw:unknown):Player[] {
  let p:{rows:{row:{Text:string}[]}[]};
  try { const v=Array.isArray(raw)&&raw.length>0?raw[0]:raw; p=typeof v==="string"?JSON.parse(v):v; } catch { return []; }
  if (!p?.rows) return [];
  return p.rows.map(r=>{
    const c=r.row.map(x=>safeStr(x.Text));
    const pk=stripHtml(c[1]||"");
    return { order:safeInt(c[0]), position:POS_MAP[pk]||pk, name:stripHtml(c[2]||"") };
  }).filter(e=>e.name!=="");
}
async function fetchLineup(gameId:string) {
  const seasonId=gameId.slice(0,4);
  const body=`leId=1&srId=0&seasonId=${seasonId}&gameId=${gameId}`;
  try {
    const r=await fetch(`${KBO_BASE}/GetLineUpAnalysis`,{method:"POST",headers:HEADERS,body,signal:AbortSignal.timeout(10000)});
    if (!r.ok) return null;
    const d=await r.json();
    if (!Array.isArray(d)||d.length<5) return null;
    return { away:parseLineupRows(d[4]), home:parseLineupRows(d[3]) };
  } catch { return null; }
}
function shiftDate(s:string,n:number){ const y=+s.slice(0,4),m=+s.slice(4,6)-1,d=+s.slice(6,8); const dt=new Date(y,m,d+n); return `${dt.getFullYear()}${(dt.getMonth()+1).toString().padStart(2,"0")}${dt.getDate().toString().padStart(2,"0")}`; }
async function fetchGamesByDate(date:string){
  const r=await fetch(`https://keubo.fan/api/games?date=${date}`); const j=await r.json(); return j.games||[];
}
async function findPrev(teamId:number, gameId:string){
  const dateStr=gameId.slice(0,8);
  for (let o=1;o<=5;o++){
    const d=shiftDate(dateStr,-o);
    const gs=await fetchGamesByDate(d);
    const t=gs.filter((g:any)=>g.status==="final"&&g.gameId!==gameId&&(g.awayTeamId===teamId||g.homeTeamId===teamId));
    if (t.length>0) return t[t.length-1];
  }
  return null;
}

const DRY = process.argv.includes("--dry-run");

async function main() {
  const { data: rows } = await supabase
    .from("game_summaries")
    .select("game_id, summary, created_at")
    .like("game_id", "lineup_%")
    .order("created_at", { ascending: false })
    .limit(100);
  if (!rows) { console.log("no rows"); return; }

  console.log(`전수 ${rows.length}건 검사 (${DRY ? "DRY RUN" : "실제 삭제"})\n`);
  const toDelete: string[] = [];

  for (const row of rows) {
    const gameId = row.game_id.replace("lineup_", "");
    const summary = row.summary as any;
    const lineupText = String(summary?.lineup || "");
    const saysNoChange = /동일한[\s]*라인업|변화(를)?[\s]*(주지|보이지)[\s]*않|변경[\s]*없|조정[\s]*없|그대로[\s]*경기에/.test(lineupText);
    if (!saysNoChange) continue;

    // 실제 데이터 검증
    const games = await fetchGamesByDate(gameId.slice(0,8));
    const g = games.find((x:any)=>x.gameId===gameId);
    if (!g) continue;
    const today = await fetchLineup(gameId);
    if (!today || today.away.length===0 || today.home.length===0) continue;

    let actualOrderChanges = 0;
    let actualNewEntries = 0;
    for (const side of [{tid:g.awayTeamId, bat:today.away},{tid:g.homeTeamId, bat:today.home}]){
      const prev = await findPrev(side.tid, gameId);
      if (!prev) continue;
      const pl = await fetchLineup(prev.gameId);
      if (!pl) continue;
      const pb = prev.awayTeamId===side.tid?pl.away:pl.home;
      if (pb.length===0) continue;
      const pm = new Map(pb.map(b=>[b.name,b]));
      for (const c of side.bat) {
        const p = pm.get(c.name);
        if (!p) { actualNewEntries++; continue; }
        if (p.order !== c.order) actualOrderChanges++;
      }
    }

    const hasActual = actualOrderChanges>0 || actualNewEntries>0;
    if (hasActual) {
      console.log(`  FN: ${gameId} (타순${actualOrderChanges}/신규${actualNewEntries}) → 삭제 대상`);
      toDelete.push(row.game_id);
    }
  }

  console.log(`\n삭제 대상 ${toDelete.length}건`);
  if (toDelete.length === 0 || DRY) return;

  const { error } = await supabase.from("game_summaries").delete().in("game_id", toDelete);
  if (error) { console.error("삭제 실패:", error); process.exit(1); }
  console.log(`✅ ${toDelete.length}건 삭제 완료`);
}
main().catch(console.error);
