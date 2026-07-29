// 직관 스토리 조회수 트래킹 — 순수 헬퍼 (클라 1초 노출 게이트 + 게스트 식별자 + 전송 + 관리자 노출).
// 클라(VenueStoryViewer)와 서버(view API·목록 API)가 같은 규약을 쓰도록 한 파일에 모은다.
// 전부 주입형/순수 함수 — scripts/qa/venue-story-view-client-smoke.ts 가 동일 코드를 회귀로 고정한다.

import type { VenueStory } from "./types";

/** 노출 게이트: 스토리가 뷰어에 이만큼 연속 표시됐을 때만 조회 1회로 인정(삼순 게이트 ①). */
export const VENUE_STORY_VIEW_GATE_MS = 1_000;

/**
 * 게스트 식별자 localStorage 키(삼순 게이트 ③).
 * 주의: 로그아웃/계정 전환 정리(AuthContext)는 명시 키 목록(kbo-my-team 등)만 지우고
 * localStorage.clear() 를 쓰지 않는다 — 이 키는 로그아웃에도 살아남아 dedupe 가 유지된다(확인 2026-07-29).
 */
export const VENUE_STORY_GUEST_ID_KEY = "vsv_guest_id";

/** guest id 는 UUID 형식만 인정 — 서버가 임의 문자열로 cardinality 폭주하는 것을 막는다. */
export const VENUE_GUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 1초 노출 게이트. 표시 시작 시 호출하고, 반환된 cancel 을 스토리 전환/뷰어 종료 cleanup 에서
 * 호출하면(1초 전) 타이머가 취소돼 전송이 일어나지 않는다(자동넘김 포함 — 삼순 게이트 ①).
 */
export function startVenueStoryViewGate<H>(opts: {
  delayMs?: number;
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
  onQualify: () => void;
}): () => void {
  let fired = false;
  const handle = opts.setTimer(() => {
    fired = true;
    opts.onQualify();
  }, opts.delayMs ?? VENUE_STORY_VIEW_GATE_MS);
  return () => {
    if (!fired) opts.clearTimer(handle);
  };
}

/**
 * 안정적 게스트 식별자(localStorage 영속 UUID). 없거나 형식이 깨졌으면 새로 발급해 저장.
 * storage 접근 불가(SSR/시크릿 저장 차단)면 null — 그 열람은 미집계(IP 폴백 금지, 삼순 게이트 ③).
 */
export function getOrCreateVenueGuestId(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  randomUUID: () => string,
): string | null {
  if (!storage) return null;
  try {
    const existing = storage.getItem(VENUE_STORY_GUEST_ID_KEY);
    if (existing && VENUE_GUEST_ID_RE.test(existing)) return existing;
    const id = randomUUID();
    if (!VENUE_GUEST_ID_RE.test(id)) return null;
    storage.setItem(VENUE_STORY_GUEST_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * 서버측 viewer_key 해석: 인증 유저가 최우선(`user:{id}`), 아니면 형식이 유효한 guest UUID
 * (`guest:{uuid}`, 소문자 정규화). 둘 다 아니면 null → 미집계 no-op.
 * IP/NAT 파생 키는 만들지 않는다(동일 NAT 다수 사용자 합산 금지 — 삼순 게이트 ③).
 */
export function resolveViewerKey(userId: string | null, guestId: unknown): string | null {
  if (userId) return `user:${userId}`;
  if (typeof guestId === "string" && VENUE_GUEST_ID_RE.test(guestId)) {
    return `guest:${guestId.toLowerCase()}`;
  }
  return null;
}

export interface ViewPingPayload {
  guestId: string | null;
  /** sendBeacon 은 헤더를 못 실으므로 인증 토큰을 body 로 전달(HTTPS, 헤더와 동일 노출면). */
  accessToken: string | null;
}

/**
 * 조회 1건 전송(삼순 게이트 ④): navigator.sendBeacon 우선(페이지 이탈/앱 종료 직전에도
 * 브라우저가 큐잉해 유실 최소화), 미지원/큐잉 실패 시 fetch keepalive 폴백.
 * 반환 false 면 호출부가 세션 내 재시도할 수 있게 mark 를 해제한다.
 */
export async function sendVenueStoryViewPing(opts: {
  url: string;
  payload: ViewPingPayload;
  sendBeacon?: (url: string, data: BodyInit) => boolean;
  fetchFn: typeof fetch;
}): Promise<boolean> {
  const body = JSON.stringify(opts.payload);
  if (opts.sendBeacon) {
    try {
      // text/plain Blob — application/json 은 beacon CORS preflight 제약이 있어 안전한 기본값 사용.
      // 같은 오리진 API 라 Content-Type 은 서버 파싱(req.json 대신 text→parse)에서 흡수한다.
      if (opts.sendBeacon(opts.url, new Blob([body], { type: "text/plain" }))) return true;
    } catch {
      // sendBeacon 자체 예외 → fetch 폴백으로 진행
    }
  }
  try {
    const res = await opts.fetchFn(opts.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 관리자 전용 조회수 부착(삼순 게이트 ⑤): isAdmin 일 때만 각 스토리에 viewCount 를 넣는다.
 * 일반·익명 응답에는 **필드 자체가 존재하지 않는다**(undefined 대입도 금지 — JSON 직렬화
 * 전 단계에서 키 부재를 회귀로 고정한다).
 */
export function withAdminViewCounts(
  stories: VenueStory[],
  isAdmin: boolean,
  counts: Map<number, number>,
): VenueStory[] {
  if (!isAdmin) return stories;
  return stories.map((s) => ({ ...s, viewCount: counts.get(s.id) ?? 0 }));
}

/** venue_story_view_daily 행(스토리당 일별 다행)을 스토리별 누적 합으로 접는다. */
export function sumViewCountsByStory(
  rows: Array<{ story_id: number | string; view_count: number | string }> | null | undefined,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows ?? []) {
    const id = Number(r.story_id);
    const count = Number(r.view_count);
    if (!Number.isSafeInteger(id) || !Number.isFinite(count)) continue;
    out.set(id, (out.get(id) ?? 0) + count);
  }
  return out;
}
