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

// 페이지 이탈 감지 — sendBeacon 은 응답을 확인할 수 없으므로(큐잉 ≠ 서버 저장 성공)
// 이탈 직전 최후 fallback 에만 허용한다. pageshow 는 bfcache 복원 대응.
let pageHiding = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageHiding = true;
  });
  window.addEventListener("pageshow", () => {
    pageHiding = false;
  });
}

function isPageUnloading(): boolean {
  return (
    pageHiding || (typeof document !== "undefined" && document.visibilityState === "hidden")
  );
}

/**
 * 조회 1건 트래킹 (best-effort, UX 무영향). mark 는 동시 중복 fire 방지용 in-flight
 * 가드로 선점만 하고, **서버 2xx(204) 확인 실패 시 즉시 해제**해 미확정으로 되돌린다
 * (서버는 RPC 실패를 5xx 로 반환) — 다음 표시/노출 때 재전송되며, 서버 KST 일별
 * dedupe 가 권위라 재시도가 이중 집계를 만들지 않는다 (삼순 정정 리뷰 #962).
 */
export async function trackVenueStoryView(
  storyId: number,
  kind: VenueStoryViewKind,
): Promise<boolean> {
  if (!Number.isInteger(storyId) || storyId <= 0) return false;
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
    if (!viewerKey) return false;

    key = venueStorySentKey(storyId, kind, viewerKey);
    if (sent.has(key)) return true;
    sent.add(key);

    const ok = await sendVenueStoryViewPing({
      url: `/api/venue-stories/${storyId}/view`,
      payload: { kind, guestId, accessToken: session?.access_token ?? null },
      // 이탈 직전에만 beacon fallback 허용 — 일반 경로는 응답 확인 가능한 fetch(keepalive).
      unloading: isPageUnloading(),
      sendBeacon:
        typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
          ? navigator.sendBeacon.bind(navigator)
          : undefined,
      // ⚠️ fetch 는 반드시 바인딩해서 넘긴다. `fetchFn: fetch` 를 그대로 넘기면
      // sendVenueStoryViewPing 안에서 `opts.fetchFn(...)` 로 호출될 때 this=opts 가 되어
      // Chromium "Illegal invocation" / WebKit "Can only call Window.fetch on instances of
      // Window" TypeError 가 동기 발생 → 모든 조회 ping 이 조용히 유실된다
      // (#963 keepalive-first 전환에서 실제로 터진 프로덕션 결함, 2026-08-12).
      fetchFn: fetch.bind(globalThis),
    });
    if (!ok) sent.delete(key);
    return ok;
  } catch {
    if (key) sent.delete(key);
    return false;
  }
}
