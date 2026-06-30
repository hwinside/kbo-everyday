"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { dwellStartPage, dwellPause, dwellResume } from "@/lib/admin/tracker";

/** Drives accurate per-page active-dwell tracking: starts a new timing window
 * on every route change and pauses/resumes/flushes on tab visibility + unload.
 * Pairs with PageViewTracker (which counts page views); this measures time. */
export function DwellTracker() {
  const pathname = usePathname();
  const { user } = useAuth();

  useEffect(() => {
    dwellStartPage(pathname, user?.id);
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
