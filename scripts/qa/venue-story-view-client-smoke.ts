// 직관 스토리 조회수 트래킹 — 클라 순수 헬퍼 회귀 (삼순 게이트 ①③④⑤).
// 실행: tsx --test scripts/qa/venue-story-view-client-smoke.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  VENUE_STORY_VIEW_GATE_MS,
  VENUE_STORY_GUEST_ID_KEY,
  startVenueStoryViewGate,
  getOrCreateVenueGuestId,
  resolveViewerKey,
  sendVenueStoryViewPing,
  withAdminViewCounts,
  sumViewCountsByStory,
} from "../../src/lib/venue-stories/view-tracking";
import type { VenueStory } from "../../src/lib/venue-stories/types";

// ── fake timer (주입형 — 실제 setTimeout 미사용) ──
function makeFakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: number) => {
      pending.delete(id);
    },
    fire: () => {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    pendingCount: () => pending.size,
    lastDelay: () => [...pending.values()].at(-1)?.ms ?? null,
  };
}

test("게이트 ①: 1초 경과 시에만 onQualify — 기본 지연 1000ms", () => {
  const timers = makeFakeTimers();
  let qualified = 0;
  startVenueStoryViewGate({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onQualify: () => qualified++,
  });
  assert.equal(timers.lastDelay(), VENUE_STORY_VIEW_GATE_MS);
  assert.equal(qualified, 0); // 즉시 fire 금지
  timers.fire();
  assert.equal(qualified, 1);
});

test("게이트 ①: 1초 전 취소(자동넘김/전환/뷰어 종료)면 전송 없음", () => {
  const timers = makeFakeTimers();
  let qualified = 0;
  const cancel = startVenueStoryViewGate({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onQualify: () => qualified++,
  });
  cancel(); // 1초 전 스토리 전환
  timers.fire();
  assert.equal(qualified, 0);
  assert.equal(timers.pendingCount(), 0);
});

test("게이트 ①: qualify 후 cancel 은 no-op (중복 clear 안전)", () => {
  const timers = makeFakeTimers();
  let cleared = 0;
  const cancel = startVenueStoryViewGate({
    setTimer: timers.setTimer,
    clearTimer: (h: number) => {
      cleared++;
      timers.clearTimer(h);
    },
    onQualify: () => {},
  });
  timers.fire();
  cancel();
  assert.equal(cleared, 0);
});

// ── 게스트 식별자 (③) ──
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    dump: () => Object.fromEntries(map),
  };
}

test("게스트 ③: 최초 발급 후 localStorage 영속 재사용", () => {
  const storage = makeStorage();
  const uuid = "3f2b1a90-1234-4abc-8def-0123456789ab";
  const first = getOrCreateVenueGuestId(storage, () => uuid);
  assert.equal(first, uuid);
  assert.equal(storage.dump()[VENUE_STORY_GUEST_ID_KEY], uuid);
  // 두 번째 호출은 새 UUID 를 만들지 않고 기존 값 재사용
  const second = getOrCreateVenueGuestId(storage, () => {
    throw new Error("must not regenerate");
  });
  assert.equal(second, uuid);
});

test("게스트 ③: 깨진 값은 재발급, storage 불가면 null(집계 skip — IP 폴백 없음)", () => {
  const storage = makeStorage({ [VENUE_STORY_GUEST_ID_KEY]: "not-a-uuid" });
  const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(getOrCreateVenueGuestId(storage, () => uuid), uuid);
  assert.equal(getOrCreateVenueGuestId(null, () => uuid), null);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  assert.equal(getOrCreateVenueGuestId(throwing, () => uuid), null);
});

