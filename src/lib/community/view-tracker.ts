"use client";

/**
 * 게시글 조회수 트래킹 (클라) — 2026-07-21.
 *
 * - click: 상세 진입마다 +1 (dedup 없음, 스펙)
 * - impression: 피드에서 카드 세로 ≥50% 노출 + 0.5초 dwell 시 +1, 세션당 글 1회
 *
 * 서버(/api/posts/[postId]/view)는 순수 증가만. 세션 dedup은 여기(sessionStorage).
 * 전송 실패는 조용히 무시(best-effort 텔레메트리 — UX를 막지 않음).
 */

const IMPRESSION_SEEN_KEY = "kbo-post-impressions-seen";

function seenSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(IMPRESSION_SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 이 세션에서 이미 임프레션 집계된 글인지. */
export function hasSeenImpression(postId: number): boolean {
  return seenSet().has(String(postId));
}

/** 세션 임프레션 집계 마킹. */
export function markImpressionSeen(postId: number): void {
  try {
    const s = seenSet();
    s.add(String(postId));
    sessionStorage.setItem(IMPRESSION_SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* storage 불가 환경 무시 */
  }
}

/** 조회수 카운터 +1 (best-effort). 페이지 이동 중에도 유실 없게 sendBeacon 우선. */
export function trackPostView(postId: number, kind: "click" | "impression"): void {
  if (!Number.isInteger(postId) || postId <= 0) return;
  const url = `/api/posts/${postId}/view`;
  const body = JSON.stringify({ kind });
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
  } catch {
    /* sendBeacon 실패 → fetch 폴백 */
  }
  try {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 무시 */
  }
}
