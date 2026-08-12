import { createServerClient } from "@supabase/ssr";
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

/** Cookie-session fallback that still goes through the dead-token guard.
 * Reads the session locally (getSession — no /auth/v1/user call), then
 * verifies the access token via verifyAccessToken so an expired/dead cookie
 * session cannot re-trigger the Supabase call the bearer path just blocked. */
export async function getVerifiedUserIdFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() { /* read-only */ },
      },
    },
  );
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return null;
  const user = await verifyAccessToken(token);
  return user?.id ?? null;
}
