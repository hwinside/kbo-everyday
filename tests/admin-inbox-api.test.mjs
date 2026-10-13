import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';

// Keep the real route and Next request/response implementation; replace only
// external auth/database dependencies so no credentials or live data are used.
const fixture = { authed: false, calls: [], result: { data: 3, error: null }, NextResponse };
globalThis.__adminInboxRouteTest = fixture;
const source = readFileSync('src/app/api/admin/messages/route.ts', 'utf8')
  .replace('import { getSupabaseAdmin } from "@/lib/supabase/admin";', `const getSupabaseAdmin = () => ({ rpc: async (name, params) => {
    globalThis.__adminInboxRouteTest.calls.push({ name, params });
    return globalThis.__adminInboxRouteTest.result;
  }});`)
  .replace('import { NextRequest, NextResponse } from "next/server";', 'const { NextResponse } = globalThis.__adminInboxRouteTest;')
  .replace('import { isAdminAuthedRequest } from "@/lib/admin/pin";', 'const isAdminAuthedRequest = async () => globalThis.__adminInboxRouteTest.authed;');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { POST } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const request = (extra = {}) => new NextRequest('http://localhost/api/admin/messages', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'mark_all_read', ...extra }),
});

test('bulk read API: auth, server-owned scope, missing config and database failure', async () => {
  const previousSystem = process.env.SYSTEM_USER_ID;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.equal((await POST(request())).status, 401);
    assert.equal(fixture.calls.length, 0);
    fixture.authed = true;
    assert.equal((await POST(request())).status, 500);
    assert.equal(fixture.calls.length, 0);
    process.env.SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';
    // Deliberately non-credential value, only exercises the route's presence check.
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-test-placeholder';
    const response = await POST(request({ systemUserId: 'foreign', conversationId: 'foreign', cursorId: 'foreign' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, updatedCount: 3 });
    assert.deepEqual(fixture.calls, [{ name: 'admin_dm_mark_all_read', params: { p_system_user_id: process.env.SYSTEM_USER_ID } }]);
    for (const result of [{ data: null, error: { message: 'database unavailable' } }, { data: null, error: null }, { data: 'invalid', error: null }]) {
      fixture.result = result;
      const failed = await POST(request());
      assert.equal(failed.status, 500);
      assert.deepEqual(await failed.json(), { error: 'mark_all_read_failed' });
    }
    fixture.result = { data: 0, error: null };
    assert.deepEqual(await (await POST(request())).json(), { ok: true, updatedCount: 0 });
  } finally {
    if (previousSystem === undefined) delete process.env.SYSTEM_USER_ID; else process.env.SYSTEM_USER_ID = previousSystem;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    delete globalThis.__adminInboxRouteTest;
  }
});
