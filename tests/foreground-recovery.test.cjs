const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {buildSync} = require('esbuild');

function fixture(entry) {
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const navigator = {onLine:true};
  const storage = new Map();
  const timers = new Map();
  let id=0, reloads=0;
  window.location = {reload: () => reloads++};
  const sessionStorage = {getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  const module = {exports:{}};
  const context = {module, exports:module.exports, window,document,navigator,sessionStorage,
    Date:{now:()=>1_000_000},
    setTimeout:(fn,ms)=>{assert.equal(ms,1500);timers.set(++id,fn);return id;},
    clearTimeout:id=>timers.delete(id)};
  const code=buildSync({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs'}).outputFiles[0].text;
  vm.runInNewContext(code,context);
  return {api:module.exports,window,document,navigator,storage,sessionStorage,timers,
    flush:()=>{const pending=[...timers.values()];timers.clear();pending.forEach(f=>f());},
    reloads:()=>reloads};
}

test('foreground requests settle, coalesce, wait online and cancel on hide/unmount',()=>{
 const f=fixture('src/lib/foreground-task.ts');let calls=0;
 const stop=f.api.installForegroundTask(()=>calls++);
 assert.equal(calls,0);
 f.window.dispatchEvent(new Event('focus')); f.document.dispatchEvent(new Event('visibilitychange'));
 assert.equal(f.timers.size,1);f.flush();assert.equal(calls,1);
 f.window.dispatchEvent(new Event('focus'));f.document.visibilityState='hidden';f.document.dispatchEvent(new Event('visibilitychange'));
 f.flush();assert.equal(calls,1);
 f.navigator.onLine=false;f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));
 f.flush();assert.equal(calls,1);
 f.navigator.onLine=true;f.window.dispatchEvent(new Event('online'));f.flush();assert.equal(calls,2);
 f.window.dispatchEvent(new Event('focus'));stop();f.flush();f.window.dispatchEvent(new Event('online'));
 assert.equal(calls,2);assert.equal(f.timers.size,0);
});

test('network-only recovery is delayed and persisted, never loops or clears auth',()=>{
 const f=fixture('src/lib/network-error-recovery.ts');
 assert.equal(f.api.isNetworkLoadError('TypeError: Load failed'),true);
 assert.equal(f.api.isNetworkLoadError("Cannot read properties of null"),false);
 assert.equal(f.api.isNetworkLoadError('TypeError: undefined is not an object'),false);
 f.storage.set('auth','untouched');
 const stop=f.api.scheduleNetworkErrorRecovery('Load failed');
 assert.equal(f.reloads(),0);f.flush();assert.equal(f.reloads(),1);
 f.window.dispatchEvent(new Event('focus'));f.flush();assert.equal(f.reloads(),1);stop();
 const stop2=f.api.scheduleNetworkErrorRecovery('Load failed');f.flush();assert.equal(f.reloads(),1);stop2();
 assert.equal(f.storage.get('auth'),'untouched');
});

test('offline recovery waits, cancelled boundary never reloads, denied storage fails safe',()=>{
 const f=fixture('src/lib/network-error-recovery.ts');f.navigator.onLine=false;
 const stop=f.api.scheduleNetworkErrorRecovery('Load failed');f.flush();assert.equal(f.reloads(),0);
 f.navigator.onLine=true;f.window.dispatchEvent(new Event('online'));stop();f.flush();assert.equal(f.reloads(),0);
 f.sessionStorage.getItem=()=>{throw new Error('denied');};
 const stop2=f.api.scheduleNetworkErrorRecovery('Load failed');f.flush();assert.equal(f.reloads(),0);stop2();
});
