// 크관 [직관] 배지 스모크 — attendeeUserIdsFromRows 순수 판정 검증.
// 실행: npm run qa:venue-chat-badge
import assert from "node:assert/strict";
import { attendeeUserIdsFromRows } from "../../src/lib/venue-stories/chat-badge";

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

console.log("venue-chat-badge-smoke: PASS (4 cases)");
