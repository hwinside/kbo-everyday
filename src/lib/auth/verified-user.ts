import { createClient, type User } from "@supabase/supabase-js";

function getBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export async function getVerifiedUserFromRequest(request: Request): Promise<{ user: User; token: string } | null> {
  const token = getBearerToken(request);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!token || !serviceKey) return null;

  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
  );

  const {
    data: { user },
    error,
  } = await adminClient.auth.getUser(token);

  if (error || !user) return null;

  return { user, token };
}
