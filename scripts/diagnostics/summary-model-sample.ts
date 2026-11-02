/** Author sampling of real model output with captured public records. No DB writes.
 * Not independent QA or a Preview route/production-cache test.
 * Usage: node --env-file=<protected env> --import tsx scripts/diagnostics/summary-model-sample.ts
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const requireLocal=createRequire(import.meta.url);
const ids=['20261026HTSS0','20261027HTSS0','20261029SSHT0','20261030SSHT0','20261101HTSS0'];
const source=readFileSync('src/app/api/game-summary/route.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const results:unknown[]=[];
async function main(){
 if(!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY unavailable');
 for(let i=0;i<ids.length;i++){
  const id=ids[i];
  const response=await fetch(`https://keubo.fan/api/game-detail?gameId=${id}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok){results.push({gameId:id,sourceStatus:response.status});continue;}
  const detail=await response.json();
  const away=id.slice(8,10)==='HT'?{name:'KIA',id:6}:{name:'삼성',id:8};
  const home=away.name==='KIA'?{name:'삼성',id:8}:{name:'KIA',id:6};
  const game={gameId:id,srId:'5',gameLabel:`PO${i+1}`,status:detail.status,awayName:away.name,homeName:home.name,awayTeamId:away.id,homeTeamId:home.id,awayScore:detail.linescore?.away?.R,homeScore:detail.linescore?.home?.R};
  let calls=0;const outputs:unknown[]=[];const errors:string[]=[];
  const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:null})};
  const mocks:Record<string,unknown>={
   'next/server':{NextResponse:{json:(value:unknown,init?:ResponseInit)=>Response.json(value,init)},after:()=>{}},
   '@/lib/supabase/admin':{supabaseAdmin:{from:()=>query,rpc:async(name:string)=>({data:name.startsWith('claim')?1:true})}},
   '@/lib/config/runtime-switches':{isFeatureDisabled:async()=>false},
   '@/lib/crawler/kbo-api':{fetchGames:async()=>[game],fetchBoxScore:async()=>detail.boxScore,fetchGameLinescore:async()=>detail.linescore},
   '@/lib/crawler/kbo-live-text':{loadKboLiveText:async()=>detail},
   '@/lib/crawler/resolve-game-series':{resolveGameSeries:async()=>5},
   '@/lib/game-summary/postseason-facts':{loadSummaryPostseasonFacts:async()=>null},
   '@/lib/monitoring/api-fallback-tracker':{trackApiDegradation:async()=>{}},
  };
  const module={exports:{} as {POST:(r:unknown)=>Promise<Response>}};
  vm.runInNewContext(compiled,{module,exports:module.exports,process,structuredClone,AbortSignal,URLSearchParams,
   console:{log:()=>{},info:()=>{},warn:()=>{},error:(message:unknown)=>errors.push(String(message).split('?')[0])},
   require:(name:string)=>mocks[name]??requireLocal(name.startsWith('@/')?resolve('src',name.slice(2)):name),
   fetch:async(url:string,init:RequestInit)=>{
    if(!url.startsWith('https://generativelanguage.googleapis.com/'))throw new Error('unexpected non-model request');
    calls++;const r=await fetch(url,init);outputs.push({status:r.status,body:await r.clone().json()});return r;
   },
  });
  const result=await module.exports.POST({json:async()=>({gameId:id})});
  const body=await result.json();
  results.push({gameId:id,sourceStatus:response.status,routeStatus:result.status,source:body.source,modelCalls:calls,summary:body.summary,errors,modelOutputs:outputs});
  console.log(JSON.stringify({gameId:id,status:result.status,source:body.source,modelCalls:calls}));
 }
 writeFileSync(process.env.SUMMARY_SAMPLE_OUTPUT??'summary-model-sample.json',JSON.stringify(results,null,2));
}
main().catch(()=>{console.error('sampling failed; no credentials printed');process.exitCode=1;});
