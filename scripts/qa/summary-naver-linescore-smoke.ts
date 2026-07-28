/**
 * 요약 canonical source Naver linescore fallback 스모크.
 * KBO GetScoreBoard '-' 이닝 → fetchGameLinescore=null → canonicalGate not-settled(409) 를,
 * game-detail 과 공용인 Naver record scoreBoard 파서로 이닝표를 채워 게이트를 통과시키는지 검증.
 * 실행: npm run qa:summary-naver-linescore
 */
import {
  parseNaverScoreBoardLinescore,
  hasInningBreakdown,
  naverGameId,
} from "../../src/lib/crawler/naver-record";
import { canonicalGate } from "../../src/lib/game-summary/cache-validation";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
}

// ── naverGameId ──
ok("naverGameId 연도 접미", naverGameId("20260728WOLG0") === "20260728WOLG02026");
ok("올스타 9999 접미", naverGameId("20260711WEEA0").startsWith("99990711WEEA0"));

// ── parseNaverScoreBoardLinescore ──
const sb = {
  inn: { away: [0, 1, 0, 2, 0, 0, 0, 0, 0], home: [0, 0, 3, 0, 0, 0, 1, 0, null] },
  rheb: { away: { r: 3, h: 8, e: 0 }, home: { r: 4, h: 9, e: 1 } },
};
const ls = parseNaverScoreBoardLinescore(sb);
ok("scoreBoard → linescore 파싱", !!ls && ls.away.R === 3 && ls.home.R === 4);
ok("이닝 배열 보존", !!ls && ls.away.innings.length === 9 && ls.home.innings[2] === 3);
ok("inn/rheb 부재 → null", parseNaverScoreBoardLinescore({}) === null);
ok("undefined → null", parseNaverScoreBoardLinescore(undefined) === null);

// ── hasInningBreakdown ──
ok("null linescore → false", hasInningBreakdown(null) === false);
ok(
  "이닝 전부 null → false",
  hasInningBreakdown({
    status: "final",
    away: { innings: [null, null], R: 0, H: 0, E: 0 },
    home: { innings: [null, null], R: 0, H: 0, E: 0 },
  }) === false,
);
ok(
  "이닝 값 있음 → true",
  hasInningBreakdown({
    status: "final",
    away: { innings: [0, 1], R: 1, H: 2, E: 0 },
    home: { innings: [null, 0], R: 0, H: 1, E: 0 },
  }) === true,
);

// ── 통합: KBO null linescore → not-settled, Naver fallback synthesize → ok ──
const canonical = { status: "final" as const, awayScore: 3, homeScore: 4 };

// (1) KBO linescore 없음 → canonical-not-settled(409) 재현
const g1 = canonicalGate(canonical, null);
ok("KBO linescore null → not-settled 409", g1.reason === "canonical-not-settled" && g1.httpStatus === 409);

// (2) Naver fallback 을 status:final 로 합성 → 게이트 통과 + fingerprint
const synth = ls ? { status: "final" as const, away: ls.away, home: ls.home } : null;
const g2 = canonicalGate(canonical, synth);
ok("Naver fallback 합성 → ok", g2.reason === "ok" && !!g2.fingerprint);
ok("fingerprint 스코어 반영", !!g2.fingerprint && g2.fingerprint.awayScore === 3 && g2.fingerprint.homeScore === 4);

// (3) 스코어 불일치(#888 stale 교차검증) → not-settled 유지
const mismatch = { status: "final" as const, away: { ...ls!.away, R: 5 }, home: ls!.home };
const g3 = canonicalGate(canonical, mismatch);
ok("Naver R 불일치 → not-settled(교차검증 유지)", g3.reason === "canonical-not-settled");

// (4) 라이브(canonical.status live)면 not-final 이 우선 → fallback 무의미
const g4 = canonicalGate({ ...canonical, status: "live" as const }, synth);
ok("canonical live → not-final(합성 무관)", g4.reason === "not-final");

console.log(`\nsummary naver-linescore fallback: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
