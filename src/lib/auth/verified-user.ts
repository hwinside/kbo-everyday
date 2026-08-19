import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessTokenWith } from "@/lib/auth/token-precheck";

/** The identity fields API routes are allowed to read off a verified token.
 *
 * Deliberately NARROW (not supabase `User`): the local-claims path below can
 * only supply what the JWT itself carries. Typing the return as the full
 * `User` would let a route read e.g. `user.created_at` — a field that is
 * present on the server-verified path and silently `undefined` on the local
 * path. Narrowing makes tsc, not a reviewer, prove no such read exists.
 * Adding a field here requires checking the JWT actually carries it. */
export interface VerifiedUser {
  id: string;
  email: string | null;
}

/** Identity fields that ONLY the server-authoritative path can supply, because
 * they live on the auth user row rather than in the JWT. Separate type so a
 * route needing one of these cannot compile against the local-claims path. */
export interface LiveVerifiedUser extends VerifiedUser {
  /** auth.users.created_at (ISO). Not a JWT claim. */
  createdAt: string | null;
}

function getBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

/** Expected `iss` for this project's access tokens: `<project url>/auth/v1`. */
export function expectedIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

/**
 * Turn verified JWT claims into a principal, or null.
 *
 * `getClaims()` proves the token was signed by a key in the project JWKS and
 * is unexpired — it does NOT assert the token is an end-user access token for
 * THIS project's authenticated role. Those are separate claims, and they are
 * what an attacker would vary. So every one of them is checked fail-close:
 *
 *  - `iss`      must be this project's auth issuer. Rejects a validly-signed
 *               token minted by a different Supabase project.
 *  - `aud`      must contain `authenticated` (spec allows string or array).
 *  - `role`     must be exactly `authenticated`. Notably rejects
 *               `service_role`, which would otherwise be accepted as a user
 *               and hand an admin-privileged token a normal user's identity.
 *  - `sub`      must be a non-empty string — it becomes the user id.
 *  - `session_id` must be present. A token with no session cannot be tied to
 *               a real sign-in.
 *
 * Pure and exported so the gate can feed it forged claim sets directly
 * (삼순 필수②) without needing a signing key.
 */
export function principalFromClaims(
  claims: unknown,
  expectedIss: string,
): VerifiedUser | null {
  if (!claims || typeof claims !== "object") return null;
  const c = claims as Record<string, unknown>;

  if (typeof c.iss !== "string" || c.iss !== expectedIss) return null;

  const aud = c.aud;
  const audOk =
    aud === "authenticated" ||
    (Array.isArray(aud) && aud.includes("authenticated"));
  if (!audOk) return null;

  if (c.role !== "authenticated") return null;

  const sub = typeof c.sub === "string" ? c.sub.trim() : "";
  if (!sub) return null;

  const sessionId = typeof c.session_id === "string" ? c.session_id.trim() : "";
  if (!sessionId) return null;

  const email = typeof c.email === "string" && c.email ? c.email : null;
  return { id: sub, email };
}

/** Verify a Supabase access token, with local precheck and dead-token caching
 * (see token-precheck.ts for why).
 *
 * Verification goes through `auth.getClaims()`, which verifies the JWT
 * signature LOCALLY against the project's JWKS when the signing key is
 * asymmetric (this project: ES256 `in_use`, HS256 only `previously_used`).
 * That removes one GoTrue `/auth/v1/user` round trip per authenticated API
 * request — the observed load was `/user` = 94.8% of all Auth traffic, called
 * from Vercel server-side, because this helper backs 23 API routes.
 *
 * auth-js falls back to a server `getUser()` call by itself when the token is
 * HS256-signed, has no `kid`, or WebCrypto is unavailable — so a signing-key
 * rollback degrades to the old behaviour instead of failing open.
 *
 * ⚠️ TRADE-OFF — revocation latency. Local verification proves the token was
 * issued by this project and is unexpired; it CANNOT see that the session was
 * signed out, or the user deleted/banned, after issuance. Such a token stays
 * accepted until it expires (`jwt_exp` = 3600s). The server path had no such
 * lag. This is accepted here because every caller is an ordinary
 * user-scoped route; anything that must observe revocation immediately must
 * call {@link verifyAccessTokenLive} instead. */
export async function verifyAccessToken(token: string): Promise<VerifiedUser | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // No project URL means no issuer to check against — refuse rather than
  // verifying with the issuer check silently disabled.
  if (!supabaseUrl) return null;
  const expectedIss = expectedIssuer(supabaseUrl);
  const adminClient = getSupabaseAdmin();
  return verifyAccessTokenWith<VerifiedUser>(async (t) => {
    const { data, error } = await adminClient.auth.getClaims(t);
    if (error) {
      return { data: { user: null }, error: error as { status?: number; code?: string } | null };
    }
    // Signature/exp are verified above; the claim SHAPE is verified here.
    const user = principalFromClaims(data?.claims, expectedIss);
    if (!user) {
      // A validly-signed token that fails the claim contract is not a
      // transient failure — it can never become valid, so report it with a
      // dead-token code so the negative cache short-circuits repeats.
      return { data: { user: null }, error: { code: "bad_jwt" } };
    }
    return { data: { user }, error: null };
  }, token);
}

