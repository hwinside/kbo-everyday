"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import {
  dwellStartPage,
  dwellPause,
  dwellResume,
  dwellSetAuth,
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
      dwellSetAuth(null); // logged out → stop sending
      return;
    }
    let active = true;
    // Refresh the cached token on each navigation so flushes during unload can
    // attach it synchronously (a stale/expired token just drops that event).
    supabase.auth.getSession().then(({ data }) => {
      if (active) dwellSetAuth(data.session?.access_token ?? null);
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
