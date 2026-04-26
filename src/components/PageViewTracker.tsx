"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/supabase/AuthContext";
import { trackPageView } from "@/lib/admin/tracker";

export function PageViewTracker() {
  const pathname = usePathname();
  const { user } = useAuth();
  const prev = useRef<string | null>(null);

  useEffect(() => {
    if (pathname === prev.current) return;
    prev.current = pathname;
    trackPageView(user?.id);
  }, [pathname, user?.id]);

  return null;
}
