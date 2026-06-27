"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";

const KEY = "kbo-login-redirect";

/**
 * 로그인 의도 경로 복원 — OAuth web 로그인은 /auth/callback을 거쳐 홈으로 떨어지므로,
 * 로그인 직전 페이지(예: /tester-signup)에서 localStorage[KEY]에 복귀 경로를 저장해두면
 * 로그인 완료(세션 확립) 후 그 경로로 자동 복귀시킨다. 키가 없으면 아무 동작 안 함(no-op).
 */
export default function PostLoginRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading || !user) return;
    let target: string | null = null;
    try {
      target = localStorage.getItem(KEY);
    } catch {
      return;
    }
    if (!target) return;
    // 신규 가입 setup 플로우는 방해하지 않음 — setup 완료 후 홈 복귀 시 다시 처리됨.
    if (window.location.pathname.startsWith("/setup")) return;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    // 안전한 내부 경로만 허용 (오픈 리다이렉트 방지).
    if (target.startsWith("/") && !target.startsWith("//") && window.location.pathname !== target) {
      router.replace(target);
    }
  }, [user, loading, router]);

  return null;
}
