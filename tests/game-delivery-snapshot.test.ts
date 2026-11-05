import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://snapshot.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const id = '20261103SSKT0';
process.env.GAME_SNAPSHOT_GAME_IDS=id;

test('public stored serving never calls upstream even on missing/corrupt/down store; no header bypass', async () => {
  const { serveDeliverySnapshot, snapshotResponse } = await import('../src/lib/game/delivery-snapshot');
  const { markCollectorRequest } = await import('../src/lib/game/collector-request');
  process.env.GAME_SNAPSHOT_WRITE_ENABLED='1'; process.env.GAME_SNAPSHOT_READ_ENABLED='1';
  const original=globalThis.fetch;
  let mode='ok'; let calls=0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.ok(url.startsWith('https://snapshot.test/rest/v1/game_delivery_snapshots?'), `external request: ${url}`);
    calls++;
    if(mode==='down') throw new Error('store unavailable');
    return Response.json(mode==='missing' ? null : {game_id:id,channel:'relay',payload:{gameId:id,innings:[{inning:1}]},observed_at:new Date(Date.now()-600000).toISOString()});
  }) as typeof fetch;
  try {
    const req = new NextRequest(`https://internal.local/api/game-relay?gameId=${id}`, {headers:{'x-collector':'1'}});
    const response = await serveDeliverySnapshot(req,'relay',id);
    assert.equal(response?.status,200);
    const body=await response!.json();
    assert.equal(body.degraded,true); assert.ok(Date.now()-Date.parse(body.updatedAt)>=600000);
    assert.equal(body.innings.length,1);
    mode='missing'; assert.equal((await serveDeliverySnapshot(req,'relay',id))?.status,503);
    mode='down'; assert.equal((await serveDeliverySnapshot(req,'relay',id))?.status,503);
    assert.equal(await serveDeliverySnapshot(markCollectorRequest(req),'relay',id),null);
    assert.equal(calls,3);
    const archived=snapshotResponse({game_id:id,channel:'relay',payload:{gameId:id},observed_at:'2026-01-01T00:00:00Z',archived_at:'2026-01-02T00:00:00Z'});
    assert.equal((await archived.json()).degraded,false);
    assert.equal(snapshotResponse({game_id:id,channel:'relay',payload:{},observed_at:'bad'}).status,503);
  } finally {globalThis.fetch=original;delete process.env.GAME_SNAPSHOT_READ_ENABLED;delete process.env.GAME_SNAPSHOT_WRITE_ENABLED;}
});

test('all four real public GET handlers use stored reads and have zero upstream requests', async () => {
  const modules=await Promise.all([
    import('../src/app/api/game-relay/route'), import('../src/app/api/game-events/route'),
    import('../src/app/api/game-live/route'), import('../src/app/api/game-detail/route'),
  ]);
  process.env.GAME_SNAPSHOT_WRITE_ENABLED='1';process.env.GAME_SNAPSHOT_READ_ENABLED='1';
  const original=globalThis.fetch;const calls:string[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL)=>{
    const url=input instanceof Request?input.url:String(input);calls.push(url);
    assert.ok(url.startsWith('https://snapshot.test/rest/v1/game_delivery_snapshots?'),url);
    const channel=new URL(url).searchParams.get('channel')!.replace('eq.','');
    return Response.json({game_id:id,channel,payload:{gameId:id,events:[],games:[],innings:[]},observed_at:new Date().toISOString()});
  }) as typeof fetch;
  try {
    for(const mod of modules) assert.equal((await mod.GET(new NextRequest(`https://keubo.fan/api/test?gameId=${id}`))).status,200);
    assert.equal(calls.length,4);
  } finally {globalThis.fetch=original;delete process.env.GAME_SNAPSHOT_READ_ENABLED;delete process.env.GAME_SNAPSHOT_WRITE_ENABLED;}
});

test('publisher saves full observations even unchanged, rejects degraded and fences aborted collection',async()=>{
 const {publishGameTick,deserializeState}=await import('../src/lib/game/relay-live-publisher');
 const state=deserializeState(null);const stored:unknown[]=[];
 const originalTime='2026-11-03T09:30:00Z';
 let degraded=false;
 const handler=async()=>Response.json({gameId:id,innings:[{inning:1}],updatedAt:originalTime,degraded});
 const deps={handlers:{relay:handler,events:handler,live:handler,detail:handler},date:'20261103',epoch:9,
  insertFrame:async()=> 'inserted' as const,
  publishSnapshot:async(_id:string,_channel:string,data:unknown,at:string)=>{stored.push({data,at});return true;}};
 await publishGameTick(deps,state,id,1);
 const next=await publishGameTick(deps,state,id,2);
 assert.equal(next.skippedUnchanged,1);assert.equal(stored.length,2);
 assert.equal((stored[0] as {at:string}).at,originalTime);
 degraded=true;await publishGameTick(deps,state,id,4);assert.equal(stored.length,2);
 const abort=new AbortController();abort.abort();await publishGameTick(deps,state,id,7,abort.signal);assert.equal(stored.length,2);
});
