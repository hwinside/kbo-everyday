/**
 * Smoke test for the dead-token guard in src/lib/auth/verified-user.ts.
 *
 * Background (2026-08-12, #infra): stale clients kept polling authenticated
 * API routes with dead sessions. Every request triggered a server-side
 * `auth.getUser(token)` → Supabase `/auth/v1/user` 403. One evening window
 * (2026-08-11 19:00~01:00 KST) burned 4,402 warnings. Goal: dashboard
 * warnings = 0, so dead tokens must never reach Supabase repeatedly.
 *
 * Verifies against the REAL exported functions (no local re-implementation):
 *  1. expired-exp JWT is rejected locally with zero Supabase calls
 *  2. non-JWT garbage is rejected locally with zero Supabase calls
 *  3. a token Supabase rejected definitively (4xx) is negative-cached:
 *     second attempt makes NO further Supabase call
 *  4. transient failures (5xx / no status) are NOT cached — retry allowed
 *  5. a valid token passes through and returns the user
 *  6. dead-token cache entries expire after their TTL
 */
import type { User } from "@supabase/supabase-js";
import {
  _clearDeadTokenCache,
  decodeJwtExpMs,
  isKnownDeadToken,
  markTokenDead,
  passesLocalPrecheck,
  verifyAccessTokenWith,
} from "../../src/lib/auth/token-precheck";

let failed = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
  if (!cond) {
    failed++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.signature`;
}

const NOW = Date.now();
const EXPIRED = makeJwt({ sub: "u1", exp: Math.floor((NOW - 3_600_000) / 1000) });
const LIVE = makeJwt({ sub: "u1", exp: Math.floor((NOW + 3_600_000) / 1000) });
const FAKE_USER = { id: "u1" } as unknown as User;

type CallLog = { calls: number };
function stubGetUser(
  log: CallLog,
  result: { user: User | null; errorStatus?: number | null },
) {
  return async (_token: string) => {
    log.calls++;
    if (result.user) return { data: { user: result.user }, error: null };
    return {
      data: { user: null },
      error: result.errorStatus === null ? {} : { status: result.errorStatus },
    };
  };
}

async function main() {
  // --- T1: expired token → local reject, zero remote calls
  _clearDeadTokenCache();
  {
    const log: CallLog = { calls: 0 };
    const user = await verifyAccessTokenWith(stubGetUser(log, { user: FAKE_USER }), EXPIRED);
    assert("T1a expired token rejected", user === null);
    assert("T1b expired token made no Supabase call", log.calls === 0, log);
    assert("T1c decodeJwtExpMs reads exp", decodeJwtExpMs(EXPIRED) !== null);
    assert("T1d passesLocalPrecheck false for expired", !passesLocalPrecheck(EXPIRED));
  }

  // --- T2: non-JWT garbage → local reject, zero remote calls
  {
    const log: CallLog = { calls: 0 };
    const user = await verifyAccessTokenWith(stubGetUser(log, { user: FAKE_USER }), "not-a-jwt");
    assert("T2a garbage token rejected", user === null);
    assert("T2b garbage token made no Supabase call", log.calls === 0, log);
  }

  // --- T3: definitive 4xx → cached; repeat makes no further remote call
  _clearDeadTokenCache();
  {
    const log: CallLog = { calls: 0 };
    const fn = stubGetUser(log, { user: null, errorStatus: 403 });
    const first = await verifyAccessTokenWith(fn, LIVE);
    const second = await verifyAccessTokenWith(fn, LIVE);
    assert("T3a dead-session token rejected", first === null && second === null);
    assert("T3b Supabase called exactly once for repeated dead token", log.calls === 1, log);
    assert("T3c token registered in dead cache", isKnownDeadToken(LIVE));
  }

  // --- T4: transient failure (5xx / statusless) NOT cached
  _clearDeadTokenCache();
  {
    const log: CallLog = { calls: 0 };
    const fn = stubGetUser(log, { user: null, errorStatus: 503 });
    await verifyAccessTokenWith(fn, LIVE);
    await verifyAccessTokenWith(fn, LIVE);
    assert("T4a 5xx failure retried (no cache)", log.calls === 2, log);
    const log2: CallLog = { calls: 0 };
    const fn2 = stubGetUser(log2, { user: null, errorStatus: null });
    await verifyAccessTokenWith(fn2, LIVE);
    await verifyAccessTokenWith(fn2, LIVE);
    assert("T4b statusless failure retried (no cache)", log2.calls === 2, log2);
  }

  // --- T5: valid token → user returned, remote called, not cached as dead
  _clearDeadTokenCache();
  {
    const log: CallLog = { calls: 0 };
    const fn = stubGetUser(log, { user: FAKE_USER });
    const user = await verifyAccessTokenWith(fn, LIVE);
    assert("T5a valid token returns user", user?.id === "u1");
    assert("T5b valid token called Supabase once", log.calls === 1, log);
    assert("T5c valid token not dead-cached", !isKnownDeadToken(LIVE));
  }

  // --- T6: dead cache entry expires after TTL
  _clearDeadTokenCache();
  {
    markTokenDead(LIVE, NOW);
    assert("T6a dead within TTL", isKnownDeadToken(LIVE, NOW + 60_000));
    assert("T6b dead expires after TTL", !isKnownDeadToken(LIVE, NOW + 16 * 60_000));
  }

  console.log(failed === 0 ? "\nAll auth-token-precheck smoke tests PASSED" : `\n${failed} test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
