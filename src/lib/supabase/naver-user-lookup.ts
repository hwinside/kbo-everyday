import type { User } from "@supabase/supabase-js";

type LookupError = { message: string } | null;

interface NaverUserLookupClient {
  rpc(
    name: "lookup_auth_user_id_by_email",
    params: { p_email: string }
  ): PromiseLike<{ data: string | null; error: LookupError }>;
  auth: {
    admin: {
      getUserById(
        userId: string
      ): Promise<{ data: { user: User | null }; error: LookupError }>;
    };
  };
}

/**
 * auth.users의 이메일 인덱스로 기존 사용자를 단건 조회한다.
 * 전체 사용자 목록을 페이지 순회하지 않아 사용자 수가 늘어도 누락되지 않는다.
 */
export async function lookupAuthUserByEmail(
  supabaseAdmin: NaverUserLookupClient,
  email: string
): Promise<User | undefined> {
  const normalizedEmail = email.trim().toLowerCase();
  // query-guard: bounded -- RPC returns at most one auth.users UUID for one normalized email
  const { data: userId, error: lookupError } = await supabaseAdmin.rpc(
    "lookup_auth_user_id_by_email",
    { p_email: normalizedEmail }
  );

  if (lookupError) {
    throw new Error(`auth user lookup failed: ${lookupError.message}`);
  }
  if (!userId) return undefined;

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) {
    throw new Error(`auth user fetch failed: ${error.message}`);
  }
  if (!data.user) {
    throw new Error("auth user fetch failed: user body missing");
  }
  return data.user;
}
