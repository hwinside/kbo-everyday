import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { User } from "@supabase/supabase-js";
import { resolveNaverUserForCallback } from "../../src/app/api/auth/naver/callback/route";
import { lookupAuthUserByEmail } from "../../src/lib/supabase/naver-user-lookup";

async function main() {
  const existingUser = {
    id: "21408000-0000-0000-0000-000000000001",
    email: "old-user@naver.com",
  } as unknown as User;

  const calls: string[] = [];
  const client = {
    rpc: async (_name: string, params: { p_email: string }) => {
      calls.push(`rpc:${params.p_email}`);
      return { data: existingUser.id, error: null };
    },
    auth: {
      admin: {
        getUserById: async (userId: string) => {
          calls.push(`get:${userId}`);
          return { data: { user: existingUser }, error: null };
        },
      },
    },
  };

  const found = await lookupAuthUserByEmail(client, "  OLD-USER@NAVER.COM ");
  assert.equal(found?.id, existingUser.id);
  assert.deepEqual(calls, [
    "rpc:old-user@naver.com",
    `get:${existingUser.id}`,
  ]);

  const missing = await lookupAuthUserByEmail({
    rpc: async () => ({ data: null, error: null }),
    auth: { admin: { getUserById: async () => { throw new Error("must not fetch"); } } },
  }, "new-user@naver.com");
  assert.equal(missing, undefined);

  await assert.rejects(
    lookupAuthUserByEmail({
      rpc: async () => ({ data: null, error: { message: "rpc unavailable" } }),
      auth: { admin: { getUserById: async () => { throw new Error("must not fetch"); } } },
    }, "old-user@naver.com"),
    /auth user lookup failed/
  );

  await assert.rejects(
    lookupAuthUserByEmail({
      rpc: async () => ({ data: existingUser.id, error: null }),
      auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
    }, "old-user@naver.com"),
    /user body missing/
  );

  const profile = {
    email: "old-user@naver.com",
    naverId: "naver-123",
    name: "Old User",
    avatarUrl: "",
  };

  function callbackClient(options: {
    rpcData?: string | null;
    rpcError?: { message: string } | null;
    fetchedUser?: User | null;
    fetchError?: { message: string } | null;
  }) {
    const counts = { create: 0, update: 0 };
    const createdUser = { id: "new-user-id" } as unknown as User;
    const client = {
      rpc: async () => ({
        data: options.rpcData ?? null,
        error: options.rpcError ?? null,
      }),
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: options.fetchedUser ?? null },
            error: options.fetchError ?? null,
          }),
          updateUserById: async () => {
            counts.update += 1;
            return { data: { user: options.fetchedUser ?? null }, error: null };
          },
          createUser: async () => {
            counts.create += 1;
            return { data: { user: createdUser }, error: null };
          },
        },
      },
    } as unknown as Parameters<typeof resolveNaverUserForCallback>[0];
    return { client, counts };
  }

  const existing = callbackClient({
    rpcData: existingUser.id,
    fetchedUser: existingUser,
  });
  assert.deepEqual(
    await resolveNaverUserForCallback(existing.client, profile),
    { ok: true, userId: existingUser.id, existing: true }
  );
  assert.deepEqual(existing.counts, { create: 0, update: 1 });

  for (const uncertain of [
    callbackClient({ rpcError: { message: "rpc unavailable" } }),
    callbackClient({ rpcData: existingUser.id, fetchError: { message: "fetch failed" } }),
    callbackClient({ rpcData: existingUser.id, fetchedUser: null }),
  ]) {
    assert.deepEqual(
      await resolveNaverUserForCallback(uncertain.client, profile),
      { ok: false, errorCode: "user_lookup_error" }
    );
    assert.equal(uncertain.counts.create, 0);
  }

  const newUser = callbackClient({ rpcData: null });
  assert.deepEqual(
    await resolveNaverUserForCallback(newUser.client, profile),
    { ok: true, userId: "new-user-id", existing: false }
  );
  assert.deepEqual(newUser.counts, { create: 1, update: 0 });

  const route = await readFile("src/app/api/auth/naver/callback/route.ts", "utf8");
  assert.doesNotMatch(route, /\.listUsers\s*\(/, "callback must not scan a bounded auth user page window");
  assert.match(route, /await resolveNaverUserForCallback\(/, "callback must execute the behavioral seam");

  const migration = await readFile(
    "supabase/migrations/20260802124500_lookup_auth_user_by_email.sql",
    "utf8"
  );
  assert.match(migration, /security definer/i);
  assert.match(migration, /revoke all .* public, anon, authenticated/i);
  assert.match(migration, /grant execute .* service_role/i);
  assert.match(migration, /u\.email = lower\(btrim\(p_email\)\)/i);
  assert.match(migration, /u\.is_sso_user = false/i);
  assert.match(migration, /limit 1/i);

  console.log("naver existing-user lookup smoke: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
