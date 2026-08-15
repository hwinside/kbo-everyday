"use client";

import { pickTransport } from "@/lib/community/view-tracker-policy";
import {
  contentViewKey,
  isValidContentId,
  newsContentId,
  shouldCountShortsView,
  type ContentViewType,
} from "./policy";

/**
 * 콘텐츠 조회수(숏츠·뉴스) 트래킹 — 클라 배선(sessionStorage/navigator). 2026-08-14.
 * 순수 판정은 policy.ts. 서버(/api/content-views/view)는 순수 증가만.
 * 전송 실패는 best-effort(UX 무영향) — 게시글 view-tracker와 동일 계약.
 */

const SEEN_KEY = "kbo_content_views_seen_v1";

function seenSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function markSeen(key: string): void {
  try {
    const s = seenSet();
    s.add(key);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* storage 불가 환경 무시 */
  }
}

/** 카운터 +1 (best-effort). sendBeacon 우선, 큐잉 실패 시 fetch 폴백. */
function sendView(type: ContentViewType, id: string, viewToken: string): void {
  const url = "/api/content-views/view";
  const body = JSON.stringify({ type, id, token: viewToken });
  const beaconAvailable =
    typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function";
  let beaconQueued = false;
  if (beaconAvailable) {
    try {
      beaconQueued = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } catch {
      beaconQueued = false;
    }
  }
  if (pickTransport(beaconAvailable, beaconQueued) === "fetch") {
    try {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
}

/** 숏츠 조회 +1 — 동일 세션당 영상 1회 dedup. */
export function trackShortsView(videoId: string, viewToken?: string | null): void {
  if (!viewToken) return; // 서명 없는 항목은 전송 안 함 — 임의 id 증가 차단(삼순 blocker3)
  if (!shouldCountShortsView(seenSet(), videoId)) return;
  markSeen(contentViewKey("shorts", videoId));
  sendView("shorts", videoId, viewToken);
}

/** 뉴스 원문 열기 +1 — click 축이라 dedup 없음. */
export function trackNewsView(
  url: string,
  canonicalUrl?: string | null,
  viewToken?: string | null,
): void {
  if (!viewToken) return; // 서명 없는 표면(DM 클리핑 등)은 전송 안 함 — best-effort
  const id = newsContentId(url, canonicalUrl);
  if (!isValidContentId(id)) return;
  sendView("news", id, viewToken);
}

/** 관리자 배지용 배치 count 조회. 실패 시 빈 맵(배지 미표시). */
export async function fetchContentViewCounts(
  items: { type: ContentViewType; id: string }[],
): Promise<Record<string, number>> {
  const valid = items.filter((item) => isValidContentId(item.id));
  if (valid.length === 0) return {};
  try {
    // 서버가 로그인+ADMIN_EMAILS를 검증하므로(삼순 blocker2) 세션 토큰을 Bearer로 동봉.
    const { supabase } = await import("@/lib/supabase/client");
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return {};
    const response = await fetch("/api/content-views/counts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ items: valid }),
    });
    if (!response.ok) return {};
    const result = (await response.json()) as { counts?: Record<string, number> };
    return result.counts ?? {};
  } catch {
    return {};
  }
}
