"use client";

import { getGuestId } from "@/lib/store/onboarding";
import {
  viewerKeyOf,
  impressionDedupKey,
  shouldCountImpression,
  pickTransport,
} from "./view-tracker-policy";

/**
 * 게시글 조회수 트래킹 (클라 · DOM/스토리지 배선) — 2026-07-21.
 * 순수 판정은 view-tracker-policy.ts. 여기선 sessionStorage/navigator 배선만.
 *
 * dedup 규칙(하린아빠 스펙):
 *  - click: 상세 진입마다 +1 (dedup 없음)
 *  - impression: 카드 세로 ≥50% + 0.5초 dwell 시 +1, 동일 유저 + 세션당 글 1회
 *
 * 서버(/api/posts/[postId]/view)는 순수 증가만. 전송 실패는 best-effort(UX 무영향).
 */

const SEEN_KEY = "***";

/** 현재 유저 식별자 — 로그인 userId 우선, 없으면 게스트 id(localStorage). */
export function currentViewerKey(userId?: string | null): string {
  let guestId: string | null = null;
  try {
    guestId = getGuestId();
  } catch {
    guestId = null;
  }
  return viewerKeyOf(userId, guestId);
}

function seenSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 이 유저가 이 세션에서 아직 이 글 임프레션을 집계 안 했으면 true. */
export function canCountImpression(postId: number, viewerKey: string): boolean {
  return shouldCountImpression(seenSet(), postId, viewerKey);
}

function markImpressionSeen(postId: number, viewerKey: string): void {
  try {
    const s = seenSet();
    s.add(impressionDedupKey(postId, viewerKey));
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* storage 불가 환경 무시 */
  }
}

/** 조회수 카운터 +1 (best-effort). sendBeacon 우선, 큐잉 실패(false)면 fetch 폴백. */
function sendView(postId: number, kind: "click" | "impression"): void {
  const url = `/api/posts/${postId}/view`;
  const body = JSON.stringify({ kind });
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
  // beacon이 없거나 큐잉 실패(false 반환) 시에만 fetch 폴백 — 실패한 전송이 조용히 유실되지 않게.
  if (pickTransport(beaconAvailable, beaconQueued) === "fetch") {
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
}

/** 클릭 조회수 집계 — 상세 진입마다 +1 (dedup 없음, 하린아빠 스펙). */
export function trackPostClick(postId: number): void {
  if (!Number.isInteger(postId) || postId <= 0) return;
  sendView(postId, "click");
}

/**
 * 임프레션 조회수 집계 — 동일 유저 세션당 글 1회만 서버로 전송.
 * 이미 이 세션에서 이 유저가 집계한 글이면 no-op.
 */
export function trackPostImpressionOncePerSession(postId: number, userId?: string | null): void {
  if (!Number.isInteger(postId) || postId <= 0) return;
  const viewerKey = currentViewerKey(userId);
  if (!canCountImpression(postId, viewerKey)) return;
  markImpressionSeen(postId, viewerKey);
  sendView(postId, "impression");
}
