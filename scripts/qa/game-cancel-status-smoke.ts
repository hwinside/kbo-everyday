import assert from "node:assert/strict";
import { test } from "node:test";
import { isKboGameCancelled } from "../../src/lib/crawler/kbo-status";
import {
  isStartNotificationFresh,
  shouldSendStartNotification,
  SCHEDULED_SEEN_RECENT_MS,
} from "../../src/lib/notifications/start-freshness-policy";
import { deriveStartPlateAppearanceEvidence } from "../../src/lib/notifications/start-plate-appearance";

// 2026-07-23 삼순 post-merge blocker — 정시-only 게이트 경계 회귀 4종
// (정상 시작 / 이미 진행 / 장애 복구 / 우천 지연 실제 시작)
const NOW = 1_784_800_000_000;
const FIRST_PA = { completedPlateAppearances: 0, currentBatterIsLeadoff: true } as const;
test("정시 게이트: 정상 시작 — 직전 틱(60초 전) scheduled 관측 + 1회초 → 발송", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 60_000, nowMs: NOW, inningNo: 1, isTop: true, plateAppearance: FIRST_PA,
  }), true);
});
test("정시 게이트: 90초 경계 정확히 안(=90초 전) → 발송", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - SCHEDULED_SEEN_RECENT_MS, nowMs: NOW, inningNo: 1, isTop: true, plateAppearance: FIRST_PA,
  }), true);
});
test("정시 게이트: 90초+1ms(틱 건너뜀) → mark-only", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - SCHEDULED_SEEN_RECENT_MS - 1, nowMs: NOW, inningNo: 1, isTop: true,
  }), false);
});
test("정시 게이트: 첫-live 이닝 미제공(scheduled 이력 없음 + inning null) → mark-only", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: null, nowMs: NOW, inningNo: undefined, isTop: null,
  }), false);
});
test("정시 게이트: 첫 관측이 이미 live(scheduled 관측 이력 없음) → mark-only", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: null, nowMs: NOW, inningNo: 1, isTop: true,
  }), false);
});
test("정시 게이트: 장애 복구 — 마지막 scheduled 관측이 4분 전(틱 여러 개 건너뜀) → mark-only", () => {
  // 5분 허용이었다면 통과했을 4분 장애 복구 케이스 — 90초 게이트가 차단해야 한다(삼순 blocker 핵심).
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 4 * 60_000, nowMs: NOW, inningNo: 1, isTop: true,
  }), false);
});
test("정시 게이트: 우천 지연 실제 시작 — 지연 내내 scheduled 관측 지속, 직전 틱(89초 전) 관측 → 발송", () => {
  // 예정 18:30 경기가 60분 지연돼도 cron은 매분 scheduled를 관측 — 틱 연속이면 발송
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 89_000, nowMs: NOW, inningNo: 1, isTop: true, plateAppearance: FIRST_PA,
  }), true);
});
test("정시 게이트: 1회초 중간 재관측이라도 관측 연속이면 발송 허용(1회초 가드는 이닝 기준)", () => {
  // 직전 틱 scheduled 관측 + 아직 1회초 — 정상 전환 경로이므로 발송(이닝 가드와 역할 분리 확인)
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 30_000, nowMs: NOW, inningNo: 1, isTop: true, plateAppearance: FIRST_PA,
  }), true);
});
test("정시 게이트: 최근 관측이어도 이미 진행된 경기(1회말+) → mark-only(이중 안전망)", () => {
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: NOW - 60_000, nowMs: NOW, inningNo: 3, isTop: false,
  }), false);
});