test("viewer_key ③: user 우선, guest 는 UUID 형식만, 그 외 null", () => {
  assert.equal(resolveViewerKey("u-1", "3f2b1a90-1234-4abc-8def-0123456789ab"), "user:u-1");
  assert.equal(
    resolveViewerKey(null, "3F2B1A90-1234-4ABC-8DEF-0123456789AB"),
    "guest:3f2b1a90-1234-4abc-8def-0123456789ab", // 소문자 정규화
  );
  assert.equal(resolveViewerKey(null, "junk"), null);
  assert.equal(resolveViewerKey(null, 123), null);
  assert.equal(resolveViewerKey(null, null), null);
  // IP 문자열이 guest 로 흘러들어도 UUID 형식이 아니므로 거부(NAT 합산 금지)
  assert.equal(resolveViewerKey(null, "211.36.132.1"), null);
});

// ── 전송 신뢰성 (④) ──
const payload = { guestId: "3f2b1a90-1234-4abc-8def-0123456789ab", accessToken: null };

test("전송 ④: sendBeacon 큐잉 성공이면 fetch 미호출", async () => {
  let fetched = 0;
  const ok = await sendVenueStoryViewPing({
    url: "/api/venue-stories/1/view",
    payload,
    sendBeacon: () => true,
    fetchFn: (async () => {
      fetched++;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(ok, true);
  assert.equal(fetched, 0);
});

test("전송 ④: beacon 실패/미지원 → fetch keepalive 폴백", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  // beacon 이 false(큐잉 거부) → 폴백
  assert.equal(
    await sendVenueStoryViewPing({ url: "/v", payload, sendBeacon: () => false, fetchFn }),
    true,
  );
  // beacon 미지원(undefined) → 폴백
  assert.equal(await sendVenueStoryViewPing({ url: "/v", payload, fetchFn }), true);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.init?.method, "POST");
    assert.equal((c.init as { keepalive?: boolean })?.keepalive, true); // 이탈 직전 유실 최소화
    assert.deepEqual(JSON.parse(String(c.init?.body)), payload);
  }
});

test("전송 ④: fetch 실패/비정상 응답이면 false — 호출부 재시도 mark 해제용", async () => {
  assert.equal(
    await sendVenueStoryViewPing({
      url: "/v",
      payload,
      fetchFn: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    }),
    false,
  );
  assert.equal(
    await sendVenueStoryViewPing({
      url: "/v",
      payload,
      fetchFn: (async () => new Response(null, { status: 500 })) as typeof fetch,
    }),
    false,
  );
});

// ── 관리자 전용 노출 (⑤) ──
function story(id: number): VenueStory {
  return {
    id,
    gameId: "g",
    userId: "u",
    mediaType: "image",
    mediaUrl: "https://example.com/m.jpg",
    thumbUrl: null,
    durationMs: null,
    width: null,
    height: null,
    caption: null,
    venueVerified: false,
    createdAt: "2026-07-29T00:00:00Z",
    author: { nickname: null, avatarUrl: null, teamId: null },
  };
}

test("관리자 ⑤: 일반·익명 응답에는 viewCount 필드 자체가 존재하지 않는다 (회귀)", () => {
  const out = withAdminViewCounts([story(1), story(2)], false, new Map([[1, 9]]));
  for (const s of out) {
    assert.equal("viewCount" in s, false); // undefined 대입도 금지 — 키 부재
    assert.equal(Object.keys(JSON.parse(JSON.stringify(s))).includes("viewCount"), false);
  }
});

test("관리자 ⑤: 관리자 응답에만 viewCount 부착(미집계 스토리는 0)", () => {
  const out = withAdminViewCounts([story(1), story(2)], true, new Map([[1, 9]]));
  assert.equal(out[0].viewCount, 9);
  assert.equal(out[1].viewCount, 0);
});

test("관리자 ⑤: daily 다행(일별) → 스토리별 누적 합", () => {
  const counts = sumViewCountsByStory([
    { story_id: 1, view_count: 3 },
    { story_id: 1, view_count: "4" },
    { story_id: 2, view_count: 5 },
    { story_id: "junk", view_count: 1 }, // 무시
  ]);
  assert.equal(counts.get(1), 7);
  assert.equal(counts.get(2), 5);
  assert.equal(sumViewCountsByStory(null).size, 0);
});
