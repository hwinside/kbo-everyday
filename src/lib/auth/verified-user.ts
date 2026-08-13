import type { User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { verifyAccessTokenWith } from "@/lib/auth/token-precheck";

function getBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

/** Verify a Supabase access token against Auth, with local precheck and
 * dead-token caching (see token-precheck.ts for why). Returns the user or
 * null. Drop-in replacement for direct `adminClient.auth.getUser(token)`
 * calls in API routes. */
export async function verifyAccessToken(token: string): Promise<User | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const adminClient = getSupabaseAdmin();
  return verifyAccessTokenWith((t) => adminClient.auth.getUser(t), token);
}

export async function getVerifiedUserFromRequest(request: Request): Promise<{ user: User; token: string } | null> {
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
