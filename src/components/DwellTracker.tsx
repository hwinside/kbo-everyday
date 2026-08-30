"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import {
  dwellStartPage,
  dwellPause,
  dwellResume,
  dwellSetIdentity,
} from "@/lib/admin/tracker";

/** Drives accurate per-page active-dwell tracking for *logged-in* users (same
 * population as page-view tracking). Starts a new timing window on each route
 * change, refreshes the auth token, and pauses/resumes/flushes on tab
 * visibility + unload. The token is sent so the server derives user_id from the
 * verified JWT (client-claimed ids are never trusted). */
export function DwellTracker() {
  const pathname = usePathname();
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) {
      dwellSetIdentity(null, null); // logged out → stop sending, drop queue
      return;
    }
    let active = true;
    // Refresh the cached identity on each navigation so flushes during unload
    // can attach it synchronously (a stale/expired token just drops that event).
    // 삼순 P1(#1323): 세션 uid와 React 컨텍스트 uid를 대조 — 전환 레이스로 둘이
    // 어긋나면 fail-closed(null)로 떨구서 이전 계정 체류가 새 계정 토큰으로
    // 전송되는 경로를 원천 차단한다.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const sessUid = data.session?.user?.id ?? null;
      const token = data.session?.access_token ?? null;
      if (sessUid && token && sessUid === user.id) {
        dwellSetIdentity(sessUid, token);
      } else {
        dwellSetIdentity(null, null);
      }
    });
    dwellStartPage(pathname);
    return () => {
      active = false;
    };
  }, [pathname, user?.id]);

  useEffect(() => {
    const onVisibility = () => (document.hidden ? dwellPause() : dwellResume());
    const onPageHide = () => dwellPause();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      dwellPause(); // flush on unmount
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
