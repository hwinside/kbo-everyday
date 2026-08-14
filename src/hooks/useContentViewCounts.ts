"use client";

import { useEffect, useMemo, useState } from "react";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { fetchContentViewCounts } from "@/lib/content-views/tracker";
import type { ContentViewType } from "@/lib/content-views/policy";

/**
 * 관리자 배지용 콘텐츠 조회수 배치 로드.
 * 관리자가 아니면 네트워크 요청 자체를 하지 않는다(전 유저 트래픽 증가 방지).
 * 키는 `${type}:${id}` (policy.contentViewKey와 동일 형식).
 */
export function useContentViewCounts(
  items: { type: ContentViewType; id: string }[],
): Record<string, number> {
  const isAdmin = useIsAdmin();
  const [counts, setCounts] = useState<Record<string, number>>({});

  // 얕은 내용 기준 재조회 키 — 렌더마다 새 배열이어도 내용이 같으면 재요청 안 함.
  const itemsKey = useMemo(
    () => items.map((item) => `${item.type}:${item.id}`).join("\n"),
    [items],
  );

  useEffect(() => {
    if (!isAdmin || items.length === 0) return;
    let cancelled = false;
    void fetchContentViewCounts(items).then((result) => {
      if (!cancelled) setCounts(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, itemsKey]);

  return counts;
}
