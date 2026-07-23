import assert from "node:assert/strict";
import { test } from "node:test";
import { isKboGameCancelled } from "../../src/lib/crawler/kbo-status";
import {
  isStartNotificationFresh,
  shouldSendStartNotification,
  SCHEDULED_SEEN_RECENT_MS,
} from "../../src/lib/notifications/start-freshness-policy";

// 2026-07-23 삼순 post-merge blocker — 정시-only 게이트 경계 회귀
// (정상 시작 / 이미 진행 / 장애 복구 / 우천 지연 실제 시작 / 90초 경계 / 첫-live 이닝미제공)
// window=90초: warmup cron은 매분 돌므로 바로 직전 틱의 예정 관측(~60초)만 연속으로 인정.
const NOW = 1_784_800_000_000;
test("정시 게이트: 정상 시작 — 직전 틱(60초 전) scheduled 관측 + 1회초 → 발송", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 60_000, nowMs: NOW, inningNo: 1, isTop: true,
  }), true);
});
test("정시 게이트: 첫 관측이 이미 live(scheduled 관측 이력 없음) → mark-only", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: null, nowMs: NOW, inningNo: 1, isTop: true,
  }), false);
});
test("정시 게이트: 이닝 미제공 첫-live(scheduled 이력 없음 + inning=null) → mark-only", () => {
  // 장애 복구로 첫 관측이 이미 live이면 이닝 정보가 없어도 신선도를 상승하지 않는다.
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: null, nowMs: NOW, inningNo: undefined, isTop: null,
  }), false);
});
test("정시 게이트: 장애 복구 — 마지막 scheduled 관측이 90초+1ms 전(틱 건너뜀) → mark-only", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - SCHEDULED_SEEN_RECENT_MS - 1, nowMs: NOW, inningNo: 1, isTop: true,
  }), false);
});
test("정시 게이트: 90초 경계 정확히 안(=90초 전) → 발송", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - SCHEDULED_SEEN_RECENT_MS, nowMs: NOW, inningNo: 1, isTop: true,
  }), true);
});
test("정시 게이트: 우천 지연 실제 시작 — 지연 내내 scheduled 관측 지속하다 전환 직후(틱 연속) → 발송", () => {
  // 예정 18:30 경기가 60분 지연돼도 cron은 매분 scheduled를 관측 — 직전 틱(89초 전) 관측이면 발송
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 89_000, nowMs: NOW, inningNo: 1, isTop: true,
  }), true);
});
test("정시 게이트: 최근 관측이어도 이미 진행된 경기(1회말+) → mark-only(이중 안전망)", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 60_000, nowMs: NOW, inningNo: 3, isTop: false,
  }), false);
});

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
