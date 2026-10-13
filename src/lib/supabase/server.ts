import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createAuthRefreshGuard } from "@/lib/auth/refresh-guard";

export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const refresh = createAuthRefreshGuard(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, (...args) => globalThis.fetch(...args), "server",
  );

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: refresh.fetch },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          if (refresh.preserveSessionCookies()) return;
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component에서는 set 불가
          }
        },
      },
    }
  );
}
