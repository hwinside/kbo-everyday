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
 *  3. a token Supabase rejected with a definitive Auth error CODE
 *     (bad_jwt / session_expired / …) is negative-cached: second attempt
 *     makes NO further Supabase call
 *  4. retryable failures are NOT cached — 429 rate-limit, 408 timeout,
 *     5xx, statusless network errors, and codeless 4xx all stay retryable
 *  5. a valid token passes through and returns the user
 *  6. dead-token cache entries expire after their TTL
 *  7. ROUTE BINDING — the guarded API routes must actually go through
 *     verifyAccessToken / getVerifiedUserIdFromCookies; reverting any of them
 *     to a direct auth.getUser() turns this gate RED
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  result: { user: User | null; errorStatus?: number | null; errorCode?: string },
) {
  return async (_token: string) => {
    log.calls++;
    if (result.user) return { data: { user: result.user }, error: null };
    const error: { status?: number; code?: string } = {};
    if (result.errorStatus !== null && result.errorStatus !== undefined) error.status = result.errorStatus;
    if (result.errorCode) error.code = result.errorCode;
    return { data: { user: null }, error };
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

  // --- T3: definitive Auth error CODE → cached; repeat makes no remote call
  for (const code of ["bad_jwt", "session_expired", "session_not_found", "user_not_found"]) {
    _clearDeadTokenCache();
    const log: CallLog = { calls: 0 };
    const fn = stubGetUser(log, { user: null, errorStatus: 403, errorCode: code });
    const first = await verifyAccessTokenWith(fn, LIVE);
    const second = await verifyAccessTokenWith(fn, LIVE);
    assert(`T3a[${code}] dead-session token rejected`, first === null && second === null);
    assert(`T3b[${code}] Supabase called exactly once`, log.calls === 1, log);
    assert(`T3c[${code}] token registered in dead cache`, isKnownDeadToken(LIVE));
  }

  // --- T4: retryable failures NOT cached — 429/408 (with codes), 5xx,
  //     statusless network error, and codeless 4xx
  const retryable: Array<{ label: string; errorStatus?: number | null; errorCode?: string }> = [
    { label: "429 over_request_rate_limit", errorStatus: 429, errorCode: "over_request_rate_limit" },
    { label: "408 request_timeout", errorStatus: 408, errorCode: "request_timeout" },
    { label: "503 server error", errorStatus: 503 },
    { label: "statusless network error", errorStatus: null },
    { label: "codeless 403", errorStatus: 403 },
  ];
  for (const c of retryable) {
    _clearDeadTokenCache();
    const log: CallLog = { calls: 0 };
    const fn = stubGetUser(log, { user: null, errorStatus: c.errorStatus, errorCode: c.errorCode });
    await verifyAccessTokenWith(fn, LIVE);
    await verifyAccessTokenWith(fn, LIVE);
    assert(`T4[${c.label}] retried, not cached`, log.calls === 2, log);
    assert(`T4[${c.label}] not in dead cache`, !isKnownDeadToken(LIVE));
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

  // --- T7: route binding — guarded routes must use the guard, not raw getUser
  {
    const root = join(__dirname, "..", "..");
    const guardedRoutes = [
      "src/app/api/me/route.ts",
      "src/app/api/welcome-dm/route.ts",
      "src/app/api/telemetry/page-dwell/route.ts",
      "src/app/api/leaderboard/my-rank/route.ts",
      "src/app/api/leaderboard/my-snapshot/route.ts",
      "src/app/api/setup/route.ts",
      "src/app/api/avatar/upload/route.ts",
    ];
    for (const rel of guardedRoutes) {
      const src = readFileSync(join(root, rel), "utf8");
      assert(`T7a[${rel}] no direct auth.getUser`, !/\bauth\.getUser\b/.test(src), rel);
      assert(
        `T7b[${rel}] uses dead-token guard`,
        /verifyAccessToken|getVerifiedUserIdFromCookies|getVerifiedUserFromRequest/.test(src),
        rel,
      );
    }
    // 공용 verified-user.ts 자체는 가드 경유가 유일한 auth.getUser 호출점이어야 한다
    const vu = readFileSync(join(root, "src/lib/auth/verified-user.ts"), "utf8");
    assert(
      "T7c verified-user routes getUser through verifyAccessTokenWith",
      /verifyAccessTokenWith\(/.test(vu),
    );
    // 쿠키 fallback도 /auth/v1/user 직접 호출 금지 (getSession은 로컬)
    assert(
      "T7d cookie fallback reads session locally (getSession), no auth.getUser()",
      /getSession\(\)/.test(vu) && !/auth\.getUser\(\)/.test(vu),
    );
  }

  console.log(failed === 0 ? "\nAll auth-token-precheck smoke tests PASSED" : `\n${failed} test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
