"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import {
  dwellStartPage,
  dwellPause,
  dwellResume,
  dwellExpectIdentity,
  dwellAttachToken,
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
    // 삼순 P1 2차(#1323): 페이지 타이밍 시작 *전에* 동기 fence — getSession
    // promise가 아직 안 돌아온 창에서 pagehide/route change가 나도 이전 계정
    // 토큰·큐는 이미 폐기된 상태라 B 체류가 A 토큰으로 flush될 수 없다.
    dwellExpectIdentity(user?.id ?? null);
    if (!user?.id) return; // logged out → fence가 큐·토큰 이미 폐기
    let active = true;
    // 토큰은 검증된 세션 uid가 React 컨텍스트 uid와 일치할 때만 attach한다.
    // 불일치(전환 레이스)는 fail-closed — fence(null)로 떨구고 다음 effect가
    // 정합 상태에서 재시작한다. 지연 중 쌓인 B 이벤트는 B uid에 결속된 채
    // 대기하다 attach 후에만 전송된다.
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const sessUid = data.session?.user?.id ?? null;
      const token = data.session?.access_token ?? null;
      if (sessUid && token && sessUid === user.id) {
        dwellAttachToken(sessUid, token);
      } else {
        dwellExpectIdentity(null);
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
