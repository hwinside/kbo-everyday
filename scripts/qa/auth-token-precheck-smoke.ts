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
import ts from "typescript";
import type { User } from "@supabase/supabase-js";
import {
  _clearDeadTokenCache,
  _clearInFlight,
  _inFlightSize,
  decodeJwtExpMs,
  isKnownDeadToken,
  markTokenDead,
  passesLocalPrecheck,
  verifyAccessTokenWith,
} from "../../src/lib/auth/token-precheck";

// verified-user → supabase/admin 은 import 시점에 env 를 요구하므로 스텁 후 동적 import
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://auth-precheck-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
type ExtractFn = (all: Array<{ name: string; value: string }>) => string | null;
let extractAccessTokenFromCookies!: ExtractFn;
type PrincipalFn = (claims: unknown, expectedIss: string) => { id: string; email: string | null } | null;
let principalFromClaims!: PrincipalFn;
let expectedIssuer!: (url: string) => string;

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

/** Replace comment bodies with spaces, keeping string offsets identical.
 * Length-preserving so callers can still report positions against the original. */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let mode: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "str";
        quote = c;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (mode === "str") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) mode = "code";
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      i++;
      continue;
    }
    // block
    if (c === "*" && n === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      mode = "code";
      i += 2;
      continue;
    }
    if (c !== "\n") out[i] = " ";
    i++;
  }
  return out.join("");
}

/** True when EVERY `<client>.auth.<method>(` call in `src` lexically sits
 * inside a `verifyAccessTokenWith(...)` argument list. Brace/paren matched so
 * a bypass added anywhere in the file — before, after, or between the guarded
 * calls — is caught, unlike a bare "does the string appear" check. */
/**
 * AST-based binding check (삼순 blocker⑤).
 *
 * The regex/brace version below judges the FILE, not the FUNCTION, so
 * swapping the two implementations — default calls `getUser`, live calls
 * `getClaims` — kept every assertion satisfied while inverting the meaning of
 * the whole PR. It was also fooled by method names appearing inside string
 * literals. Parsing with the TypeScript compiler removes both classes:
 * strings are not call expressions, and each call is attributed to the
 * function that lexically encloses it.
 *
 * Returns the set of `auth.<method>` calls found inside the named function.
 */
export function authCallsInsideFunction(src: string, fnName: string): Set<string> {
  const sf = ts.createSourceFile("verified-user.ts", src, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();

  function isAuthAccess(expr: ts.Expression): string | null {
    // matches `<anything>.auth.<method>` — including `x.auth["getUser"]`
    if (ts.isPropertyAccessExpression(expr)) {
      const obj = expr.expression;
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "auth") {
        return expr.name.text;
      }
    }
    if (ts.isElementAccessExpression(expr)) {
      const obj = expr.expression;
      const arg = expr.argumentExpression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === "auth" &&
        arg &&
        ts.isStringLiteralLike(arg)
      ) {
        return arg.text;
      }
    }
    return null;
  }

  function walkBody(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const m = isAuthAccess(node.expression);
      if (m) found.add(m);
    }
    ts.forEachChild(node, walkBody);
  }

  let seen = false;
  function findFn(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      seen = true;
      if (node.body) walkBody(node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === fnName &&
      node.initializer
    ) {
      seen = true;
      walkBody(node.initializer);
    }
    ts.forEachChild(node, findFn);
  }
  findFn(sf);
  // Missing function is not "no calls" — signal it so callers fail closed.
  if (!seen) found.add("<function-not-found>");
  return found;
}

