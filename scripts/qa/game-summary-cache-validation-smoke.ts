#!/usr/bin/env tsx
/**
 * QA: AI 경기 요약 캐시/생성 게이트 회귀 (삼순 #888 blocker①②③).
 *
 * 2026-07-26 사고: LG-한화 라이브 8회 4-4 스냅샷으로 recap 생성·캐시 → 최종 14-4로
 * 갱신됐는데 캐시 not-outdated 라 ~48분간 "4-4 무승부" 오답 노출.
 *
 * 시나리오: live/8회초·final stale body·홈팀 리드 9회말 null·연장·콜드/더블헤더·
 *          임의 POST poison·legacy cache·score mismatch 에서 stale 0초 노출.
 */

import {
  canonicalGate,
  isFingerprintStale,
  shouldHideStaleCache,
  winnerFieldMismatch,
  type CanonicalGameState,
} from "../../src/lib/game-summary/cache-validation";

let pass = 0;
let fail = 0;
function ok(desc: string, cond: boolean) {
  if (cond) { pass++; console.log(`✓ ${desc}`); }
  else { fail++; console.log(`✗ ${desc}`); }
}

const g = (status: CanonicalGameState["status"], a: number | null, h: number | null): CanonicalGameState =>
  ({ status, awayScore: a, homeScore: h });

// ── blocker①: canonicalGate (fail-close) ────────────────────────────────────
console.log("[① canonicalGate — 서버 독립 검증 fail-close]");
ok("live 8회초(미확정) → 409 not-final", canonicalGate(g("live", 4, 4), 4, 4).reason === "not-final");
ok("scheduled → 409 not-final", canonicalGate(g("scheduled", null, null), 0, 0).reason === "not-final");
ok("cancelled → 409 not-final", canonicalGate(g("cancelled", 0, 0), 0, 0).reason === "not-final");
ok("canonical 미확보 → 503", canonicalGate(undefined, 4, 4).reason === "canonical-unavailable");
ok("final + body 스코어 불일치(stale 4-4 vs canonical 14-4) → 422", canonicalGate(g("final", 4, 14), 4, 4).reason === "score-mismatch");
ok("final + 임의 POST poison(9-9) → 422", canonicalGate(g("final", 4, 14), 9, 9).reason === "score-mismatch");
ok("final + body 일치 → ok", canonicalGate(g("final", 14, 4), 14, 4).reason === "ok");
// 콜드/더블헤더/홈리드 9말생략/연장은 status='final'+정확 스코어로만 판정(이닝 하드코딩 없음)
ok("콜드게임 5-0 final(6회 종료) → status 기반 ok", canonicalGate(g("final", 0, 5), 0, 5).reason === "ok");
ok("홈팀 리드 9말 생략 3-2 final → ok", canonicalGate(g("final", 2, 3), 2, 3).reason === "ok");
ok("연장 12회 6-5 final → ok", canonicalGate(g("final", 5, 6), 5, 6).reason === "ok");
ok("httpStatus 매핑: not-final=409", canonicalGate(g("live", 1, 0), 1, 0).httpStatus === 409);
ok("httpStatus 매핑: score-mismatch=422", canonicalGate(g("final", 1, 0), 0, 0).httpStatus === 422);
ok("httpStatus 매핑: unavailable=503", canonicalGate(undefined, 0, 0).httpStatus === 503);

// ── blocker②: isFingerprintStale + shouldHideStaleCache ──────────────────────
console.log("[② fingerprint stale + hide-before-regenerate]");
ok("fingerprint 일치 → not stale", isFingerprintStale(14, 4, 14, 4) === false);
ok("fingerprint 불일치(4-4 캐시 vs 14-4 최종) → stale", isFingerprintStale(4, 4, 14, 4) === true);
ok("legacy fingerprint 없음(null) → stale", isFingerprintStale(undefined, undefined, 14, 4) === true);
ok("legacy 한쪽만 null → stale", isFingerprintStale(4, undefined, 4, 4) === true);
// hide: final 스코어를 알 때 stale/legacy면 숨김
ok("final known + stale(4-4 캐시) → hide", shouldHideStaleCache(true, 4, 4, 14, 4) === true);
ok("final known + legacy(null) → hide", shouldHideStaleCache(true, null, null, 14, 4) === true);
ok("final known + fingerprint 일치 → 노출(hide 안 함)", shouldHideStaleCache(true, 14, 4, 14, 4) === false);
ok("final 미확정(스코어 unknown) → 노출(진행 중 화면)", shouldHideStaleCache(false, 4, 4, null, null) === false);
ok("final known 이나 스코어 null → 노출(비교 불가)", shouldHideStaleCache(true, 4, 4, null, 4) === false);

// ── blocker③: winnerFieldMismatch (무승부 loophole) ──────────────────────────
console.log("[③ winner 필드/무승부 문구 검증]");
// non-draw: winner 필드 exact 일치 (한화 home 14 승, LG away 4 — gameId LGHH: away=LG, home=한화)
ok("non-draw + llmWinner='무승부'(오답) → mismatch (loophole 닫힘)",
  winnerFieldMismatch(4, 14, "LG", "한화", "무승부", "한화 14-4 대승") === true);
ok("non-draw + 헤드라인 '4-4 무승부'(2026-07-26 사고) → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", "한화", "LG, 박동원 동점포로 한화와 4-4 무승부") === true);
ok("non-draw + 헤드라인 '동점으로 마무리' → mismatch",
  winnerFieldMismatch(3, 5, "KT", "롯데", "롯데", "치열한 접전 동점으로 마무리") === true);
ok("non-draw + winner exact 일치 + 정상 헤드라인 → pass",
  winnerFieldMismatch(4, 14, "LG", "한화", "한화", "한화, 8회 10득점 폭발 LG에 14-4 대승") === false);
ok("non-draw + winner 반대 팀 → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", "LG", "한화 14-4 대승") === true);
ok("non-draw + winner 필드 부재 + 정상 헤드라인 → pass(헤드라인 검사는 호출부 loserClaimedWin)",
  winnerFieldMismatch(4, 14, "LG", "한화", undefined, "한화 대승") === false);
// draw: winner='무승부'만 허용
ok("draw + llmWinner='무승부' → pass", winnerFieldMismatch(4, 4, "LG", "한화", "무승부", "4-4 무승부") === false);
ok("draw + llmWinner=특정팀(오답) → mismatch(역방향)", winnerFieldMismatch(4, 4, "LG", "한화", "한화", "무승부") === true);
ok("draw + winner 부재 → pass", winnerFieldMismatch(4, 4, "LG", "한화", undefined, "4-4 무승부") === false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) { console.error(`FAIL: ${fail} case(s)`); process.exit(1); }
