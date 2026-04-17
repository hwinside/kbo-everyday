"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase/client";

/**
 * URL hash fragment에서 세션 토큰을 복원하는 컴포넌트.
 * OAuth callback이 쿠키를 제대로 전달하지 못할 때의 fallback.
 * hash는 서버로 전송되지 않으므로 보안상 안전.
 */
export default function HashSessionRestore() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || !hash.includes("access_token")) return;

    const params = new URLSearchParams(hash.slice(1));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (accessToken && refreshToken) {
      supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      }).then(() => {
        // hash 정리 (URL에 토큰 노출 방지)
        window.history.replaceState(null, "", window.location.pathname);
      });
    }
  }, []);

  return null;
}
