// 직관 스토리 조회수 트래킹 — 순수 헬퍼 (A안 원문: click/impression 2종 분리 집계, #735 패턴 이식).
// 클라(뷰어 click·트레이 impression)와 서버(view API·목록 API)가 같은 규약을 쓰도록 한 파일에 모은다.
// 전부 주입형/순수 함수 — scripts/qa/venue-story-view-client-smoke.ts 가 동일 코드를 회귀로 고정한다.

import type { VenueStory } from "./types";

/** A안 2종 지표: 뷰어 열람 = click, 트레이 실제 노출(≥50% + 0.5s dwell) = impression. */
export type VenueStoryViewKind = "click" | "impression";

export function isVenueStoryViewKind(value: unknown): value is VenueStoryViewKind {
  return value === "click" || value === "impression";
}

/** KST 일별 서버 dedupe와 클라 세션 dedupe 경계를 맞춘 키(장시간 열린 탭도 자정 이후 재집계). */
export function venueStorySentKey(
  storyId: number,
  kind: VenueStoryViewKind,
  viewerKey: string,
  nowMs = Date.now(),
): string {
  const kstDay = new Date(nowMs + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  return `${kstDay}:${viewerKey}:${kind}:${storyId}`;
}

/**
 * 게스트 식별자 localStorage 키. 로그아웃/계정 전환 정리는 명시 키 목록만 지우므로 생존한다.
 */
export const VENUE_STORY_GUEST_ID_KEY = "vsv_guest_id";

/** guest id 는 UUID 형식만 인정 — 서버가 임의 문자열로 cardinality 폭주하는 것을 막는다. */
export const VENUE_GUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 안정적 게스트 식별자. storage 접근 불가면 null(IP 폴백 금지). */
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
 * IP/NAT 파생 키는 만들지 않는다(동일 NAT 다수 사용자 합산 금지 — #735 재발 방지 체크리스트).
 */
export function resolveViewerKey(userId: string | null, guestId: unknown): string | null {
  if (userId) return `user:${userId}`;
  if (typeof guestId === "string" && VENUE_GUEST_ID_RE.test(guestId)) {
    return `guest:${guestId.toLowerCase()}`;
  }
  return null;
}

export interface ViewPingPayload {
  kind: VenueStoryViewKind;
  guestId: string | null;
  /** sendBeacon 은 헤더를 못 실으므로 인증 토큰을 body 로 전달(HTTPS 동일 오리진, 헤더와 동일 노출면). */
  accessToken: string | null;
}

/**
 * 조회 1건 전송(삼순 post-merge 정정 리뷰 #962 반영): **기본 경로는 fetch(keepalive:true)**.
 * 서버 응답 status(204/5xx)를 확인할 수 있는 유일한 경로라, 성공 확정(2xx)과 실패 재시도
 * (mark 해제) 판정의 기준이 된다. keepalive 라 이탈 직후에도 브라우저가 요청을 이어 보낸다.
 *
 * navigator.sendBeacon 은 **페이지 이탈(pagehide/visibilitychange hidden) 직전 최후
 * fallback 으로만** 사용한다(opts.unloading): beacon 의 반환 true 는 "브라우저 큐잉 성공"일
 * 뿐 서버 저장 성공이 아니며 **응답을 확인할 방법이 없다** — 서버 RPC 가 500 을 내도 감지·
 * 재시도가 불가능하다. 이탈 시엔 탭과 함께 세션 mark(Set)도 소멸하므로, 이탈 경로에
 * 한해 큐잉 성공을 best-effort 성공으로 간주하는 트레이드오프다.
 *
 * 반환 false(fetch 네트워크 실패·5xx)면 호출부가 mark 를 해제해 다음 노출/열람 때
 * 재전송한다 — 중복 방지는 서버 KST 일별 dedupe(RPC)가 권위라 이중 집계가 없다.
 */
export async function sendVenueStoryViewPing(opts: {
  url: string;
  payload: ViewPingPayload;
  /** 페이지 이탈 직전 여부 — true 일 때만 sendBeacon fallback 을 허용한다. */
  unloading?: boolean;
  sendBeacon?: (url: string, data: BodyInit) => boolean;
  fetchFn: typeof fetch;
}): Promise<boolean> {
  const body = JSON.stringify(opts.payload);
  if (opts.unloading && opts.sendBeacon) {
    try {
      // 이탈 직전엔 일반 fetch 가 중단될 수 있어 beacon 을 먼저 시도. text/plain Blob 은
      // beacon 의 안전한 기본값(서버가 text→parse 로 흡수). 큐잉 성공이어도 서버 저장
      // 성공은 확인 불가(응답 없음) — 이탈 경로 한정 best-effort.
      if (opts.sendBeacon(opts.url, new Blob([body], { type: "text/plain" }))) return true;
    } catch {
      // sendBeacon 자체 예외 → keepalive fetch 로 진행
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

export interface StoryViewCounts {
  click: number;
  impression: number;
}

/**
 * 관리자 전용 조회수 부착("숫자는 일단 관리자만" — 하린아빠 23:09): isAdmin 일 때만 각 스토리에
 * clickCount/impressionCount 를 넣는다. 일반·익명 응답에는 **필드 자체가 존재하지 않는다**
 * (undefined 대입도 금지 — JSON 직렬화 전 단계에서 키 부재를 회귀로 고정한다).
 */
export function withAdminViewCounts(
  stories: VenueStory[],
  isAdmin: boolean,
  counts: Map<number, StoryViewCounts>,
): VenueStory[] {
  if (!isAdmin) return stories;
  return stories.map((s) => {
    const c = counts.get(s.id);
    return { ...s, clickCount: c?.click ?? 0, impressionCount: c?.impression ?? 0 };
  });
}

/** venue_story_view_daily 행(스토리×kind×일별 다행)을 스토리별 kind 누적 합으로 접는다. */
export function sumViewCountsByStory(
  rows:
    | Array<{ story_id: number | string; kind: string; view_count: number | string }>
    | null
    | undefined,
): Map<number, StoryViewCounts> {
  const out = new Map<number, StoryViewCounts>();
  for (const r of rows ?? []) {
    const id = Number(r.story_id);
    const count = Number(r.view_count);
    if (!Number.isSafeInteger(id) || !Number.isFinite(count)) continue;
    if (!isVenueStoryViewKind(r.kind)) continue;
    const cur = out.get(id) ?? { click: 0, impression: 0 };
    cur[r.kind] += count;
    out.set(id, cur);
  }
  return out;
}

/** RPC 실패를 성공(204)으로 위장하지 않도록 route와 QA가 공유하는 상태 규약. */
export function venueStoryViewRecordStatus(error: unknown): 204 | 500 {
  return error ? 500 : 204;
}
