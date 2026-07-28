/**
 * 요약 canonical source Naver linescore fallback 스모크.
 * KBO GetScoreBoard '-' 이닝 → fetchGameLinescore=null → canonicalGate not-settled(409) 를,
 * game-detail 과 공용인 Naver record scoreBoard 파서로 이닝표를 채워 게이트를 통과시키는지 검증.
 * fail-close(빈 이닝표 거부) + 오늘 3경기 실제 Naver 값 exact 회귀 포함.
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

// ── parseNaverScoreBoardLinescore 기본 ──
ok("inn/rheb 부재 → null", parseNaverScoreBoardLinescore({}) === null);
ok("undefined → null", parseNaverScoreBoardLinescore(undefined) === null);

// ── hasInningBreakdown ──
ok("null → false", hasInningBreakdown(null) === false);
ok(
  "이닝 전부 null → false",
  hasInningBreakdown({ away: { innings: [null, null] }, home: { innings: [null, null] } }) === false,
);
ok(
  "이닝 값 있음 → true",
  hasInningBreakdown({ away: { innings: [0, 1] }, home: { innings: [null, 0] } }) === true,
);

// ── fail-close: sb.inn 객체는 있어도 이닝값 전부 null → fetchNaverLinescore 가 null 반환해야 함 ──
// (fetchNaverLinescore 는 parse 결과에 hasInningBreakdown 을 적용한다 — 그 조합을 검증)
const emptyInnSb = {
  inn: { away: [null, null, null], home: [null, null, null] },
  rheb: { away: { r: 0, h: 0, e: 0 }, home: { r: 0, h: 0, e: 0 } },
};
const emptyParsed = parseNaverScoreBoardLinescore(emptyInnSb);
ok("빈 이닝 parse 는 객체 반환(R 존재)", !!emptyParsed);
ok("빈 이닝 → hasInningBreakdown false(fail-close 신호)", hasInningBreakdown(emptyParsed) === false);

// ── 오늘 3경기 실제 Naver scoreBoard 값 (exact 회귀) ──
const GAMES = [
  {
    id: "WOLG",
    away: 3,
    home: 5,
    sb: {
      inn: { away: [0, 0, 1, 0, 0, 0, 2, 0, 0], home: [0, 0, 0, 2, 1, 0, 2, 0] },
      rheb: { away: { r: 3, h: 8, e: 3 }, home: { r: 5, h: 7, e: 0 } },
    },
    // 홈(LG) 리드로 9회말 미실시 → 홈 이닝 8칸 보존
    homeInnLen: 8,
    awayInnLen: 9,
  },
  {
    id: "OBSK",
    away: 2,
    home: 1,
    sb: {
      inn: { away: [0, 0, 0, 0, 0, 0, 1, 0, 0, 1], home: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      rheb: { away: { r: 2, h: 10, e: 1 }, home: { r: 1, h: 4, e: 0 } },
    },
    // 연장 10회
    homeInnLen: 10,
    awayInnLen: 10,
  },
  {
    id: "KTNC",
    away: 10,
    home: 0,
    sb: {
      inn: { away: [1, 0, 0, 0, 3, 1, 0, 0, 5], home: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      rheb: { away: { r: 10, h: 11, e: 0 }, home: { r: 0, h: 2, e: 2 } },
    },
    homeInnLen: 9,
    awayInnLen: 9,
  },
];

for (const g of GAMES) {
  const ls = parseNaverScoreBoardLinescore(g.sb);
  ok(`${g.id}: parse R 일치`, !!ls && ls.away.R === g.away && ls.home.R === g.home);
  ok(`${g.id}: 이닝 합 = R`, !!ls && ls.away.innings.reduce((s, v) => s + (v ?? 0), 0) === g.away && ls.home.innings.reduce((s, v) => s + (v ?? 0), 0) === g.home);
  ok(`${g.id}: 이닝 칸수 보존(away ${g.awayInnLen}/home ${g.homeInnLen})`, !!ls && ls.away.innings.length === g.awayInnLen && ls.home.innings.length === g.homeInnLen);
  ok(`${g.id}: 이닝값 있음 → hasInningBreakdown true`, hasInningBreakdown(ls) === true);

  const canonical = { status: "final" as const, awayScore: g.away, homeScore: g.home };
  // KBO linescore null → not-settled(409) 재현
  ok(`${g.id}: KBO null → not-settled 409`, canonicalGate(canonical, null).reason === "canonical-not-settled");
  // Naver 합성(status:final) → 게이트 ok + fingerprint 이닝 보존
  const synth = ls ? { status: "final" as const, away: ls.away, home: ls.home } : null;
  const gate = canonicalGate(canonical, synth);
  ok(`${g.id}: Naver 합성 → ok + fingerprint`, gate.reason === "ok" && !!gate.fingerprint);
  ok(`${g.id}: fingerprint 이닝 배열 보존`, !!gate.fingerprint && gate.fingerprint.homeInnings.length === g.homeInnLen && gate.fingerprint.awayInnings.length === g.awayInnLen);
}

// ── 경기목록 score mismatch → not-settled(#888 stale 교차검증 유지) ──
const wolg = parseNaverScoreBoardLinescore(GAMES[0].sb)!;
const mismatch = canonicalGate(
  { status: "final", awayScore: 9, homeScore: 5 }, // 목록 3-5 인데 9 로 불일치
  { status: "final", away: wolg.away, home: wolg.home },
);
ok("목록 score mismatch → not-settled", mismatch.reason === "canonical-not-settled");

// ── canonical live → not-final 우선(합성 무관) ──
ok(
  "canonical live → not-final",
  canonicalGate(
    { status: "live", awayScore: 3, homeScore: 5 },
    { status: "final", away: wolg.away, home: wolg.home },
  ).reason === "not-final",
);

console.log(`\nsummary naver-linescore fallback: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
