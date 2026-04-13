import type { User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function getBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export async function getVerifiedUserFromRequest(request: Request): Promise<{ user: User; token: string } | null> {
  const token = getBearerToken(request);
  if (!token || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const adminClient = getSupabaseAdmin();

  const {
    data: { user },
    error,
  } = await adminClient.auth.getUser(token);

  if (error || !user) return null;

  return { user, token };
}
