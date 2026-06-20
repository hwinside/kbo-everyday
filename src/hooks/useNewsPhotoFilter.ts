"use client";

import { useEffect, useState } from "react";
import { getPhotoFilterEnabled, NEWS_PREF_EVENT } from "@/lib/store/news-pref";

// 사진기사 필터 토글 상태를 reactive하게 읽는다. 마이페이지에서 토글하면
// NEWS_PREF_EVENT로 즉시 반영되고, 다른 탭 변경은 storage 이벤트로 동기화.
export function useNewsPhotoFilter(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const sync = () => setEnabled(getPhotoFilterEnabled());
    sync();
    window.addEventListener(NEWS_PREF_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(NEWS_PREF_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return enabled;
}
