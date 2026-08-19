/**
 * ES256/JWKS 종단 게이트 (삼순 필수② — 2026-08-19 #infra).
 *
 * 왜 별도 파일인가:
 *   auth-token-precheck-smoke.ts 의 T10 은 `principalFromClaims()` 에 객체를
 *   **직접 넣는** 단위검사이고, T5 는 주입된 fake verifier 를 태운다. 둘 다
 *   "실제 서명된 토큰이 auth-js 의 getClaims() 를 통과해 우리 계약에 도달한다"
 *   와 "그 경로가 /auth/v1/user 를 한 번도 부르지 않는다" 를 증명하지 못한다.
 *   이 PR 의 존재 이유가 바로 그 왕복 제거이므로, 그 축은 종단으로 고정한다.
 *
 * 어떻게 종단인가:
 *   - 진짜 ECDSA P-256 키쌍을 만들고, 진짜 ES256 JWT 를 서명한다.
 *   - globalThis.fetch 를 **import 전에** 라우터로 교체해서
 *       /.well-known/jwks.json → 공개키 JWK
 *       /auth/v1/user        → 호출 카운트 증가 (여기 오면 왕복이 살아있다는 뜻)
 *     로 응답한다. 네트워크는 나가지 않지만 auth-js 의 실제 코드 경로
 *     (decodeJWT → fetchJwk → crypto.subtle.importKey → verify) 는 전부 탄다.
 *   - 그 위에서 우리 `verifyAccessToken` / `verifyAccessTokenLive` 를 부른다.
 *
 * 판정의 핵심은 산출물이 아니라 **호출 카운터**다. "인증에 성공했다" 는
 * 왕복을 제거했다는 증거가 못 된다 — /user 가 0회였다는 것만이 증거다.
 */
import { createHash, webcrypto } from "node:crypto";

const subtle = (webcrypto as unknown as Crypto).subtle;

