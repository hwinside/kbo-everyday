// 크관 [직관] 배지 스모크 — attendeeUserIdsFromRows 순수 판정 검증.
// 실행: npm run qa:venue-chat-badge
import assert from "node:assert/strict";
import {
  attendeeUserIdsFromRows,
  shouldShowVenueBadge,
  type VenueAttendees,
} from "../../src/lib/venue-stories/chat-badge";

// 1) 중복 작성자(경기당 최대 10개 스토리) → user_id 1개로 dedupe
assert.deepEqual(
  attendeeUserIdsFromRows([{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }]),
  ["u1", "u2"],
);

// 2) 빈 목록 → 빈 배열 (스토리 없는 경기 = 배지 0)
assert.deepEqual(attendeeUserIdsFromRows([]), []);

// 3) 순서 보존 (first-seen)
assert.deepEqual(
  attendeeUserIdsFromRows([{ user_id: "b" }, { user_id: "a" }, { user_id: "b" }]),
  ["b", "a"],
);

// 4) client 매핑: Set 멤버십으로 해당 경기 한정 배지 표시
const set = new Set(attendeeUserIdsFromRows([{ user_id: "u1" }]));
assert.equal(set.has("u1"), true);
assert.equal(set.has("other-game-user"), false);

// ── 경기 전환 계약 회귀 (shouldShowVenueBadge 가드 검증) ──────────────────────
// 삼순 지적: 단일 Set 멤버십만 보면 `gameId === currentGameId` 가드가 제거돼도
// PASS한다. 아래 3전환을 production 판정 함수(shouldShowVenueBadge)로 고정해,
// 가드 라인이 사라지면 반드시 FAIL하도록 한다.
const GAME_A = "game-A";
const GAME_B = "game-B";
const SHARED_USER = "u-shared"; // A·B 양쪽 명단에 있는 유저 (최악 케이스)
const B_ONLY_USER = "u-b-only";

// A 명단 로드 상태 (SHARED_USER 포함)
const attendeesA: VenueAttendees = { gameId: GAME_A, ids: new Set([SHARED_USER]) };

// 5) A 명단이 남아 있는 채로 B로 전환 → B 응답 pending/실패(명단은 아직 A) →
//    현재 경기 B 기준 배지 false. (Set 멤버십만 보면 true로 새는 케이스)
assert.equal(
  shouldShowVenueBadge(attendeesA, GAME_B, SHARED_USER),
  false,
  "5) A명단 잔존 + B 전환(pending) → B에서 배지 false여야 함",
);

// 6) A의 지연 응답이 (B로 전환 후) 뒤늦게 도착 → snapshot은 여전히 gameId=A →
//    현재 경기 B에서는 계속 false (cleanup guard와 별개로 렌더 판정도 차단).
const lateArrivedA: VenueAttendees = { gameId: GAME_A, ids: new Set([SHARED_USER]) };
assert.equal(
  shouldShowVenueBadge(lateArrivedA, GAME_B, SHARED_USER),
  false,
  "6) A 지연응답 도착해도 B에서 계속 false여야 함",
);

// 7) B 명단 로드 완료 → B 유저만 true, (B 명단에 없는) 타 경기 유저는 false.
const attendeesB: VenueAttendees = { gameId: GAME_B, ids: new Set([B_ONLY_USER]) };
assert.equal(
  shouldShowVenueBadge(attendeesB, GAME_B, B_ONLY_USER),
  true,
  "7) B 명단 로드 후 B 유저는 true여야 함",
);
assert.equal(
  shouldShowVenueBadge(attendeesB, GAME_B, SHARED_USER),
  false,
  "7) B 명단에 없는 유저(A 전용)는 B에서 false여야 함",
);

// 8) 명단 미로드(null) / 안전 기본값 → 항상 false.
assert.equal(shouldShowVenueBadge(null, GAME_A, SHARED_USER), false, "8) null snapshot → false");

console.log("venue-chat-badge-smoke: PASS (8 cases; incl. 3 game-switch guard regressions)");
