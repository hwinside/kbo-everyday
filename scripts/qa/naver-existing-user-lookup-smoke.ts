import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { User } from "@supabase/supabase-js";
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

  const route = await readFile("src/app/api/auth/naver/callback/route.ts", "utf8");
  assert.doesNotMatch(route, /\.listUsers\s*\(/, "callback must not scan a bounded auth user page window");
  assert.match(route, /login_error=user_lookup_error/, "lookup failure must fail closed before createUser");

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
