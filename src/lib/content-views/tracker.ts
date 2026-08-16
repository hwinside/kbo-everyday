"use client";

import { pickTransport } from "@/lib/community/view-tracker-policy";
import {
  contentViewKey,
  isValidContentId,
  newsContentId,
  shouldCountShortsView,
  SHORTS_RECOUNT_WINDOW_MS,
  type ContentViewType,
} from "./policy";

/**
 * 콘텐츠 조회수(숏츠·뉴스) 트래킹 — 클라 배선(sessionStorage/navigator). 2026-08-14.
 * 순수 판정은 policy.ts. 서버(/api/content-views/view)는 순수 증가만.
 * 전송 실패는 best-effort(UX 무영향) — 게시글 view-tracker와 동일 계약.
 */

// key(`shorts:<id>`) → 마지막 집계 시각(ms). 재조회 창 판정용. v2 = 타임스탬맵 포맷.
const SEEN_KEY = "kbo_content_views_seen_v2";

function seenMap(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

function markSeen(key: string, atMs: number): void {
  try {
    const m = seenMap();
    m[key] = atMs;
    // 창 밖(오래된) 항목 정리 — 어차피 재카운트 대상이라 제거해도 동작 동일, 메모리만 절약.
    const cutoff = atMs - SHORTS_RECOUNT_WINDOW_MS;
    for (const k of Object.keys(m)) {
      if (m[k] < cutoff) delete m[k];
    }
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(m));
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

/**
 * 숏츠 조회 +1 — 내리면서 본 영상 하나하나 카운트(재조회 포함).
 * 동일 영상은 SHORTS_RECOUNT_WINDOW_MS 창 안 중복만 차단(순간 왕복 스팸 방지).
 */
export function trackShortsView(videoId: string, viewToken?: string | null): void {
  if (!viewToken) return; // 서명 없는 항목은 전송 안 함 — 임의 id 증가 차단(삼순 blocker3)
  const key = contentViewKey("shorts", videoId);
  const now = Date.now();
  if (!shouldCountShortsView(seenMap()[key], now, videoId)) return;
  markSeen(key, now);
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
