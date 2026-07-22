"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import { isAdminEmail } from "@/lib/admin/admin-users";

/**
 * 현재 로그인 유저가 관리자(ADMIN_EMAILS)인지 — 클라 표시 게이트용.
 *
 * "관리자만 볼 수 있는 UI"의 진입점. 조회수 배지, WIP 기능(직관 스토리 등)을
 * prod 배포하되 관리자에게만 노출해 실환경 QA 하는 데 쓴다.
 */
export function useIsAdmin(): boolean {
  const { user } = useAuth();
  return isAdminEmail(user?.email);
}