export function authCallsAllInsideGuard(rawSrc: string): boolean {
  // Blank out comments FIRST, preserving offsets, so prose like
  // "goes through `auth.getClaims()`" in a doc block is not judged as a call
  // site. Replacing with spaces (not deleting) keeps every index stable.
  const src = blankComments(rawSrc);
  const guardRanges: Array<[number, number]> = [];
  // allow an optional generic argument list: verifyAccessTokenWith<Foo>(
  const guardRe = /verifyAccessTokenWith\s*(?:<[^>()]*>)?\s*\(/g;
  let g: RegExpExecArray | null;
  while ((g = guardRe.exec(src)) !== null) {
    const open = g.index + g[0].length - 1; // index of '('
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return false; // unbalanced — refuse to judge
    guardRanges.push([open, end]);
  }
  const authRe = /\bauth\.(getUser|getClaims|getSession)\s*\(/g;
  let a: RegExpExecArray | null;
  let sawAuthCall = false;
  while ((a = authRe.exec(src)) !== null) {
    sawAuthCall = true;
    const at = a.index;
    if (!guardRanges.some(([s, e]) => at > s && at < e)) return false;
  }
  // A file with no auth call at all is not "safe", it is unexpected — the
  // verifier must exist. Fail rather than silently green.
  return sawAuthCall && guardRanges.length > 0;
}

async function main() {
  const verifiedUserModule = await import("../../src/lib/auth/verified-user");
  extractAccessTokenFromCookies = verifiedUserModule.extractAccessTokenFromCookies;
  principalFromClaims = verifiedUserModule.principalFromClaims;
  expectedIssuer = verifiedUserModule.expectedIssuer;

  // --- T11: CROSS-SCOPE SINGLE-FLIGHT (삼순 blocker①)
  //
  // The two verifiers return different shapes (live adds `createdAt`). If a
  // flight is keyed on the token alone, a concurrent live call joins the
  // local call already in progress and receives an object with no
  // `createdAt` — re-arming the welcome-DM mass-send. tsc cannot see it (the
  // promise is stored as `unknown`), so it must be pinned here.
  {
    _clearDeadTokenCache();
    _clearInFlight();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let localCalls = 0;
    let liveCalls = 0;
    const localFn = async (_token: string) => {
      localCalls++;
      await gate;
      return { data: { user: { id: "u1", email: null } }, error: null };
    };
    const liveFn = async (_token: string) => {
      liveCalls++;
      await gate;
      return {
        data: { user: { id: "u1", email: null, createdAt: "2026-01-01T00:00:00Z" } },
        error: null,
      };
    };
    const pLocal = verifyAccessTokenWith(localFn, LIVE, Date.now(), "local");
    const pLive = verifyAccessTokenWith(liveFn, LIVE, Date.now(), "live");
    assert("T11a local+live are two separate flights", _inFlightSize() === 2, _inFlightSize());
    release();
    const [rLocal, rLive] = await Promise.all([pLocal, pLive]);
    assert("T11b local verifier actually ran", localCalls === 1, localCalls);
    assert("T11c live verifier actually ran (not coalesced into local)", liveCalls === 1, liveCalls);
    assert(
      "T11d live result carries createdAt (would be undefined if flights merged)",
      (rLive as { createdAt?: string } | null)?.createdAt === "2026-01-01T00:00:00Z",
      rLive,
    );
    assert("T11e local result has no createdAt", (rLocal as { createdAt?: string } | null)?.createdAt === undefined);

    // same scope still coalesces — the CPU saving must survive the fix
    _clearInFlight();
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => { release2 = r; });
    let sameScopeCalls = 0;
    const sameFn = async (_token: string) => {
      sameScopeCalls++;
      await gate2;
      return { data: { user: { id: "u1", email: null } }, error: null };
    };
    const a1 = verifyAccessTokenWith(sameFn, LIVE, Date.now(), "local");
    const a2 = verifyAccessTokenWith(sameFn, LIVE, Date.now(), "local");
    release2();
    await Promise.all([a1, a2]);
    assert("T11f same scope still single-flights (1 call for 2 waiters)", sameScopeCalls === 1, sameScopeCalls);
  }

  // --- T10: CLAIM CONTRACT (삼순 필수①②)
  //
  // getClaims() proves signature + exp. It does NOT prove the token is an
  // end-user access token for THIS project. Those claims are exactly what an
  // attacker varies, so each one is fed here as a forged claim set and must
  // come back null. Driving the real exported predicate (not a copy) means a
  // future edit that drops a check turns this RED.
  {
    const ISS = expectedIssuer("https://auth-precheck-test.supabase.co");
    const base = {
      iss: ISS,
      aud: "authenticated",
      role: "authenticated",
      sub: "11111111-1111-4111-8111-111111111111",
      session_id: "sess-1",
      email: "u@example.com",
      exp: Math.floor((NOW + 3_600_000) / 1000),
    };

    assert(
      "T10a issuer helper builds <url>/auth/v1",
      ISS === "https://auth-precheck-test.supabase.co/auth/v1",
      ISS,
    );
    const okUser = principalFromClaims(base, ISS);
    assert("T10b valid claim set → principal", okUser?.id === base.sub, okUser);
    assert("T10c principal carries email", okUser?.email === "u@example.com", okUser);

    // — each forgery below must be rejected —
    assert(
      "T10d wrong issuer (another Supabase project) rejected",
      principalFromClaims({ ...base, iss: "https://evil.supabase.co/auth/v1" }, ISS) === null,
    );
    assert(
      "T10e missing issuer rejected",
      principalFromClaims({ ...base, iss: undefined }, ISS) === null,
    );
    assert(
      "T10f wrong aud rejected",
      principalFromClaims({ ...base, aud: "anon" }, ISS) === null,
    );
    assert(
      "T10g aud array containing authenticated accepted",
      principalFromClaims({ ...base, aud: ["authenticated", "other"] }, ISS)?.id === base.sub,
    );
    assert(
      "T10h aud array without authenticated rejected",
      principalFromClaims({ ...base, aud: ["anon"] }, ISS) === null,
    );
    // The one that matters most: a service_role token must never be accepted
    // as a user principal — it would hand admin privileges a user identity.
    assert(
      "T10i role=service_role rejected",
      principalFromClaims({ ...base, role: "service_role" }, ISS) === null,
    );
    assert(
      "T10j role=anon rejected",
      principalFromClaims({ ...base, role: "anon" }, ISS) === null,
    );
    assert(
      "T10k missing role rejected",
      principalFromClaims({ ...base, role: undefined }, ISS) === null,
    );
    assert(
      "T10l missing sub rejected",
      principalFromClaims({ ...base, sub: undefined }, ISS) === null,
    );
    assert(
      "T10m blank sub rejected",
      principalFromClaims({ ...base, sub: "   " }, ISS) === null,
    );
    assert(
      "T10n missing session_id rejected",
      principalFromClaims({ ...base, session_id: undefined }, ISS) === null,
    );
    assert(
      "T10o blank session_id rejected",
      principalFromClaims({ ...base, session_id: "" }, ISS) === null,
    );
    assert("T10p null claims rejected", principalFromClaims(null, ISS) === null);
    assert("T10q non-object claims rejected", principalFromClaims("nope", ISS) === null);
    assert(
      "T10r non-string email degrades to null (not a crash)",
      principalFromClaims({ ...base, email: 42 }, ISS)?.email === null,
    );
  }
  // --- T1: expired token → local reject, zero remote calls
  _clearDeadTokenCache();
  {
    const log: CallLog = { calls: 0 };
    const user = await verifyAccessTokenWith(stubGetUser(log, { user: FAKE_USER }), EXPIRED);
    assert("T1a expired token rejected", user === null);
    assert("T1b expired token made no Supabase call", log.calls === 0, log);
    assert("T1c decodeJwtExpMs reads exp", decodeJwtExpMs(EXPIRED) !== null);
    assert("T1d passesLocalPrecheck false for expired", !passesLocalPrecheck(EXPIRED));
    // 경계: exp 시각부터는 즉시 거절 — forward slack 금지 (삼순 2차 리뷰)
    const atExp = makeJwt({ sub: "u1", exp: Math.floor(NOW / 1000) });
    assert("T1e token at exact exp rejected (no forward slack)", !passesLocalPrecheck(atExp, NOW));
    const justExpired = makeJwt({ sub: "u1", exp: Math.floor((NOW - 1_000) / 1000) });
    assert("T1f token expired 1s ago rejected", !passesLocalPrecheck(justExpired, NOW));
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

  // --- T8: single-flight — concurrent same-token verifications share ONE call
  _clearDeadTokenCache();
  _clearInFlight();
  {
    const log: CallLog = { calls: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowFn = async (_token: string) => {
      log.calls++;
      await gate;
      return { data: { user: FAKE_USER }, error: null };
    };
    const p1 = verifyAccessTokenWith(slowFn, LIVE);
    const p2 = verifyAccessTokenWith(slowFn, LIVE);
    const p3 = verifyAccessTokenWith(slowFn, LIVE);
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert("T8a concurrent same-token → exactly one Supabase call", log.calls === 1, log);
    assert("T8b all callers get the user", r1?.id === "u1" && r2?.id === "u1" && r3?.id === "u1");
    // 해소 후에는 새 호출이 다시 나간다(영구 캐시 아님)
    const r4 = await verifyAccessTokenWith(slowFn, LIVE);
    assert("T8c after settle a fresh call goes out", log.calls === 2 && r4?.id === "u1", log);
  }

  // --- T9: cookie access-token extraction is local-only parsing (no client)
  {
    const session = JSON.stringify({ access_token: LIVE, refresh_token: "r" });
    const plain = [{ name: "sb-abcdefgh-auth-token", value: session }];
    assert("T9a plain JSON cookie parsed", extractAccessTokenFromCookies(plain) === LIVE);
    const b64 = "base64-" + Buffer.from(session).toString("base64url");
    assert(
      "T9b base64- cookie parsed",
      extractAccessTokenFromCookies([{ name: "sb-abcdefgh-auth-token", value: b64 }]) === LIVE,
    );
    const half = Math.ceil(b64.length / 2);
    const chunked = [
      { name: "sb-abcdefgh-auth-token.1", value: b64.slice(half) },
      { name: "sb-abcdefgh-auth-token.0", value: b64.slice(0, half) },
    ];
    assert("T9c chunked cookies joined in index order", extractAccessTokenFromCookies(chunked) === LIVE);
    assert(
      "T9d unrelated cookies ignored",
      extractAccessTokenFromCookies([{ name: "other", value: "x" }]) === null,
    );
    assert(
      "T9e malformed cookie → null (fail-close)",
      extractAccessTokenFromCookies([{ name: "sb-abcdefgh-auth-token", value: "{not json" }]) === null,
    );
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
      "src/app/api/venue-stories/[id]/view/route.ts",
      "src/app/api/auth/delete-account/route.ts",
      "src/app/api/dm/upload/route.ts",
      "src/lib/news/discussion-auth.ts",
    ];
    for (const rel of guardedRoutes) {
      const src = readFileSync(join(root, rel), "utf8");
      assert(`T7a[${rel}] no direct auth.getUser`, !/\bauth\.getUser\b/.test(src), rel);
      assert(
        `T7a2[${rel}] no supabase server client (createServerClient/createSupabaseServer)`,
        !/createServerClient|createSupabaseServer/.test(src),
        rel,
      );
      assert(
        `T7b[${rel}] uses dead-token guard`,
        /verifyAccessToken|getVerifiedUserIdFromCookies|getVerifiedUserFromRequest/.test(src),
        rel,
      );
    }
    // 공용 verified-user.ts 자체는 가드 경유가 유일한 auth 호출점이어야 한다.
    // 문자열 존재 확인(구 T7c)은 약했다 — `verifyAccessTokenWith(` 가 파일 어딘가
    // 있기만 하면, 그 밖에서 adminClient.auth.getUser(token) 를 직접 부르는 우회
    // 경로를 추가해도 통과했다. 이제 각 auth 호출의 위치가 실제로 wrapper 인자
    // 범위 안(괄호 매칭)인지 검사한다.
    const vu = readFileSync(join(root, "src/lib/auth/verified-user.ts"), "utf8");
    // ⚠️ 아래 판정은 전부 주석을 제거한 본문으로 한다. 주석에 적힌 예시·설명
    // 문구(`auth.getClaims()` 같은)가 호출로 세져 실제 회귀를 덮는 것을 막는다 —
    // mutation 실측에서 getClaims→getUser 회귀가 주석 때문에 GREEN 으로 샘다.
    const vuCode = blankComments(vu);
    assert(
      "T7c verified-user routes every auth call through verifyAccessTokenWith",
      authCallsAllInsideGuard(vu),
    );
    // 🔴 T7c2/T7c3 는 AST 판정이다(삼순 blocker⑤).
    // 종전엔 "파일 어딘가에 getClaims 하나, getUser 하나"만 봤기 때문에
    // **두 구현을 서로 맞바꿔도**(default가 getUser, live 가 getClaims) 전 게이트
    // GREEN 이었다 — PR 의미가 정반대로 된 상태가 통과한다. 또 문자열 안의
    // 메서드명에도 속았다. 이제 함수별로 실제 호출을 귀속시켜 판정한다.
    const defaultCalls = authCallsInsideFunction(vu, "verifyAccessToken");
    const liveCalls = authCallsInsideFunction(vu, "verifyAccessTokenLive");
    assert(
      "T7c2 default verifier body calls auth.getClaims and NOT auth.getUser",
      defaultCalls.has("getClaims") && !defaultCalls.has("getUser"),
      [...defaultCalls],
    );
    assert(
      "T7c3 live verifier body calls auth.getUser and NOT auth.getClaims",
      liveCalls.has("getUser") && !liveCalls.has("getClaims"),
      [...liveCalls],
    );
    assert(
      "T7c4 live verifier is exported for revocation-sensitive routes",
      /export async function verifyAccessTokenLive\b/.test(vuCode),
    );
    // scope 분리(삼순 blocker①)가 배선되어 있는지 — 둘이 같은 scope 로
    // 들어가면 single-flight 가 결과를 섞어 createdAt 이 사라진다.
    assert(
      "T7c5 the two verifiers pass distinct single-flight scopes",
      /"local"/.test(vuCode) && /"live"/.test(vuCode),
    );
    // welcome-dm 은 auth.users.created_at(=JWT 에 없는 값)으로 “기존 유저 오발송
    // 방지” 컷오프를 건다. 로컬 claims 경로로 바꾸면 값이 undefined 가 되어 컷오프
    // 조건이 통째로 falsy → 전체 기존 유저에게 환영 DM 이 나간다. 반드시 Live.
    const welcome = blankComments(readFileSync(join(root, "src/app/api/welcome-dm/route.ts"), "utf8"));
    assert(
      "T7e welcome-dm uses the live verifier (needs auth.users.created_at cutoff)",
      /verifyAccessTokenLive\(/.test(welcome) && !/\bverifyAccessToken\(/.test(welcome),
    );
    // 🔴 T7e2 — 컷오프가 fail-CLOSED 인지(삼순 blocker③).
    // 종전 조건은 `createdAt && createdAt < cutoff` 이어서 createdAt 이 없거나
    // 파싱 불가하면 조건이 falsy → 그대로 발송으로 진행했다. 값을 못 믿는
    // 상황에서 "발송"이 기본값이면 대량 오발송 방어선이 없다.
    assert(
      "T7e2 welcome-dm fails CLOSED when createdAt is missing/unparseable",
      /Number\.isFinite\(createdAtMs\)/.test(welcome) &&
        /unknown_created_at/.test(welcome),
      "expected a finite-check on createdAt with a skip/refuse branch",
    );
    assert(
      "T7e3 welcome-dm fails CLOSED on an invalid cutoff env value",
      /Number\.isFinite\(cutoffMs\)/.test(welcome) && /invalid_cutoff/.test(welcome),
    );
    // 🔴 T7f — 계정 영구 삭제는 서버 권위 검증이어야 한다(삼순 blocker②).
    // 로컬 claim 검증은 exp(3600s) 까지 유효해서 이미 폐기된 세션으로도
    // 되돌릴 수 없는 삭제가 실행된다.
    const del = blankComments(
      readFileSync(join(root, "src/app/api/auth/delete-account/route.ts"), "utf8"),
    );
    assert(
      "T7f delete-account uses the LIVE cookie verifier (irreversible action)",
      /getVerifiedUserIdFromCookiesLive\(/.test(del) &&
        !/getVerifiedUserIdFromCookies\(/.test(del),
    );
    // 쿠키 fallback은 순수 쿠키 파싱만 — auth-js 클라이언트 금지(getSession은
    // 만료 임박 시 /auth/v1/token refresh를 내보낸다 — 삼순 2차 리뷰)
    assert(
      "T7d cookie fallback parses cookies directly — no getSession/createServerClient",
      /extractAccessTokenFromCookies\(/.test(vu) &&
        !/getSession\(/.test(vu) &&
        !/createServerClient/.test(vu) &&
        !/auth\.getUser\(\)/.test(vu),
    );
  }

  console.log(failed === 0 ? "\nAll auth-token-precheck smoke tests PASSED" : `\n${failed} test(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
