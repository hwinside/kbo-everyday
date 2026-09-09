// Offline only. Load the real route with isolated services; no credentials/network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const nativeRequire = createRequire(import.meta.url);
let enabled = true, authorized = true, rpcError = null, calls = [], detailCalls = 0;
const mocks = {
  'server-only': {},
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/game-reviews/feature': { get GAME_REVIEWS_ENABLED() { return enabled; } },
  '@/lib/auth/verified-user': { getVerifiedUserFromRequest: async () => authorized ? { user: { id: 'viewer-fixture' } } : null },
  '@/lib/services/game-detail': { getGameDetailRouteResult: async () => { detailCalls++; throw new Error('External scoreboard unavailable'); } },
  '@/lib/game-reviews/author-avatars': { withAuthorAvatars: async feed => feed },
  '@/lib/supabase/admin': { supabaseAdmin: { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { review: { id: args.rid }, rows: [{ id: 8 }], next: 8 }, error: rpcError };
  } } },
};
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Response,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name.startsWith('@/')) return load(resolve('src', name.slice(2)) + '.ts');
      if (name.startsWith('.')) return load(resolve(dirname(file), name) + '.ts');
      return nativeRequire(name);
    },
  }, { filename: file });
  modules.set(file, module.exports); return module.exports;
}
const { GET } = load(resolve('src/app/api/games/[gameId]/reviews/route.ts'));
async function get(query, { bearer = false, game = '20260909LGHH0' } = {}) {
  calls = []; detailCalls = 0;
  return GET({ nextUrl: new URL(`https://offline.invalid/reviews${query}`), headers: new Headers(bearer ? { authorization: 'Bearer fixture-not-a-credential' } : {}) }, { params: Promise.resolve({ gameId: game }) });
}
let response = await get('?review=7');
assert.equal(response.status, 200); assert.equal(detailCalls, 0);
assert.equal(calls.length, 1); assert.equal(calls[0].name, 'gr_feed');
assert.equal(calls[0].args.rid, 7); assert.equal(calls[0].args.g, '20260909LGHH0');
assert.equal(calls[0].args.a, 'viewer-fixture');
assert.equal(response.headers.get('cache-control'), 'private, no-store');
assert.deepEqual((await response.json()).feed.rows, [{ id: 8 }]);
response = await get('?review=7&before=8');
assert.equal(response.status, 200); assert.equal(calls[0].args.before_id, 8);
for (const query of ['?review=abc', '?review=0', '?review=9007199254740992', '?review=7&before=-1']) {
  response = await get(query); assert.equal(response.status, 400); assert.equal(calls.length, 0);
}
response = await get('?review=7', { game: 'bad-game' }); assert.equal(response.status, 400); assert.equal(calls.length, 0);
authorized = false;
response = await get('?review=7', { bearer: true }); assert.equal(response.status, 401); assert.equal(calls.length, 0);
response = await get('?review=7'); assert.equal(response.status, 200); assert.equal(calls[0].args.a, null);
// DB authority remains decisive for a hidden/deleted/blocked/wrong-game parent.
rpcError = { message: 'gr_missing' };
response = await get('?review=7'); assert.equal(response.status, 404); assert.equal(detailCalls, 0);
rpcError = { message: 'database unavailable' };
response = await get('?review=7'); assert.equal(response.status, 503);
rpcError = null; enabled = false;
response = await get('?review=7'); assert.equal(response.status, 404); assert.equal(calls.length, 0); assert.equal(detailCalls, 0);
enabled = true;
response = await get(''); assert.equal(response.status, 503); assert.equal(detailCalls, 1); assert.equal(calls.length, 0);
console.log('PASS: comment reads independent of external game detail; auth, parent authority, cursor, off guard and errors preserved');

const { createReviewTokenReader } = load(resolve('src/lib/game-reviews/session-token.ts'));
const session = (id, token = 'synthetic-token') => ({ user: { id }, access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
let sessionReads = 0, resolveSession;
const reader = createReviewTokenReader('a', () => { sessionReads++; return new Promise(resolve => { resolveSession = resolve; }); });
const first = reader.read(), concurrent = reader.read();
assert.equal(sessionReads, 1); resolveSession(session('a'));
assert.deepEqual(await Promise.all([first, concurrent]), ['synthetic-token', 'synthetic-token']);
assert.equal(await reader.read(), 'synthetic-token'); assert.equal(sessionReads, 1);
reader.update(session('a', 'refreshed-fixture'));
assert.equal(await reader.read(), 'refreshed-fixture'); assert.equal(sessionReads, 1);
reader.update(null);
const late = reader.read(); reader.update(null); resolveSession(session('a'));
await assert.rejects(late, /로그인/);
reader.update(session('b'));
const switched = reader.read(); resolveSession(session('b')); await assert.rejects(switched, /로그인/);
const guest = createReviewTokenReader(null, () => { throw new Error('Guest must not wait for session'); });
assert.equal(await guest.read(), null);
const expired = createReviewTokenReader('a', async () => ({ ...session('a'), expires_at: 1 }));
await assert.rejects(expired.read(), /로그인/);
console.log('PASS: warm-token reuse, in-flight dedupe, refresh, logout race, account isolation and expiry');
