import type { User } from "@supabase/supabase-js";
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