/** Server-authoritative verification — one GoTrue round trip, sees sign-out /
 * deletion / ban immediately. Use ONLY where that immediacy is required;
 * `verifyAccessToken` is the default because this path is what saturated CPU. */
export async function verifyAccessTokenLive(token: string): Promise<LiveVerifiedUser | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const adminClient = getSupabaseAdmin();
  return verifyAccessTokenWith<LiveVerifiedUser>(async (t) => {
    const { data, error } = await adminClient.auth.getUser(t);
    if (error || !data.user) return { data: { user: null }, error };
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          createdAt: data.user.created_at ?? null,
        },
      },
      error: null,
    };
  }, token);
}

export async function getVerifiedUserFromRequest(request: Request): Promise<{ user: VerifiedUser; token: string } | null> {
  const token = getBearerToken(request);
  if (!token) return null;

  const user = await verifyAccessToken(token);
  if (!user) return null;

  return { user, token };
}

/**
 * Confirm an email-based PRIVILEGE decision against the Auth server.
 *
 * Background (삼순 필수③ — "admin/email 우회 같은 고위험 mutation 은 원격 검증 유지
 * 여부를 분리 설계"). Ordinary routes only need `sub`, which is immutable, so
 * local claim verification is fine. A few routes instead branch on `email`
 * against an allowlist, and email is MUTABLE server state — the claim holds
 * the value at token issuance, which can be up to `jwt_exp` (3600s) stale.
 * Privilege should be decided on current state.
 *
 * Cost is kept at zero for normal traffic by checking the (signed, unforgeable)
 * claim first: if the claim email is not an allowlist candidate, the answer is
 * already false and no round trip happens. Only a candidate pays one call, and
 * only to confirm the address still holds. So this cannot reintroduce the
 * `/user` volume that saturated CPU — the callers are admin-only/QA paths.
 *
 * @param claimEmail email from the locally-verified claims
 * @param token      the caller's access token
 * @param predicate  allowlist test (isAdminEmail / canBypassVenueGeofenceForQa)
 */
export async function confirmEmailPrivilege(
  claimEmail: string | null,
  token: string,
  predicate: (email?: string | null) => boolean,
): Promise<boolean> {
  // Fast path: not a candidate by the signed claim → definitively not privileged.
  if (!predicate(claimEmail)) return false;
  // Candidate → confirm the address against the Auth server (fail-close).
  const live = await verifyAccessTokenLive(token);
  return !!live && predicate(live.email);
}

/** Extract the Supabase access token from `sb-<ref>-auth-token` cookies by
 * parsing the cookie payload DIRECTLY — deliberately no supabase-js client.
 *
 * Why not the supabase-js server client's get-session call: auth-js proactively
 * refreshes sessions nearing expiry (POST /auth/v1/token), and with a no-op
 * `setAll()` the refreshed cookie is never persisted → every request would
 * re-refresh (삼순 2차 리뷰 지적). Reading the cookie bytes ourselves is
 * guaranteed zero-network; verification then goes through the same
 * dead-token guard as the bearer path.
 *
 * Handles both storage layouts of @supabase/ssr:
 *  - single cookie `sb-<ref>-auth-token`
 *  - chunked `sb-<ref>-auth-token.0`, `.1`, … (joined in index order)
 * and both encodings (plain JSON or `base64-` + base64url JSON). */
export function extractAccessTokenFromCookies(
  all: Array<{ name: string; value: string }>,
): string | null {
  const AUTH_RE = /^sb-[a-z0-9-]+-auth-token(?:\.(\d+))?$/;
  const chunks: Array<{ index: number; value: string }> = [];
  for (const c of all) {
    const m = AUTH_RE.exec(c.name);
    if (!m) continue;
    chunks.push({ index: m[1] !== undefined ? Number(m[1]) : 0, value: c.value });
  }
  if (chunks.length === 0) return null;
  chunks.sort((a, b) => a.index - b.index);
  let raw = chunks.map((c) => c.value).join("");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // not URI-encoded — use as-is
  }
  if (raw.startsWith("base64-")) {
    try {
      raw = Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown };
    return typeof parsed.access_token === "string" && parsed.access_token ? parsed.access_token : null;
  } catch {
    return null;
  }
}

/** Cookie-session fallback that still goes through the dead-token guard.
 * Reads the access token straight out of the auth cookie (zero network —
 * see extractAccessTokenFromCookies), then verifies via verifyAccessToken so
 * an expired/dead cookie session cannot re-trigger the Supabase call the
 * bearer path just blocked. */
export async function getVerifiedUserIdFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = extractAccessTokenFromCookies(cookieStore.getAll());
  if (!token) return null;
  const user = await verifyAccessToken(token);
  return user?.id ?? null;
}