// 2026-07-24 사고 회귀 — LG:한화 시작알림 mark-only 억제 재현.
// 관측(fetch) 간격은 76초로 연속인데, 게이트 nowMs를 경기별 처리 시점(같은 틱 내 앞 경기
// FCM 대량발송 후 +26초)으로 재면 102초 stale 오판 → 억제. 관측 시각 기준이면 정상 발송.
test("2026-07-24 회귀: 관측 간격 76초(연속 틱) — 관측 시각 기준이면 발송", () => {
  const seen = NOW - 76_000;
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: seen, nowMs: NOW, inningNo: 1, isTop: true, plateAppearance: FIRST_PA,
  }), true);
});
test("2026-07-24 회귀: 같은 관측을 처리 시점(+26초 지연)으로 재면 102초 → 오판 억제 (nowMs 계약 위반 사례)", () => {
  const seen = NOW - 76_000;
  assert.equal(shouldSendStartNotification({
    lastSeenScheduledAtMs: seen, nowMs: NOW + 26_000, inningNo: 1, isTop: true,
  }), false); // 그래서 호출부는 반드시 관측(fetch) 시각을 nowMs로 넘겨야 한다
});

// ⚠️ 게이트 "프로덕션 배선" 회귀(앞 경기 FCM 지연 → 뒤 경기 LG 억제 여부)는 실제
// notifyGameStatusTransitions() 실행 검증으로만 잡을 수 있으므로(삼순 기준③), 위 정책함수
// 경계 테스트와 별도로 scripts/qa/game-status-start-wiring-smoke.ts 에서 다룬다(qa:start-wiring).

// 2026-07-23 하린아빠 지시 — "이미 늦은 시작알림은 발송 안되게 가드": 이닝 진행도 기반 뒷북 차단.
test("시작알림 신선도: 첫 타석 진행 중 1회초는 발송", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: true, plateAppearance: FIRST_PA }), true);
});
test("시작알림 신선도: 1회말부터는 뒷북 → 발송 금지", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: false }), false);
});
test("시작알림 신선도: 2회 이상은 뒷북 → 발송 금지(장애 복구 버스트 차단)", () => {
  assert.equal(isStartNotificationFresh({ inningNo: 2, isTop: true }), false);
  assert.equal(isStartNotificationFresh({ inningNo: 7, isTop: false }), false);
});
test("시작알림 신선도: 이닝/타석 근거가 없으면 fail-close", () => {
  assert.equal(isStartNotificationFresh({ inningNo: null, isTop: null }), false);
  assert.equal(isStartNotificationFresh({ inningNo: undefined, isTop: true }), false);
  assert.equal(isStartNotificationFresh({ inningNo: 0, isTop: null }), false);
  assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: null }), false);
});

test("시작알림 첫 타석 cutoff: 선두타자 진행 중만 fresh, 완료/2번 타자/근거 없음은 차단", () => {
  assert.equal(isStartNotificationFresh({
    inningNo: 1, isTop: true,
    plateAppearance: { completedPlateAppearances: 0, currentBatterIsLeadoff: true },
  }), true);
  for (const plateAppearance of [
    { completedPlateAppearances: 1, currentBatterIsLeadoff: false },
    { completedPlateAppearances: 0, currentBatterIsLeadoff: false },
    { completedPlateAppearances: null, currentBatterIsLeadoff: null },
  ]) {
    assert.equal(isStartNotificationFresh({ inningNo: 1, isTop: true, plateAppearance }), false);
  }
});

test("첫 타석 근거: 진행 중만 0PA, 안타/볼넷/HBP/아웃 후 2번 타자는 모두 완료", () => {
  const batter = (name: string, order: number, plateAppearances: number) => ({
    order, name, plateAppearances, isSubstitute: false,
    position: "", positionFull: "", atBats: 0, hits: 0, runs: 0, rbi: 0,
    hr: 0, h2b: 0, h3b: 0, bb: 0, so: 0, sb: 0, avg: ".000",
  });
  assert.deepEqual(
    deriveStartPlateAppearanceEvidence([batter("홍길동", 1, 0), batter("김철수", 2, 0)], "홍길동"),
    { completedPlateAppearances: 0, currentBatterIsLeadoff: true },
  );
  for (const result of ["안타", "볼넷", "HBP", "아웃"]) {
    assert.deepEqual(
      deriveStartPlateAppearanceEvidence([batter("홍길동", 1, 1), batter("김철수", 2, 0)], "김철수"),
      { completedPlateAppearances: 1, currentBatterIsLeadoff: false },
      result,
    );
  }
  assert.equal(deriveStartPlateAppearanceEvidence(null, "홍길동"), null);
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
