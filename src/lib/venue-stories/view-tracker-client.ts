"use client";

import { getSafeSession } from "@/lib/supabase/client";
import {
  getOrCreateVenueGuestId,
  sendVenueStoryViewPing,
  venueStorySentKey,
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

/** 이 탭 세션에서 오늘(KST) 이미 전송(성공)한 (kind, story)면 true. */
export function hasTrackedVenueStoryView(storyId: number, kind: VenueStoryViewKind): boolean {
  return sent.has(venueStorySentKey(storyId, kind));
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
  const key = venueStorySentKey(storyId, kind);
  if (sent.has(key)) return;
  sent.add(key);
  try {
    // fire 시점의 세션을 정확히 한 번 읽고 guest UUID와 함께 보낸다. 클라는 user/guest를
    // 자체 확정하지 않으며, 서버 resolveViewerKey 단일 경로가 검증된 user를 우선해 최종 1회 해석한다.
    // 따라서 관찰 시점 authLoading 스냅샷 없이도 게스트→유저 이중 fire가 생기지 않는다.
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
