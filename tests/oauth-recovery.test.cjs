const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: n => { if (!(n in deps)) throw Error(`Missing test dependency ${n}`); return deps[n]; }, URL, URLSearchParams, setTimeout, clearTimeout, console, ...globals });
  return exports;
}
const schema = load('src/lib/auth/oauth-diagnostic-schema.ts');
const valid = { v: 1, attempt: 'ae742a03-1872-4eac-9b12-2961680e44ee', provider: 'google', stage: 'callback', failure: 'none', coreNative: false, runtimeNative: true, listener: true, bridge: true };
test('diagnostic ingress rejects secrets, unknown fields/categories and malformed ids', () => {
  assert(schema.parseOAuthDiagnostic(valid));
  for (const bad of [{ ...valid, code: 'SECRET' }, { ...valid, attempt: 'https://secret' }, { ...valid, failure: 'SECRET' }, { ...valid, provider: 'secret@example.com' }, { ...valid, listener: 'true' }]) assert.equal(schema.parseOAuthDiagnostic(bad), null);
  assert.equal(schema.oauthFailure({ code: 'bad_code_verifier', message: 'SECRET' }), 'pkce');
  assert.equal(schema.oauthFailure({ name: 'AuthRetryableFetchError', message: 'SECRET' }), 'network');
  assert.equal(schema.oauthFailure({ code: 'SECRET' }), 'other');
  assert.equal(schema.oauthFailure({ name: 'AuthPKCEGrantCodeExchangeError' }), 'pkce');
  assert.equal(schema.oauthFailure({ name: 'NavigatorLockAcquireTimeoutError' }), 'lock');
});
test('error delivery survives denied storage and raw provider errors never reach UI', () => {
  const events = [];
  const errors = load('src/lib/auth-error.ts', {}, { window: { dispatchEvent: e => events.push(e) }, sessionStorage: { setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } }, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, x) { this.type = type; this.detail = x.detail; } } });
  errors.publishAuthError('oauth_exchange'); errors.clearAuthError();
  assert.equal(events[0].detail, 'oauth_exchange'); assert.equal(events[1].type, errors.AUTH_ERROR_CLEAR_EVENT);
  for (const q of ['?error=SECRET', '?auth_error=SECRET']) assert.equal(errors.getUserFacingAuthErrorFromUrl(new URL('https://keubo.fan/'+q)), 'oauth_provider');
  assert.equal(errors.getUserFacingAuthErrorFromUrl(new URL('https://keubo.fan/?login_error=state_mismatch')), 'state_mismatch');
  assert.equal(errors.getUserFacingAuthErrorFromUrl(new URL('https://keubo.fan/?error=access_denied')), null);
});
function nativeHarness({ exchange, close = () => Promise.resolve(), runtime = true } = {}) {
  let callback, timeout; const events = [], notices = []; let calls = 0;
  const auth = { exchangeCodeForSession: async () => { calls++; return exchange ? exchange() : { data: { session: {} }, error: null }; }, setSession: async () => { calls++; return { data: { session: {} }, error: null }; } };
  const lib = load('src/lib/capacitor/auth.ts', {
    '@capacitor/browser': { Browser: { close } }, '@capacitor/core': { registerPlugin: () => ({ close }) },
    '@/lib/capacitor/app-url-open': { subscribeAppUrlOpen: async (_, fn) => { callback = fn; } },
    '@/lib/supabase/client': { supabase: { auth } },
    '@/lib/auth-error': { clearAuthError: () => notices.push('clear'), publishAuthError: code => notices.push(code), getUserFacingAuthErrorFromUrl: () => null },
    '@/lib/auth/oauth-diagnostics': { observeOAuth: (...args) => events.push(args), setOAuthListenerReady: ready => events.push(['listener', ready]) },
    '@/lib/auth/oauth-diagnostic-schema': schema,
    './platform': { isNative: false, isNativeRuntime: () => runtime, isIosNativeRuntime: () => true },
  }, { setTimeout: fn => { timeout = fn; return 1; }, clearTimeout: () => {} });
  lib.registerDeepLinkListener();
  return { lib, events, notices, calls: () => calls, fire: (url = 'fan.keubo.app://auth/callback?code=SYNTHETIC') => callback({ url }), expire: () => timeout() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('injected native runtime registers despite static false and close throw cannot block exchange', async () => {
  const h = nativeHarness({ close: () => { throw Error('closed'); } });
  h.fire(); await flush(); assert.equal(h.calls(), 1); assert(h.events.some(e => e[0] === 'session-ready')); assert.deepEqual(h.notices, ['clear']);
});
test('timeout keeps original exchange lease, ignores duplicate, late success clears notice', async () => {
  let finish; const pending = new Promise(r => { finish = r; });
  const h = nativeHarness({ exchange: () => pending });
  h.fire(); h.expire(); h.fire();
  assert(h.lib.isOAuthExchangePending()); assert.equal(h.calls(), 1); assert.deepEqual(h.notices, ['oauth_pending']);
  finish({ data: { session: {} }, error: null }); await flush();
  assert.equal(h.lib.isOAuthExchangePending(), false); assert.deepEqual(h.notices, ['oauth_pending', 'clear']);
});
test('returned and thrown SDK failures surface without raw data and release lease', async () => {
  for (const exchange of [() => ({ data: { session: null }, error: { code: 'bad_code_verifier', message: 'SECRET' } }), () => { throw new TypeError('SECRET'); }]) {
    const h = nativeHarness({ exchange }); h.fire(); await flush();
    assert.deepEqual(h.notices, ['oauth_exchange']); assert.equal(h.lib.isOAuthExchangePending(), false); assert(!JSON.stringify(h.events).includes('SECRET'));
  }
});
test('web is not subscribed; unrelated origins never enter SDK; hash sessions also succeed', async () => {
  const web = nativeHarness({ runtime: false }); assert.deepEqual(web.events, [['listener', false]]);
  const h = nativeHarness(); h.fire('https://evil.example/?code=SYNTHETIC'); await flush(); assert.equal(h.calls(), 0);
  h.fire('fan.keubo.app://auth/callback#access_token=SYNTHETIC&refresh_token=SYNTHETIC'); await flush(); assert.equal(h.calls(), 1); assert.deepEqual(h.notices, ['clear']);
});
test('OAuth telemetry strips caller extras at server ingress and stores no identity/URL', async () => {
  let inserted;
  const route = load('src/app/api/telemetry/client-error/route.ts', {
    'next/server': { NextResponse: { json: body => body } }, '@/lib/supabase/admin': { supabaseAdmin: { from: () => ({ insert: async x => { inserted = x; return { error: null }; } }) } },
    '@/lib/auth/session-diagnostic-schema': { AUTH_DIAGNOSTIC_SOURCE: 'auth-session', parseAuthDiagnostic: () => null },
    '@/lib/auth/boot-trace-schema': { AUTH_BOOT_SOURCE: 'auth-boot', parseAuthBootDiagnostic: () => null },
    '@/lib/auth/previous-exit-schema': { AUTH_DIAGNOSTIC_MAX_CHARS: 2000 },
    '@/lib/auth/oauth-diagnostic-schema': schema,
  });
  await route.POST({ json: async () => ({ source: 'auth-oauth', message: JSON.stringify(valid), stack: 'SECRET', path: '?code=SECRET', userAgent: 'SECRET', visitorId: 'SECRET', appVersion: 'SECRET', platform: 'ios_native' }) });
  assert.equal(inserted.digest, 'auth-oauth-v1'); assert(!JSON.stringify(inserted).includes('SECRET'));
  inserted = null;
  await route.POST({ json: async () => ({ source: 'auth-oauth', message: JSON.stringify({ ...valid, raw: 'SECRET' }) }) });
  assert.equal(inserted, null);
});
test('producer persists only random correlation metadata; transport rejection is isolated and events bounded', async () => {
  const storage = new Map(), sent = []; let id = 0;
  const diag = load('src/lib/auth/oauth-diagnostics.ts', {
    '@/lib/capacitor/platform': { isNative: false, isNativeRuntime: () => true, isIosNativeRuntime: () => true },
    './oauth-diagnostic-schema': schema, '@capacitor/app': { App: { getInfo: async () => ({ version: '1.0.14', build: '26' }) } },
  }, { window: {}, crypto: { randomUUID: () => `ae742a03-1872-4eac-9b12-${String(++id).padStart(12, '0')}` },
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async (_, req) => { sent.push(JSON.parse(req.body)); throw Error('offline'); },
  });
  diag.setOAuthListenerReady(true); diag.setOAuthBridgeReady(true);
  for (let i = 0; i < 50; i++) { diag.beginOAuthAttempt('google'); diag.observeOAuth('callback'); diag.observeOAuth('callback'); }
  await flush(); await flush();
  assert.equal(sent.length, 32);
  for (const row of sent) { assert(schema.parseOAuthDiagnostic(JSON.parse(row.message))); assert.equal(row.appVersion, '1.0.14 (26)'); assert.equal(row.platform, 'ios_native'); assert.equal(row.visitorId, undefined); }
  const stored = JSON.parse(storage.values().next().value); assert.deepEqual(Object.keys(stored).sort(), ['at','id','provider']);
});
test('URL cleanup removes generic provider errors but preserves unrelated query and token fields', () => {
  const errors = load('src/lib/auth-error.ts');
  const url = new URL('https://keubo.fan/?tab=home&error_description=SECRET#access_token=TOKEN&error=SECRET');
  assert.equal(errors.stripAuthErrorNoticeParams(url), true);
  assert.equal(url.searchParams.get('tab'), 'home'); assert.equal(new URLSearchParams(url.hash.slice(1)).get('access_token'), 'TOKEN'); assert(!url.href.includes('SECRET'));
});
