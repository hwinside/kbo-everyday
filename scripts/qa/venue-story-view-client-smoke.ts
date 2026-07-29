// 직관 스토리 조회수 트래킹 — 클라/서버 공용 순수 헬퍼 회귀 (A안 원문 click/impression 2종).
// 실행: tsx --test scripts/qa/venue-story-view-client-smoke.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getOrCreateVenueGuestId,
  isVenueStoryViewKind,
  resolveViewerKey,
  sendVenueStoryViewPing,
  withAdminViewCounts,
  sumViewCountsByStory,
  venueStorySentKey,
  venueStoryViewRecordStatus,
  type StoryViewCounts,
} from "../../src/lib/venue-stories/view-tracking";
import type { VenueStory } from "../../src/lib/venue-stories/types";

test("kind 검증: click/impression 만 허용", () => {
  assert.equal(isVenueStoryViewKind("click"), true);
  assert.equal(isVenueStoryViewKind("impression"), true);
  assert.equal(isVenueStoryViewKind("view"), false);
  assert.equal(isVenueStoryViewKind(undefined), false);
  assert.equal(isVenueStoryViewKind(1), false);
});

test("클라 세션 dedupe 키는 KST 일자를 포함해 장시간 열린 탭도 다음 날 다시 집계", () => {
  const beforeKstMidnight = Date.parse("2026-07-29T14:59:59.000Z");
  const afterKstMidnight = Date.parse("2026-07-29T15:00:00.000Z");
  assert.equal(
    venueStorySentKey(7, "impression", "user:a", beforeKstMidnight),
    "2026-07-29:user:a:impression:7",
  );
  assert.equal(
    venueStorySentKey(7, "impression", "user:a", afterKstMidnight),
    "2026-07-30:user:a:impression:7",
  );
  assert.notEqual(
    venueStorySentKey(7, "click", "user:a", beforeKstMidnight),
    venueStorySentKey(7, "impression", "user:a", beforeKstMidnight),
  );
  assert.notEqual(
    venueStorySentKey(7, "click", "user:a", beforeKstMidnight),
    venueStorySentKey(7, "click", "user:b", beforeKstMidnight),
  );
});

test("게스트 UUID는 영속 재사용하고 storage 불가 시 IP 폴백 없이 null", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const uuid = "3f2b1a90-1234-4abc-8def-0123456789ab";
  assert.equal(getOrCreateVenueGuestId(storage, () => uuid), uuid);
  assert.equal(
    getOrCreateVenueGuestId(storage, () => {
      throw new Error("must reuse");
    }),
    uuid,
  );
  assert.equal(getOrCreateVenueGuestId(null, () => uuid), null);
});

// ── viewer_key (게스트 집계 · IP dedupe 금지) ──
test("viewer_key: user 우선, guest 는 UUID 형식만, 그 외 null", () => {
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

// ── 전송 신뢰성 (fetch keepalive 기본 + 이탈 직전에만 beacon fallback — 삼순 정정 #962) ──
const payload = {
  kind: "click" as const,
  guestId: "3f2b1a90-1234-4abc-8def-0123456789ab",
  accessToken: null,
};

test("전송: 일반 경로는 beacon 이 있어도 fetch(keepalive) 우선 — 응답 status 확인 가능 경로가 기본", async () => {
  let beaconed = 0;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const ok = await sendVenueStoryViewPing({
    url: "/api/venue-stories/1/view",
    payload,
    sendBeacon: () => {
      beaconed++;
      return true;
    },
    fetchFn,
  });
  assert.equal(ok, true);
  assert.equal(beaconed, 0); // 큐잉=성공 착각 경로 금지 — 일반 전송에서 beacon 미사용
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init as { keepalive?: boolean })?.keepalive, true);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), payload); // kind 가 body 로 전달됨
});

