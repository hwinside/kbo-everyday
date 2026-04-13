import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase Admin (service role) 싱글톤 클라이언트.
 * API Route에서 `import { supabaseAdmin } from "@/lib/supabase/admin"` 으로 사용.
 * service role key가 없으면 anon key로 fallback.
 */

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _admin;
}

/** 편의 export — 모듈 레벨 싱글톤 */
export const supabaseAdmin = getSupabaseAdmin();
