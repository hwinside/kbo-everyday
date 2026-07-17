/**
 * iOS 홈 위젯 무음 갱신 — 스코어축 상태 판정 스모크 (1.0.9 build 17).
 * 실행: npx tsx scripts/qa/ios-widget-score-state-smoke.ts  (npm run qa:ios-widget)
 *
 * 핵심 계약: 스코어/이닝/아웃/주자 변화 = 다른 상태 문자열(→ 무음 push 발송),
 * 완전 무변화 = 같은 문자열(→ 스킵, iOS 백그라운드 push 예산 절약).
 */
import { iosWidgetScoreState } from "../../src/lib/notifications/ios-widget-policy";
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

// 무변화 → 동일 상태(스킵)
check("무변화 → 동일", iosWidgetScoreState({ ...base }), s0);

// 스코어 변화 → 다름
check("원정 득점 → 다름", iosWidgetScoreState({ ...base, T_SCORE_CN: "4" } as KboRawGame) !== s0, true);
check("홈 득점 → 다름", iosWidgetScoreState({ ...base, B_SCORE_CN: "2" } as KboRawGame) !== s0, true);

// 이닝/초말 변화 → 다름
check("이닝 변화 → 다름", iosWidgetScoreState({ ...base, GAME_INN_NO: 8 } as KboRawGame) !== s0, true);
check("초말 변화 → 다름", iosWidgetScoreState({ ...base, GAME_TB_SC: "B" } as KboRawGame) !== s0, true);

// 아웃/주자 변화 → 다름
check("아웃 변화 → 다름", iosWidgetScoreState({ ...base, OUT_CN: 2 } as KboRawGame) !== s0, true);
check("2루 주자 → 다름", iosWidgetScoreState({ ...base, B2_BAT_ORDER_NO: 3 } as KboRawGame) !== s0, true);

// 아웃 클램프(3→2) — 이닝 종료 전이 안전
check("아웃 3 클램프 2", iosWidgetScoreState({ ...base, OUT_CN: 3 } as KboRawGame),
  iosWidgetScoreState({ ...base, OUT_CN: 2 } as KboRawGame));

// 주자 유무만 반영(순번 무관) — 5번 타자든 9번이든 '주자 있음' 동일
check("주자 순번 무관(있음)", iosWidgetScoreState({ ...base, B1_BAT_ORDER_NO: 9 } as KboRawGame), s0);

console.log(`\nios-widget-score-state-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
