import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

test("invite refresh failure returns HTTP 500 with ok:false", async () => {
  process.env.CRON_SECRET = "leaderboard-rollup-test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://leaderboard-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

  const admin = await import("../../src/lib/supabase/admin");
  const { GET } = await import("../../src/app/api/cron/leaderboard-rollup/route");
  const client = admin.supabaseAdmin as unknown as {
    rpc: (name: string) => Promise<{ data: string | null; error: { message: string } | null }>;
  };
  const originalRpc = client.rpc;
  const calls: string[] = [];
  client.rpc = async (name) => {
    calls.push(name);
    if (name === "leaderboard_writing_rollup_refresh") {
      return { data: "refreshed", error: null };
    }
    return { data: null, error: { message: "invite refresh exploded" } };
  };

  try {
    const response = await GET(
      new NextRequest("http://localhost/api/cron/leaderboard-rollup", {
        headers: { authorization: "Bearer leaderboard-rollup-test" },
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.writing, "refreshed");
    assert.equal(body.error, "invite rollup refresh failed");
    assert.match(body.details, /invite refresh exploded/);
    assert.deepEqual(calls, [
      "leaderboard_writing_rollup_refresh",
      "leaderboard_invite_rollup_refresh",
    ]);
  } finally {
    client.rpc = originalRpc;
  }
});
