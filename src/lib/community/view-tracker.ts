"use client";

import { getGuestId } from "@/lib/store/onboarding";

/**
 * 게시글 조회수 트래킹 (클라) — 2026-07-21.
 *
 * dedup 규칙(하린아빠 스펙): click·impression 모두 **동일 유저 + 세션당 글 1회**.
 *  - click: 상세 진입 시 집계(세션 내 재진입은 미집계)
 *  - impression: 피드에서 카드 세로 ≥50% + 0.5초 dwell 시 집계
 *  - "동일 유저" = 로그인 유저는 userId, 비로그인은 guestId(localStorage). 같은 세션에서
 *    계정을 바꾸면 각 유저가 1회씩 집계된다.
 *
 * 서버(/api/posts/[postId]/view)는 순수 증가만. 세션 dedup은 여기(sessionStorage).
 * 전송 실패는 조용히 무시(best-effort 텔레메트리 — UX를 막지 않음).
 */

const SEEN_KEY = "kbo-po…seen";

/** 현재 유저 식별자 — 로그인 userId 우선, 없으면 게스트 id. */
export function currentViewerKey(userId?: string | null): string {
  if (userId) return `u:${userId}`;
  try {
    return `g:${getGuestId()}`;
  } catch {
    return "g:anon";
  }
}

function dedupKey(postId: number, kind: "click" | "impression", viewerKey: string): string {
  return `${kind}:${postId}:${viewerKey}`;
}

function seenSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** 이 세션에서 이 유저가 이미 (kind) 집계된 글인지. */
export function hasSeenView(postId: number, kind: "click" | "impression", viewerKey: string): boolean {
  return seenSet().has(dedupKey(postId, kind, viewerKey));
}

/** 세션 집계 마킹. */
export function markViewSeen(postId: number, kind: "click" | "impression", viewerKey: string): void {
  try {
    const s = seenSet();
    s.add(dedupKey(postId, kind, viewerKey));
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* storage 불가 환경 무시 */
  }
}

/** 조회수 카운터 +1 (best-effort). 페이지 이동 중에도 유실 없게 sendBeacon 우선. */
function sendView(postId: number, kind: "click" | "impression"): void {
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

/**
 * 조회수 집계 — 동일 유저 세션당 글 1회만 서버로 전송.
 * 이미 이 세션에서 이 유저가 집계한 글이면 no-op.
 */
export function trackPostViewOncePerSession(
  postId: number,
  kind: "click" | "impression",
  userId?: string | null,
): void {
  if (!Number.isInteger(postId) || postId <= 0) return;
  const viewerKey = currentViewerKey(userId);
  if (hasSeenView(postId, kind, viewerKey)) return;
  markViewSeen(postId, kind, viewerKey);
  sendView(postId, kind);
}
