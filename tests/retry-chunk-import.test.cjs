const {test} = require('node:test');
const assert = require('node:assert/strict');
const {build} = require('esbuild');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

async function fixture() {
  const result = await build({
    entryPoints:['src/lib/retry-chunk-import.ts'],bundle:true,write:false,platform:'node',format:'cjs',
    plugins:[{name:'classifier-only',setup(b){
      b.onResolve({filter:/^@\/lib\/client-error-report$/},()=>({path:'classifier',namespace:'test'}));
      b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:readFileSync('src/lib/client-error-report.ts','utf8').split('// One auto-reload')[0].replace(/import .* from .*;\n/,''),loader:'ts'}));
    }}],
  });
  const module={exports:{}};
  let delays=0;
  vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,Error,setTimeout(fn,ms){assert.equal(ms,1000);delays++;fn();}});
  return {retry:module.exports.retryChunkImport, delays:()=>delays};
}

test('transient chunk failure succeeds on second import before lazy can cache rejection',async()=>{
  const f=await fixture();let calls=0;const loaded={default:()=>null};
  assert.equal(await f.retry(async()=>{if(++calls===1)throw new Error('Failed to load chunk example.js');return loaded;}),loaded);
  assert.equal(calls,2);assert.equal(f.delays(),1);
});

test('cached/permanent chunk failure propagates after exactly two attempts',async()=>{
  const f=await fixture();let calls=0;const error=new Error('Importing a module script failed');
  await assert.rejects(f.retry(async()=>{calls++;throw error;}),e=>e===error);
  assert.equal(calls,2);assert.equal(f.delays(),1);
});

test('module evaluation bugs and successful imports are never retried',async()=>{
  const f=await fixture();let calls=0;const error=new TypeError('Cannot read properties of undefined');
  await assert.rejects(f.retry(async()=>{calls++;throw error;}),e=>e===error);
  assert.equal(calls,1);assert.equal(f.delays(),0);
  assert.equal(await f.retry(async()=>42),42);assert.equal(f.delays(),0);
});
