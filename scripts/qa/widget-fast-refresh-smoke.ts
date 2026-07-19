// QA 스모크 — 안드 위젯 fast-refresh(warmup 함수 내부 루프)의 변화 감지 dedupe 판정 검증.
// android-widget-live는 트랜지티브로 supabase 싱글톤을 로드하므로 env 더미 선주입(프로덕션 무변경).
import "./_smoke-env";
import { shouldSkipWidgetPush } from "../../src/lib/notifications/android-widget-live";

let pass = 0;
let fail = 0;
function check(name: string, got: boolean, want: boolean) {
  if (got === want) { pass++; }
  else { fail++; console.error(`✗ ${name}: got ${got}, want ${want}`); }
}

// cycle 0 (dedupe=false) — 시그니처가 같아도 항상 발사(현행 동작 보존).
check("dedupe off, same sig → push", shouldSkipWidgetPush("A", "A", false), false);
check("dedupe off, diff sig → push", shouldSkipWidgetPush("A", "B", false), false);
check("dedupe off, no prev → push", shouldSkipWidgetPush(undefined, "A", false), false);

// fast-loop 추가 사이클 (dedupe=true)
check("dedupe on, no prev → push (첫 발사)", shouldSkipWidgetPush(undefined, "A", true), false);
check("dedupe on, same sig → skip (무변화)", shouldSkipWidgetPush("A", "A", true), true);
check("dedupe on, diff sig → push (변화)", shouldSkipWidgetPush("A", "B", true), false);
check("dedupe on, empty→value → push", shouldSkipWidgetPush("", "A", true), false);
check("dedupe on, same empty → skip", shouldSkipWidgetPush("", "", true), true);

// 실제 payload.data JSON 시그니처 케이스 — 스코어 변화 감지
const base = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "100", w_lastplay: "김현수 안타" });
const sameState = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "100", w_lastplay: "김현수 안타" });
const scored = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "1", w_status: "LIVE 4회초", w_outs: "1", w_diamond: "000", w_lastplay: "오스틴 적시타" });
const newRelay = JSON.stringify({ kind: "game_live", w_as: "1", w_hs: "0", w_status: "LIVE 4회초", w_outs: "2", w_diamond: "100", w_lastplay: "박병호 삼진" });
check("real: 동일 상태 → skip", shouldSkipWidgetPush(base, sameState, true), true);
check("real: 득점 변화 → push", shouldSkipWidgetPush(base, scored, true), false);
check("real: 아웃/중계 변화 → push", shouldSkipWidgetPush(base, newRelay, true), false);

console.log(`\nwidget-fast-refresh smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
