import assert from "node:assert/strict";
import { test } from "node:test";
import { isKboGameCancelled } from "../../src/lib/crawler/kbo-status";
import { isStartNotificationFresh } from "../../src/lib/notifications/start-freshness-policy";

// 2026-07-23 하린아빠 지시 — "이미 늦은 시작알림은 발송 안되게 가드": 이닝 진행도 기반 뒷북 차단.
test("시작알림 신선도: 1회초는 발송(정상 개시·우천 지연 개시 포함)", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: true }), true);
});
test("시작알림 신선도: 1회말부터는 뒷북 → 발송 금지", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: false }), false);
});
test("시작알림 신선도: 2회 이상은 뒷북 → 발송 금지(장애 복구 버스트 차단)", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 2, isTop: true }), false);
  assert.equal(isStartNotificationFresh({ inningNo: 7, isTop: false }), false);
});
test("시작알림 신선도: 이닝 정보 없음(개시 직후)은 fresh — 시간 윈도우가 커버", () => {
  assert.equal(isStartNotificationFresh({ inningNo: null, isTop: null }), true);
  assert.equal(isStartNotificationFresh({ inningNo: undefined, isTop: true }), true);
  assert.equal(isStartNotificationFresh({ inningNo: 0, isTop: null }), true);
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: null }), true);
});

// 2026-07-23 회귀: KBO GetKboGameList가 예정 경기에 CANCEL_SC_ID를 빈 값/공백/미포함으로
// 내려줄 때 `CANCEL_SC_ID !== "0"`가 true가 되어 정상 경기가 홈 경기카드에서 "경기 취소"로
// 오표기(그리고 잘못된 '경기 취소' 푸시 발송)되던 버그. isKboGameCancelled SSOT는 오직
// 명시적 양의 정수 취소 코드만 취소로 판정한다.

test("정상/미확정 코드는 취소가 아니다", () => {
  for (const v of ["0", "", " ", "  0 ", undefined, null, 0, "00", "abc", "-1", "0.0", "NaN"]) {
    assert.equal(isKboGameCancelled(v as string), false, `should NOT be cancelled: ${JSON.stringify(v)}`);
  }
});

test("양의 정수 취소 코드만 취소로 판정한다", () => {
  for (const v of ["1", "2", "3", "5", "9", " 3 ", 1, 9]) {
    assert.equal(isKboGameCancelled(v as string), true, `should be cancelled: ${JSON.stringify(v)}`);
  }
});

test("핵심 버그 재현: 빈 CANCEL_SC_ID의 예정 경기는 취소가 아니다", () => {
  // 예정(GAME_STATE_SC="1") + CANCEL_SC_ID="" → 이전엔 cancelled, 이제 not-cancelled
  const emptyScheduled = { GAME_STATE_SC: "1", CANCEL_SC_ID: "" };
  assert.equal(isKboGameCancelled(emptyScheduled.CANCEL_SC_ID), false);
  // 실제 취소(우천 등)는 여전히 취소로 잡힌다
  const rained = { GAME_STATE_SC: "1", CANCEL_SC_ID: "3" };
  assert.equal(isKboGameCancelled(rained.CANCEL_SC_ID), true);
});
