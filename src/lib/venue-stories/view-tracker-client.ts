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
 * - 탭 세션 내 같은 (viewer, kind, story, KST일) 중복 fire 는 여기서 방지하고, 같은 키의
 *   서버 dedupe 는 RPC 가 원자 보장한다 — 재시도가 과집계를 만들지 않는다.
 * - guest 식별자는 직관 스토리 전용 localStorage 영속 UUID를 유지한다.
 *   viewer_key 해석(user 우선)은 서버가 수행: 토큰은 body 로 전달(sendBeacon 은 헤더 불가).
 */
const sent = new Set<string>();

/**
 * 조회 1건 트래킹 (best-effort, UX 무영향). 전송 실패(폴백 fetch 비정상 응답 — 서버는 RPC
 * 실패를 5xx 로 반환) 시 mark 해제해 다음 표시/노출 때 재시도한다.
 */
export async function trackVenueStoryView(
  storyId: number,
  kind: VenueStoryViewKind,
): Promise<void> {
  if (!Number.isInteger(storyId) || storyId <= 0) return;
  let key: string | null = null;
  try {
    // fire 시점 세션을 먼저 해석한 뒤 viewer까지 포함한 키로 mark한다. 같은 탭에서
    // guest→login 또는 계정 전환이 일어나도 새 viewer의 정상 조회를 막지 않는다.
    const session = await getSafeSession();
    const guestId = getOrCreateVenueGuestId(
      typeof window === "undefined" ? null : window.localStorage,
      () => crypto.randomUUID(),
    );
    const viewerKey = session?.user?.id
      ? `user:${session.user.id}`
      : guestId
        ? `guest:${guestId}`
        : null;
    if (!viewerKey) return;

    key = venueStorySentKey(storyId, kind, viewerKey);
    if (sent.has(key)) return;
    sent.add(key);

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
    if (key) sent.delete(key);
  }
}
