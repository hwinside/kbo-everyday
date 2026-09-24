const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<div id="root"></div>');
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
const source = ts.transpileModule(fs.readFileSync('src/lib/supabase/useBlock.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
let user = { id: 'owner' };
let requests = [];
let respond;
const supabase = { from(table) {
  const query = { table, filters: [] };
  const builder = {
    select(fields) { query.fields = fields; return builder; },
    delete() { query.remove = true; return builder; },
    eq(key, value) { query.filters.push([key, value]); return builder; },
    in(key, value) { query.ids = value; return builder; },
    order() { return builder; },
    range(start, end) { query.range = [start, end]; return builder; },
    then(resolve, reject) { requests.push(query); return Promise.resolve().then(() => respond(query)).then(resolve, reject); },
  };
  return builder;
} };
const exportsObject = {};
vm.runInNewContext(source, {
  exports: exportsObject, window: dom.window, Event: dom.window.Event,
  require(name) {
    if (name === 'react') return React;
    if (name === './client') return { supabase };
    if (name === './AuthContext') return { useAuth: () => ({ user }) };
    throw new Error(name);
  },
});
const { unblockUserById, useBlockList } = exportsObject;
let current;
function Probe() { current = useBlockList(); return null; }
async function settle(action) { await React.act(async () => { await action(); }); }

test('unblock scopes both identities; broadcasts only success; handles DB/network failure', async () => {
  let events = 0;
  const listener = () => events++;
  window.addEventListener('kbo:block-changed', listener);
  requests = [];
  respond = () => ({ error: { message: 'denied' } });
  assert.equal(await unblockUserById('owner', 'target'), false);
  assert.equal(events, 0);
  assert.deepEqual(requests[0].filters, [['blocker_id', 'owner'], ['blocked_id', 'target']]);
  respond = () => { throw new Error('offline'); };
  assert.equal(await unblockUserById('owner', 'target'), false);
  assert.equal(events, 0);
  respond = () => ({ error: null });
  assert.equal(await unblockUserById('owner', 'target'), true);
  assert.equal(events, 1);
  window.removeEventListener('kbo:block-changed', listener);
});

test('list pages beyond 100; limits profile fields; distinguishes errors, empty, logout', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: `${i}`, blocked_id: `u${i}`, created_at: '2026-09-24T00:00:00Z' }));
  requests = [];
  respond = (query) => query.table === 'profiles'
    ? { data: query.ids.map(id => ({ id, nickname: id, team_id: 1 })), error: null }
    : { data: rows.slice(query.range[0], query.range[1] + 1), error: null };
  const root = createRoot(document.getElementById('root'));
  await settle(() => root.render(React.createElement(Probe)));
  assert.equal(current.blockedUsers.length, 101);
  assert.equal(current.error, null);
  assert.deepEqual(requests.filter(q => q.table === 'user_blocks').map(q => q.range), [[0, 99], [100, 199]]);
  assert.ok(requests.filter(q => q.table === 'profiles').every(q => q.fields === 'id, nickname, team_id'));
  respond = (query) => query.table === 'profiles'
    ? { error: { message: 'profile denied' }, data: null }
    : { data: rows.slice(0, 1), error: null };
  await settle(() => current.refresh());
  assert.ok(current.error, 'profile lookup failure must not become unknown-user success');
  assert.equal(current.loading, false);
  respond = () => ({ error: { message: 'denied' }, data: null });
  await settle(() => current.refresh());
  assert.ok(current.error);
  assert.equal(current.loading, false);
  respond = () => ({ data: [], error: null });
  await settle(() => window.dispatchEvent(new dom.window.Event('kbo:block-changed')));
  assert.equal(current.blockedUsers.length, 0);
  assert.equal(current.error, null);
  user = null;
  await settle(() => root.render(React.createElement(Probe)));
  assert.equal(current.blockedUsers.length, 0);
  await settle(() => root.unmount());
});
