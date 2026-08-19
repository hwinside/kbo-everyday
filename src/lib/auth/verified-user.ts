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
  const adminClient = getSupabaseAdmin();
  return verifyAccessTokenWith<VerifiedUser>(async (t) => {
    const { data, error } = await adminClient.auth.getClaims(t);
    const claims = data?.claims;
    // `sub` is the user id. A verified JWT without one is malformed — treat as
    // unauthenticated rather than inventing an identity.
    const sub = typeof claims?.sub === "string" ? claims.sub : "";
    if (error || !sub) {
      return { data: { user: null }, error: error as { status?: number; code?: string } | null };
    }
    const email = typeof claims?.email === "string" ? claims.email : null;
    return { data: { user: { id: sub, email } }, error: null };
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
