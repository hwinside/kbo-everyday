import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { proxy, isPublicGameDocument } from '../src/proxy';
import { sendDeadlineFcmChunk } from '../src/lib/notifications/fcm-deadline-transport';

test('public game document with expired-looking auth cookie never contacts auth or clears cookies',async()=>{
 const old=globalThis.fetch;const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
 process.env.NEXT_PUBLIC_SUPABASE_URL='https://isolation.test';
 let calls=0;globalThis.fetch=(async()=>{calls++;throw new Error('auth offline');}) as typeof fetch;
 try{
  const req=new NextRequest('https://keubo.fan/games/20261103SSKT0',{headers:{host:'keubo.fan','sec-fetch-dest':'document',cookie:'sb-isolation-auth-token=expired-fixture'}});
  const result=await proxy(req,{waitUntil:()=>{throw new Error('auth work must not be scheduled');}} as never);
  assert.equal(calls,0);assert.equal(result.status,200);assert.equal(result.headers.get('set-cookie'),null);
  for(const path of ['/admin','/mypage','/games/20261103SSKT0/predict','/games/invalid','/api/private']) assert.equal(isPublicGameDocument(path),false);
 }finally{globalThis.fetch=old;if(url)process.env.NEXT_PUBLIC_SUPABASE_URL=url;else delete process.env.NEXT_PUBLIC_SUPABASE_URL;}
});

test('FCM fanout is bounded to eight; result order and permanent errors preserved',async()=>{
 let active=0,peak=0;
 const result=await sendDeadlineFcmChunk(Array.from({length:40},(_,i)=>String(i)),{data:{kind:'test'}},Date.now()+2000,{
  projectId:'test',getAccessToken:async()=>'fixture-only',fetchImpl:(async(_url,init)=>{
   active++;peak=Math.max(peak,active);const token=JSON.parse(String(init?.body)).message.token;
   await new Promise(r=>setTimeout(r,2));active--;
   return token==='3'?Response.json({error:{details:[{errorCode:'UNREGISTERED'}]}},{status:404}):Response.json({name:'ok'});
  }) as typeof fetch,
 });
 assert.equal(peak,8);assert.equal(result.successCount,39);assert.equal(result.responses[3].error?.code,'messaging/registration-token-not-registered');
});

test('FCM deadline stops queued sends; all tokens remain accounted for and transient',async()=>{
 let calls=0;let now=0;
 const result=await sendDeadlineFcmChunk(Array.from({length:500},(_,i)=>String(i)),{},10,{
  projectId:'test',now:()=>now,getAccessToken:async()=>'fixture-only',fetchImpl:(async()=>{
   calls++;await Promise.resolve();now=11;throw new Error('temporary FCM outage');
  }) as typeof fetch,
 });
 assert.ok(calls<=8);assert.equal(result.responses.length,500);assert.equal(result.failureCount,500);
 assert.ok(result.responses.every(r=>r.error?.code==='messaging/server-unavailable'));
});