let failed = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
  if (!cond) {
    failed++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

// ── 가짜 Supabase 엔드포인트 ────────────────────────────────────────────────
const SUPABASE_URL = "http://127.0.0.1:59991";
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-qa";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-qa";

const ISS = `${SUPABASE_URL}/auth/v1`;
const KID = "qa-es256-key";
const SUB = "11111111-2222-4333-8444-555555555555";

const counters = { user: 0, jwks: 0, token: 0, other: 0 };
function resetCounters() {
  counters.user = 0;
  counters.jwks = 0;
  counters.token = 0;
  counters.other = 0;
}

/**
 * /auth/v1/user 응답을 401 로 바꾸는 스위치.
 *
 * dead-token 캐시가 실제로 왕복을 막는 지점은 **live 검증기**다.
 * 로컬 검증 경로는 서명만 보고 끝나서 애초에 /user 를 안 부르므로,
 * 그쪽으로 네가티브를 지으면 캐시를 꺼도 카운터가 안 움직인다 = 관측 불가.
 * 원사건(2026-08-11 저녁 4,402 warnings)도 "죽은 세션이 서버에 반복으로
 * 물어본 것"이므로, 401 을 돌려주는 상태가 재현 조건이다.
 */
let userReturns401 = false;

// ── ES256 키쌍 + 서명 ──────────────────────────────────────────────────────
const b64url = (buf: Uint8Array | Buffer) => Buffer.from(buf).toString("base64url");
const jsonB64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

type Claims = Record<string, unknown>;

async function main() {
  const keyPair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const publicJwk = (await subtle.exportKey("jwk", keyPair.publicKey)) as Record<string, unknown>;
  publicJwk.kid = KID;
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";

  // 진짜와 다른 키 — 위조 서명 케이스에 쓴다.
  const wrongPair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  async function signWith(privateKey: CryptoKey, claims: Claims, header?: Claims) {
    const h = jsonB64({ alg: "ES256", typ: "JWT", kid: KID, ...(header ?? {}) });
    const p = jsonB64(claims);
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }

  const nowSec = () => Math.floor(Date.now() / 1000);
  const baseClaims = (over: Claims = {}): Claims => ({
    iss: ISS,
    aud: "authenticated",
    role: "authenticated",
    sub: SUB,
    session_id: "3f2b1a90-0000-4000-8000-abcdefabcdef",
    email: "qa-user@example.com",
    exp: nowSec() + 3600,
    iat: nowSec(),
    ...over,
  });

  // ── fetch 라우터 (import 전에 설치해야 supabase 클라이언트가 이걸 잡는다) ──
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(
      typeof input === "string" ? input : (input as { url?: string })?.url ?? input,
    );
    if (url.includes("/.well-known/jwks.json")) {
      counters.jwks++;
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/auth/v1/user")) {
      counters.user++;
      if (userReturns401) {
        return new Response(
          JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid claim: missing sub claim" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      // live 검증기가 실제로 이 응답을 소비하는지도 같이 본다.
      return new Response(
        JSON.stringify({
          id: SUB,
          email: "qa-user@example.com",
          created_at: "2026-01-02T03:04:05Z",
          aud: "authenticated",
          role: "authenticated",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/auth/v1/token")) {
      counters.token++;
      return new Response(JSON.stringify({ error: "not expected in this gate" }), { status: 400 });
    }
    counters.other++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const precheck = await import("../../src/lib/auth/token-precheck");
  const verifiedUser = await import("../../src/lib/auth/verified-user");
  const { verifyAccessToken, verifyAccessTokenLive } = verifiedUser as unknown as {
    verifyAccessToken: (t: string) => Promise<{ id: string; email: string | null } | null>;
    verifyAccessTokenLive: (
      t: string,
    ) => Promise<{ id: string; email: string | null; createdAt?: string } | null>;
  };
  const { _clearDeadTokenCache, _clearInFlight } = precheck as unknown as {
    _clearDeadTokenCache: () => void;
    _clearInFlight: () => void;
  };

  const fresh = () => {
    _clearDeadTokenCache();
    _clearInFlight();
    resetCounters();
  };

  // ── T12a: 정상 ES256 토큰 → 통과하고 /user 는 0회 ─────────────────────────
  {
    fresh();
    const token = await signWith(keyPair.privateKey, baseClaims());
    const user = await verifyAccessToken(token);
    assert("T12a valid ES256 token verifies end-to-end", user?.id === SUB, user);
    assert("T12a2 email claim reaches the caller", user?.email === "qa-user@example.com", user);
    // 이 PR 전체가 이 한 줄을 위해 존재한다.
    assert("T12a3 ZERO /auth/v1/user round trips for a valid token", counters.user === 0, counters);
    assert("T12a4 JWKS was actually fetched (real verification path ran)", counters.jwks === 1, counters);
  }

  // ── T12b: JWKS 캐시 — 두 번째 요청은 네트워크 0회 ─────────────────────────
  {
    fresh();
    const t1 = await signWith(keyPair.privateKey, baseClaims());
    const t2 = await signWith(keyPair.privateKey, baseClaims({ session_id: "9c8b7a60-0000-4000-8000-fedcbafedcba" }));
    await verifyAccessToken(t1);
    const before = { ...counters };
    await verifyAccessToken(t2);
    assert(
      "T12b JWKS is cached — a second token costs no extra fetch",
      counters.jwks === before.jwks && counters.user === 0,
      { before, after: { ...counters } },
    );
  }

  // ── T12c: 위조 서명 → 거부, 그리고 /user 로 새지 않는다 ──────────────────
  // 서명이 틀렸다고 서버에 물어보러 가면 공격자가 왕복을 유발할 수 있다.
  {
    fresh();
    const forged = await signWith(wrongPair.privateKey, baseClaims());
    const user = await verifyAccessToken(forged);
    assert("T12c forged signature rejected", user === null, user);
    assert("T12c2 forged signature does not fall back to /user", counters.user === 0, counters);
  }

  // ── T12d: payload 변조(서명 그대로) → 거부 ────────────────────────────────
  {
    fresh();
    const good = await signWith(keyPair.privateKey, baseClaims());
    const [h, , s] = good.split(".");
    const tampered = `${h}.${jsonB64(baseClaims({ sub: "00000000-0000-4000-8000-000000000000" }))}.${s}`;
    const user = await verifyAccessToken(tampered);
    assert("T12d tampered payload rejected (signature no longer matches)", user === null, user);
    assert("T12d2 tampered payload does not reach /user", counters.user === 0, counters);
  }

  // ── T12e: 만료 → 로컬에서 거부, 네트워크 0회 ─────────────────────────────
  {
    fresh();
    const expired = await signWith(keyPair.privateKey, baseClaims({ exp: nowSec() - 60 }));
    const user = await verifyAccessToken(expired);
    assert("T12e expired token rejected", user === null, user);
    assert("T12e2 expired token costs zero network calls", counters.user === 0 && counters.jwks === 0, counters);
  }

  // ── T12f~T12j: 서명은 유효하지만 claim 계약 위반 → 거부 ──────────────────
  // 서명 검증만 하고 claim 을 안 보면 여기가 전부 통과한다. 그게 이 PR 이
  // 새로 만든 표면이므로, 종단에서 다시 잠근다.
  const contractCases: Array<[string, Claims]> = [
    ["T12f wrong issuer (another project) rejected", { iss: "http://127.0.0.1:59992/auth/v1" }],
    ["T12g wrong aud rejected", { aud: "some-other-audience" }],
    ["T12h role=service_role rejected", { role: "service_role" }],
    ["T12i role=anon rejected", { role: "anon" }],
    ["T12j missing session_id rejected", { session_id: undefined }],
    // sub 는 이 시스템의 유일한 주체 식별자다. 서명이 유효한데 sub 가 없거나
    // 비어 있는 토큰을 받아들이면 `id: ""` 인 유저가 생기고, 그 빈 문자열이
    // 하류 조회의 필터로 들어가면 소유권 경계가 무너진다. T10 은 객체를 직접
    // 넣는 단위검사라, 서명된 실물 토큰으로 종단에서 다시 잠그다(삼순 지적).
    ["T12o missing sub rejected", { sub: undefined }],
    ["T12p blank sub rejected", { sub: "" }],
    ["T12q whitespace-only sub rejected", { sub: "   " }],
    ["T12r non-string sub rejected", { sub: 12345 }],
  ];
  for (const [label, over] of contractCases) {
    fresh();
    const claims = baseClaims(over);
    // 🔴 `in` 으로 물어야 한다. `over.session_id === undefined` 로 쓰면 **그 키가
    // 아예 없는 케이스에서도 true** 가 돼, sub 케이스(T12o~r)의 멀짓한
    // session_id 까지 지워버렸다. 그러면 sub 가드를 통째로 삭제해도
    // session_id 가드가 대신 막아서 전부 PASS — 거짓 GREEN 이다.
    // M15(sub 검사 제거) 가 RED 가 안 되는 것으로 이 결함이 드러났다.
    if ("session_id" in over && over.session_id === undefined) {
      delete (claims as Record<string, unknown>).session_id;
    }
    if ("sub" in over && over.sub === undefined) delete (claims as Record<string, unknown>).sub;
    const token = await signWith(keyPair.privateKey, claims);
    const user = await verifyAccessToken(token);
    assert(label, user === null, user);
    assert(`${label.split(" ")[0]}2 no /user fallback on contract violation`, counters.user === 0, counters);
  }

  // ── T12k: aud 배열 형태는 정상 통과 (실제 Supabase 토큰 변형) ────────────
  {
    fresh();
    const token = await signWith(keyPair.privateKey, baseClaims({ aud: ["authenticated"] }));
    const user = await verifyAccessToken(token);
    assert("T12k aud array containing authenticated accepted", user?.id === SUB, user);
    assert("T12k2 still zero /user", counters.user === 0, counters);
  }

  // ── T12l: live 검증기는 반대로 정확히 1회 왕복해야 한다 ──────────────────
  // 되돌릴 수 없는 작업(계정 삭제·환영 DM)이 로컬 검증으로 조용히 강등되면
  // 폐기된 세션이 exp 까지 살아있다. "왕복이 실제로 일어났다" 를 고정한다.
  {
    fresh();
    const token = await signWith(keyPair.privateKey, baseClaims());
    const user = await verifyAccessTokenLive(token);
    assert("T12l live verifier returns the user", user?.id === SUB, user);
    assert("T12l2 live verifier performs EXACTLY ONE /user round trip", counters.user === 1, counters);
    assert(
      "T12l3 live verifier surfaces created_at (welcome-DM cutoff depends on it)",
      typeof user?.createdAt === "string" && user.createdAt.startsWith("2026-01-02"),
      user,
    );
  }

  // ── T12m: 만료 토큰은 live 경로에서도 네트워크를 태우지 않는다 ───────────
  {
    fresh();
    const expired = await signWith(keyPair.privateKey, baseClaims({ exp: nowSec() - 60 }));
    const user = await verifyAccessTokenLive(expired);
    assert("T12m live verifier rejects an expired token locally", user === null, user);
    assert("T12m2 no round trip for a locally-dead token", counters.user === 0, counters);
  }

  // ── T12n: 죽은 토큰 재시도는 왕복을 반복하지 않는다 (원래 사건의 축) ─────
  // 2026-08-11 저녁 4,402 warnings 는 죽은 토큰이 반복 왕복해서 났다.
  //
  // ⚠️ 이 축은 **live 검증기로** 태워야 관측된다. 로컬 경로는 서명만 보고
  // 끝나서 /user 를 애초에 안 부르므로, 거기에 걸면 dead-token 캐시를 통째로
  // 꺼도 카운터가 0 → 0 이라 변이가 보이지 않는다(관측 불가능한 mutation).
  // 서버가 401 을 돌려주는 상태에서 live 를 반복 호출하는 것이 원사건의
  // 정확한 재현이고, 그때만 "캐시가 반복 왕복을 막았다" 가 증명된다.
  {
    fresh();
    userReturns401 = true;
    const token = await signWith(keyPair.privateKey, baseClaims());
    const first = await verifyAccessTokenLive(token);
    assert("T12n live verifier rejects a server-revoked token", first === null, first);
    const afterFirst = counters.user;
    for (let i = 0; i < 25; i++) await verifyAccessTokenLive(token);
    userReturns401 = false;
    assert(
      "T12n2 first rejection costs exactly one round trip",
      afterFirst === 1,
      afterFirst,
    );
    assert(
      "T12n3 25 further retries of a dead token add ZERO round trips (the 4,402-warning incident)",
      counters.user === 1,
      counters,
    );
  }

  globalThis.fetch = realFetch;

  // 이 게이트가 실제로 서명을 검증했는지 스스로 증명한다 — 키가 같은지 확인.
  const digest = createHash("sha256")
    .update(JSON.stringify({ x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv }))
    .digest("hex")
    .slice(0, 16);
  console.log(`\nES256 test key fingerprint: ${digest} (ephemeral, per-run)`);

  if (failed > 0) {
    console.log(`\n${failed} ES256 end-to-end check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll ES256/JWKS end-to-end checks PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
