"use client";

import { getSafeSession } from "@/lib/supabase/client";
import {
  getOrCreateVenueGuestId,
  sendVenueStoryViewPing,
  type VenueStoryViewKind,
} from "./view-tracking";

/**
 * 직관 스토리 조회수 클라 배선(#735 community/view-tracker 패턴) — 순수 판정은 view-tracking.ts.
 * - 뷰어 열람 = click, 트레이 실제 노출 = impression (A안 원문 2종 분리 집계).
 * - 탭 세션 내 같은 (kind, story) 중복 fire 는 여기서 방지, 스토리×뷰어×kind×KST일 dedupe 는
 *   서버 RPC 가 원자 보장 — 재시도가 과집계를 만들지 않는다.
 * - guest 식별자는 직관 스토리 전용 localStorage 영속 UUID를 유지한다.
 *   viewer_key 해석(user 우선)은 서버가 수행: 토큰은 body 로 전달(sendBeacon 은 헤더 불가).
 */
const sent = new Set<string>();

function sentKey(storyId: number, kind: VenueStoryViewKind): string {
  return `${kind}:${storyId}`;
}

/** 이 탭 세션에서 이미 전송(성공)한 (kind, story)면 true — 트래킹 호출 전 skip 용. */
export function hasTrackedVenueStoryView(storyId: number, kind: VenueStoryViewKind): boolean {
  return sent.has(sentKey(storyId, kind));
}

/**
 * 조회 1건 트래킹 (best-effort, UX 무영향). 전송 실패(폴백 fetch 비정상 응답 — 서버는 RPC
 * 실패를 5xx 로 반환) 시 mark 해제해 다음 표시/노출 때 재시도한다.
 */
export async function trackVenueStoryView(
  storyId: number,
  kind: VenueStoryViewKind,
): Promise<void> {
  if (!Number.isInteger(storyId) || storyId <= 0) return;
  const key = sentKey(storyId, kind);
  if (sent.has(key)) return;
  sent.add(key);
  try {
    // getSafeSession 은 로컬 세션 읽기라 즉시 settle — 이탈 직전에도 beacon 큐잉까지 도달 가능.
    const session = await getSafeSession();
    const guestId = getOrCreateVenueGuestId(
      typeof window === "undefined" ? null : window.localStorage,
      () => crypto.randomUUID(),
    );
    const ok = await sendVenueStoryViewPing({
      url: `/api/venue-stories/${storyId}/view`,
      payload: { kind, guestId, accessToken: session?.access_token ?? null },
      sendBeacon:
        typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
          ? navigator.sendBeacon.bind(navigator)
          : undefined,
      fetchFn: fetch,
    });
    if (!ok) sent.delete(key);
  } catch {
    sent.delete(key);
  }
}
