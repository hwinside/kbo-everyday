"use client";

import { useState, useCallback } from "react";

export function useBadgeCheck() {
  const [newBadges, setNewBadges] = useState<string[]>([]);

  const checkBadges = useCallback(async (userId: string) => {
    try {
      const res = await fetch("/api/badges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (data.newBadges?.length > 0) {
        setNewBadges(data.newBadges);
        // 5초 후 자동 닫기
        setTimeout(() => setNewBadges([]), 5000);
      }
    } catch (e) {
      // silent fail
    }
  }, []);

  const clearBadges = useCallback(() => setNewBadges([]), []);

  return { newBadges, checkBadges, clearBadges };
}
