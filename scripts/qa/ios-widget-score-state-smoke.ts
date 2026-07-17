/**
 * iOS 홈 위젯 무음 갱신 — 정책 스모크 (1.0.9 build 17, 삼순 #674 NO-GO 반영판).
 * 실행: npm run qa:ios-widget
 *
 * 계약(삼순 blocker①③④):
 *  ① dedupe 키 = 점수만 — 이닝/아웃/주자 변화는 발송 트리거 아님(예산: 경기당 ~10-25회)
 *  ③ 지연/역순 배달 fence — new→old, final→old 거부 (Swift markLiveScore와 동치 미러)
 *  ④ 커서 claim/revert — CAS 판정 + transient 실패 bounded retry(상한 후 전진 유지)
 */
import {
  iosWidgetScoreState,
  decideWidgetPushClaim,
  widgetTransientFailures,
  shouldRevertWidgetCursor,
  shouldApplyWidgetLiveEvent,
  shouldPreserveWidgetFence,
  WIDGET_PUSH_MAX_RETRIES,
  WIDGET_RETRY_SENTINEL,
} from "../../src/lib/notifications/ios-widget-policy";
import type { KboRawGame } from "../../src/types/api";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

const base = {
  G_ID: "20260718LGKT0",
  T_SCORE_CN: "3", B_SCORE_CN: "1",
  GAME_INN_NO: 7, GAME_TB_SC: "T",
  OUT_CN: 1,
  B1_BAT_ORDER_NO: 5, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
} as unknown as KboRawGame;

const s0 = iosWidgetScoreState(base);

// ── ① dedupe 키 = 점수만 ──────────────────────────────────────────────
check("무변화 → 동일", iosWidgetScoreState({ ...base }), s0);
check("원정 득점 → 다름", iosWidgetScoreState({ ...base, T_SCORE_CN: "4" } as KboRawGame) !== s0, true);
check("홈 득점 → 다름", iosWidgetScoreState({ ...base, B_SCORE_CN: "2" } as KboRawGame) !== s0, true);
// 발송 상한의 핵심 — 점수 외 축은 전부 *같은* 키(발송 트리거 아님)
check("이닝 변화 → 동일(발송 안 함)", iosWidgetScoreState({ ...base, GAME_INN_NO: 8 } as KboRawGame), s0);
check("초말 변화 → 동일(발송 안 함)", iosWidgetScoreState({ ...base, GAME_TB_SC: "B" } as KboRawGame), s0);
check("아웃 변화 → 동일(발송 안 함)", iosWidgetScoreState({ ...base, OUT_CN: 2 } as KboRawGame), s0);
check("주자 변화 → 동일(발송 안 함)", iosWidgetScoreState({ ...base, B2_BAT_ORDER_NO: 3 } as KboRawGame), s0);
check("점수 파싱 실패 → 0 처리", iosWidgetScoreState({ ...base, T_SCORE_CN: undefined } as unknown as KboRawGame), "0|1");

// ── ④ 커서 claim 판정 ────────────────────────────────────────────────
check("row 없음 → claim-insert(최초 live 1회)", decideWidgetPushClaim(null, "0|0"), "claim-insert");
check("같은 점수 → skip", decideWidgetPushClaim("3|1", "3|1"), "skip");
check("점수 변화 → claim-update", decideWidgetPushClaim("3|1", "4|1"), "claim-update");
check("retry sentinel → claim-update(재시도 경로)", decideWidgetPushClaim(WIDGET_RETRY_SENTINEL, "3|1"), "claim-update");

// ── ④ transient 실패 판정 + bounded retry ────────────────────────────
check("전량 성공 → transient 0", widgetTransientFailures({ ok: true, failed: 0, cleaned: 0 }), 0);
check("invalid 정리분만 → transient 0(전진 확정)", widgetTransientFailures({ ok: true, failed: 3, cleaned: 3 }), 0);
check("invalid 외 실패 잔존 → transient>0", widgetTransientFailures({ ok: true, failed: 5, cleaned: 3 }), 2);
check("인프라 실패(ok:false) → transient 취급", widgetTransientFailures({ ok: false, failed: 0, cleaned: 0 }), 1);
check("attempts 0 → revert(재시도)", shouldRevertWidgetCursor(0), true);
check("attempts 1 → revert(재시도)", shouldRevertWidgetCursor(1), true);
check(`attempts ${WIDGET_PUSH_MAX_RETRIES} = 상한 → 전진 유지(포기)`, shouldRevertWidgetCursor(WIDGET_PUSH_MAX_RETRIES), false);

// ── ③ 지연/역순 배달 fence (Swift markLiveScore 미러 — 삼순 지정 순서 테스트) ──
check("최초 이벤트(stored 없음) → 적용", shouldApplyWidgetLiveEvent(null, 1000, false), true);
check("new → old: 늦은 옛 push(≤) 거부", shouldApplyWidgetLiveEvent(2000, 1000, false), false);
check("동일 시각(중복 배달) 거부", shouldApplyWidgetLiveEvent(2000, 2000, false), false);
check("정순 배달(더 새 이벤트) 적용", shouldApplyWidgetLiveEvent(1000, 2000, false), true);
check("final → old: 종료 카드에 늦은 live 거부", shouldApplyWidgetLiveEvent(1000, 2000, true), false);
check("파싱 실패(eventMs 0) + stored 존재 → 거부", shouldApplyWidgetLiveEvent(1000, 0, false), false);

// ── 교차-writer fence 보존 (삼순 재리뷰 blocker① — Swift write() 미러) ───────
check("same-game + fence 없는 write(JS/LA) → 보존", shouldPreserveWidgetFence("20260718LGKT0", "20260718LGKT0", false), true);
check("다른 경기 write → 리셋(보존 안 함)", shouldPreserveWidgetFence("20260718LGKT0", "20260719LGKT0", false), false);
check("markLiveScore(명시 전진) → 자기 값 사용", shouldPreserveWidgetFence("20260718LGKT0", "20260718LGKT0", true), false);
check("기존 스냅샷 없음 → 보존 대상 없음", shouldPreserveWidgetFence(null, "20260718LGKT0", false), false);
// 삼순 지정 회귀 시나리오: new push(ev=2000) → same-game JS/LA write(fence 보존) → old push(ev=1000) 거부
{
  const storedAfterPush = 2000; // new push 적용
  const preserved = shouldPreserveWidgetFence("20260718LGKT0", "20260718LGKT0", false)
    ? storedAfterPush
    : null; // 보존 안 됐다면 fence 소실(구 버전 버그 재현)
  check("회귀 시나리오: same-game write 후에도 old push(1000) 거부", shouldApplyWidgetLiveEvent(preserved, 1000, false), false);
}

console.log(`\nios-widget-score-state-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