test("전송: 이탈 직전(unloading)에만 beacon 최후 fallback — 큐잉 성공 시 fetch 미호출", async () => {
  let fetched = 0;
  const ok = await sendVenueStoryViewPing({
    url: "/api/venue-stories/1/view",
    payload,
    unloading: true,
    sendBeacon: () => true,
    fetchFn: (async () => {
      fetched++;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  assert.equal(ok, true);
  assert.equal(fetched, 0);
});

test("전송: 이탈 직전 beacon 큐잉 거부/예외/미지원 → keepalive fetch 로 진행", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  // beacon 이 false(큐잉 거부) → fetch 진행
  assert.equal(
    await sendVenueStoryViewPing({
      url: "/v",
      payload,
      unloading: true,
      sendBeacon: () => false,
      fetchFn,
    }),
    true,
  );
  // beacon 자체 예외 → fetch 진행
  assert.equal(
    await sendVenueStoryViewPing({
      url: "/v",
      payload,
      unloading: true,
      sendBeacon: () => {
        throw new Error("beacon boom");
      },
      fetchFn,
    }),
    true,
  );
  // beacon 미지원(undefined) → fetch 진행
  assert.equal(await sendVenueStoryViewPing({ url: "/v", payload, unloading: true, fetchFn }), true);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.init?.method, "POST");
    assert.equal((c.init as { keepalive?: boolean })?.keepalive, true); // 이탈 직전 유실 최소화
  }
});

test("전송: fetch 실패/5xx 응답이면 false — 호출부 재시도 mark 해제용(RPC 오류 성공 위장 금지)", async () => {
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

test("RPC 오류 응답은 500이며 뷰어 click은 타이머 없이 즉시 전송", () => {
  assert.equal(venueStoryViewRecordStatus(null), 204);
  assert.equal(venueStoryViewRecordStatus({ message: "db down" }), 500);
  const route = readFileSync(
    new URL("../../src/app/api/venue-stories/[id]/view/route.ts", import.meta.url),
    "utf8",
  );
  const viewer = readFileSync(
    new URL("../../src/components/game/VenueStoryViewer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(route, /status:\s*venueStoryViewRecordStatus\(error\)/);
  assert.match(viewer, /trackVenueStoryView\(storyId,\s*"click"\)/);
  assert.doesNotMatch(viewer, /startVenueStoryViewGate|VIEW_GATE_MS/);
});

test("트레이 impression은 IntersectionObserver 50%+dwell 및 세션 중복 방지", () => {
  const source = readFileSync(
    new URL("../../src/lib/venue-stories/useStoryImpression.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /intersectionRatio >= 0\.5/);
  assert.match(source, /setTimeout/);
  assert.match(source, /trackVenueStoryView\(storyId,\s*"impression"\)/);

  const section = readFileSync(
    new URL("../../src/components/game/VenueStorySection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(section, /useVenueStoryImpression/);
  assert.doesNotMatch(section, /new IntersectionObserver/); // 구형 수동 observer 경로 재유입 금지
  assert.doesNotMatch(section, /trayRef|impressionSentRef|data-story-impression/);
});

test("각 fire의 user/guest 판정은 전송 시점 세션이며 viewer별 세션 dedupe를 적용", () => {
  const client = readFileSync(
    new URL("../../src/lib/venue-stories/view-tracker-client.ts", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("../../src/lib/venue-stories/useStoryImpression.ts", import.meta.url),
    "utf8",
  );
  const route = readFileSync(
    new URL("../../src/app/api/venue-stories/[id]/view/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(client.match(/await getSafeSession\(\)/g)?.length, 1);
  assert.match(client, /session\?\.user\?\.id/);
  assert.match(client, /venueStorySentKey\(storyId,\s*kind,\s*viewerKey\)/);
  assert.match(client, /payload:\s*\{\s*kind,\s*guestId,\s*accessToken:/);
  assert.doesNotMatch(hook, /hasTrackedVenueStoryView/);
  assert.equal(route.match(/const viewerKey = resolveViewerKey\(/g)?.length, 1);
});

test("클라 배선: beacon 은 이탈 직전 fallback 만, mark 는 2xx 확인 실패 시 해제 (삼순 정정 #962)", () => {
  const client = readFileSync(
    new URL("../../src/lib/venue-stories/view-tracker-client.ts", import.meta.url),
    "utf8",
  );
  // 이탈 감지 배선: pagehide 설정 + pageshow(bfcache) 복원 + 전송 시점 unloading 전달
  assert.match(client, /addEventListener\("pagehide"/);
  assert.match(client, /addEventListener\("pageshow"/);
  assert.match(client, /unloading:\s*isPageUnloading\(\)/);
  // 실패(비 2xx·네트워크 오류) 시 mark 해제 → 재시도 경로 생존
  assert.match(client, /if \(!ok\) sent\.delete\(key\)/);
});

// ── 관리자 전용 노출 ("숫자는 일단 관리자만") ──
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

test("관리자: 일반·익명 응답에는 clickCount/impressionCount 필드 자체가 존재하지 않는다 (회귀)", () => {
  const counts = new Map<number, StoryViewCounts>([[1, { click: 9, impression: 3 }]]);
  const out = withAdminViewCounts([story(1), story(2)], false, counts);
  for (const s of out) {
    assert.equal("clickCount" in s, false); // undefined 대입도 금지 — 키 부재
    assert.equal("impressionCount" in s, false);
    const keys = Object.keys(JSON.parse(JSON.stringify(s)));
    assert.equal(keys.includes("clickCount"), false);
    assert.equal(keys.includes("impressionCount"), false);
  }
});

test("관리자: 관리자 응답에만 2종 카운트 부착(미집계 스토리는 0)", () => {
  const counts = new Map<number, StoryViewCounts>([[1, { click: 9, impression: 3 }]]);
  const out = withAdminViewCounts([story(1), story(2)], true, counts);
  assert.equal(out[0].clickCount, 9);
  assert.equal(out[0].impressionCount, 3);
  assert.equal(out[1].clickCount, 0);
  assert.equal(out[1].impressionCount, 0);
});

test("관리자: daily 다행(스토리×kind×일별) → 스토리별 kind 누적 합", () => {
  const counts = sumViewCountsByStory([
    { story_id: 1, kind: "click", view_count: 3 },
    { story_id: 1, kind: "click", view_count: "4" },
    { story_id: 1, kind: "impression", view_count: 10 },
    { story_id: 2, kind: "impression", view_count: 5 },
    { story_id: 1, kind: "bogus", view_count: 99 }, // 무시
    { story_id: "junk", kind: "click", view_count: 1 }, // 무시
  ]);
  assert.deepEqual(counts.get(1), { click: 7, impression: 10 });
  assert.deepEqual(counts.get(2), { click: 0, impression: 5 });
  assert.equal(sumViewCountsByStory(null).size, 0);
});
