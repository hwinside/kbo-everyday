const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

async function fixture({ retry = true, permanent = false, foreign = false } = {}) {
  const bundle = await build({entryPoints:['src/lib/chunk-network-retry.ts'],bundle:true,write:false,format:'iife',globalName:'recovery'});
  const dom = new JSDOM('', {url:'https://keubo.test/',runScripts:'outside-only'});
  const w = dom.window;
  // Real shipped runtime, excluding its deployment-specific bootstrap chunk.
  const runtime = readFileSync('tests/fixtures/turbopack-16.1.6-runtime.js','utf8');
  w.TURBOPACK = [];
  w.TURBOPACK_CHUNK_SUFFIX = "?dpl=original";
  w.eval(runtime.slice(runtime.indexOf('(()=>{let e;')));
  w.eval(bundle.outputFiles[0].text + ';window.recovery = recovery;');
  const path = foreign ? 'https://other.test/a.js' : '/_next/static/chunks/fixture.js?dpl=original';
  w.TURBOPACK.push(['static/chunks/test-entry.js', 1, ctx => {
    w.load = () => ctx.L(path).then(() => ctx.r(2));
  }]);
  w.TURBOPACK.push(['static/chunks/boot.js',{otherChunks:[],runtimeModuleIds:[1]}]);
  await new Promise(r => setImmediate(r));
  const requests = [];
  let originalErrors = 0;
  const append = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = script => {
    requests.push(script.src);
    if (requests.length === 1) script.addEventListener('error', () => { originalErrors++; });
    const result = append(script);
    queueMicrotask(() => {
      if (requests.length === 1 || permanent || foreign) script.dispatchEvent(new w.Event('error'));
      else {
        // Real Turbopack registration, canonical chunk path (query stripped).
        w.TURBOPACK.push([script, 2, ctx => ctx.v('section restored')]);
        script.dispatchEvent(new w.Event('load'));
      }
    });
    return result;
  };
  // Preserve production timings in source but accelerate them in this fixture.
  const set = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => set(fn, ms === 1000 ? 1 : ms);
  const release = retry ? w.recovery.acquireChunkNetworkRetry() : () => {};
  return {w,requests,release,get originalErrors(){return originalErrors;},close:()=>dom.window.close()};
}

test('shipped runtime caches a rejected URL: second import does not request again',async()=>{
  const f=await fixture({retry:false});
  try {
    await assert.rejects(f.w.load(),/Failed to load chunk/);
    await assert.rejects(f.w.load(),/Failed to load chunk/);
    assert.equal(f.requests.length,1);
  } finally {f.close();}
});

test('one transient script failure makes a real second request and resolves the original runtime import',async()=>{
  const f=await fixture();
  try {
    assert.equal(await f.w.load(),'section restored');
    assert.equal(f.originalErrors,0,'capture must suppress the original loader target error');
    assert.equal(f.requests.length,2);
    const url=new URL(f.requests[1]);
    assert.equal(url.searchParams.get('dpl'),'original');
    assert.equal(url.searchParams.get('__kbo_chunk_retry'),'1');
  } finally {f.release();f.close();}
});

test('persistent failure rejects the original loader after one network retry, without a loop',async()=>{
  const f=await fixture({permanent:true});
  try {
    await assert.rejects(f.w.load(),/Failed to load chunk/);
    await assert.rejects(f.w.load(),/Failed to load chunk/);
    assert.equal(f.originalErrors,1,'final failure must reach original target exactly once');
    assert.equal(f.requests.length,2);
  } finally {f.release();f.close();}
});

test('foreign scripts are not retried',async()=>{
  const f=await fixture({foreign:true});
  try {
    await assert.rejects(f.w.load(),/Failed to load chunk/);
    assert.equal(f.requests.length,1);
  } finally {f.release();f.close();}
});

test('concurrent imports share one script retry even when one consumer releases its listener',async()=>{
  const f=await fixture();
  const releaseSecond=f.w.recovery.acquireChunkNetworkRetry();
  try {
    f.release();
    assert.deepEqual(await Promise.all([f.w.load(),f.w.load()]),['section restored','section restored']);
    assert.equal(f.requests.length,2);
  } finally {releaseSecond();f.close();}
});
