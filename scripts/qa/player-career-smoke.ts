/**
 * 선수 페이지 "통산" 뷰 서비스(player-career) 회귀.
 *
 * 삼순 NO-GO(2026-09-02 #1334) 3축 중 코드 축을 고정한다:
 *  ① identity 대조 — expectedName 이 record.playerName 과 불일치하면 fail-close(null).
 *     KBO 가 같은 playerId 에 다른 선수를 주거나 roster 매핑이 어긋나도 타 선수 통산이
 *     노출되지 않아야 한다.
 *  ② 정규화 계약 — CAREER_METRIC_COLUMNS 등재 지표만 매핑(OPS/WAR/OBP/SLG 등 파생·
 *     미검증 컬럼은 통산 그리드에 절대 새지 않는다).
 *  ③ 소속 이력 압축 — 연속 동일 팀은 한 구간, 팀 이동은 분리.
 *
 * fixture 는 career-series 게이트와 **같은 기계추출 HTML**(최형우 72443 / 임찬규 61101)만 쓴다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCareerTotalsHtml } from "../../src/lib/baseball-qa/stats/career-series";
import { mapCareerRecord } from "../../src/lib/services/player-career";

const here = dirname(fileURLToPath(import.meta.url));
const BATTER_HTML = readFileSync(join(here, "fixtures", "kbo-career-batter.html"), "utf-8");
const PITCHER_HTML = readFileSync(join(here, "fixtures", "kbo-career-pitcher.html"), "utf-8");
const SEASON = 2026;

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}

const batter = parseCareerTotalsHtml(BATTER_HTML, SEASON);
const pitcher = parseCareerTotalsHtml(PITCHER_HTML, SEASON);
assert(batter && pitcher, "fixture parse precondition failed");

// ── ① identity 대조 ─────────────────────────────────────────────────────────
check("① 이름 일치 시 payload 반환", () => {
  const p = mapCareerRecord(batter, "batter", batter.playerName);
  assert(p && p.totals, "expected payload for matching name");
});
check("① 이름 불일치 시 fail-close(null) — 타 선수 통산 노출 차단", () => {
  const p = mapCareerRecord(batter, "batter", "김도영");
  assert.equal(p, null, "mismatched name must fail-close");
});
check("① 공백·대소문자 차이는 흡수(정규화 대조)", () => {
  const spaced = `  ${batter.playerName} `;
  const p = mapCareerRecord(batter, "batter", spaced);
  assert(p && p.totals, "whitespace-only diff must still match");
});
check("① expectedName 미지정 시 대조 생략(하위호환)", () => {
  const p = mapCareerRecord(batter, "batter");
  assert(p && p.totals, "no-name call should not fail-close");
});

// ── ② 정규화 계약 — 미검증 지표 누수 0 ───────────────────────────────────────
check("② 타자 통산에 OPS/OBP/SLG/WAR/wRC+ 누수 없음", () => {
  const p = mapCareerRecord(batter, "batter", batter.playerName)!;
  for (const leaked of ["ops", "obp", "slg", "war", "wrc_plus"]) {
    assert.equal(p.totals![leaked], undefined, `leaked ${leaked}`);
  }
  // 등재 지표는 존재
  for (const k of ["avg", "hits", "hr", "rbi", "games"]) {
    assert(p.totals![k] !== undefined, `missing ${k}`);
  }
});
check("② 투수 통산에 FIP/K9/완투/완봉 누수 없음", () => {
  const p = mapCareerRecord(pitcher, "pitcher", pitcher.playerName)!;
  for (const leaked of ["fip", "k9", "cg", "sho"]) {
    assert.equal(p.totals![leaked], undefined, `leaked ${leaked}`);
  }
  // fixture 통산행에 실재하는 등재 지표만 확인(WHIP 등 컬럼 부재분은 정상 생략).
  for (const k of ["era", "wins", "losses", "so", "games", "ip"]) {
    assert(p.totals![k] !== undefined, `missing ${k}`);
  }
});

// ── ③ 소속 이력 압축 + 연도별 ────────────────────────────────────────────────
check("③ 연속 동일 팀은 한 구간, 팀 이동은 분리", () => {
  const p = mapCareerRecord(batter, "batter", batter.playerName)!;
  assert(p.teams.length >= 1, "expected team spans");
  for (const t of p.teams) assert(t.from <= t.to, `span order ${t.team}`);
  // 인접 구간은 서로 다른 팀이어야 압축이 된 것
  for (let i = 1; i < p.teams.length; i += 1) {
    assert.notEqual(p.teams[i].team, p.teams[i - 1].team, "adjacent spans same team = not compressed");
  }
});
check("③ 연도별 series 오름차순 + seasons 범위 표기", () => {
  const p = mapCareerRecord(batter, "batter", batter.playerName)!;
  assert(p.series.length > 0, "expected series rows");
  for (let i = 1; i < p.series.length; i += 1) {
    assert(p.series[i].year > p.series[i - 1].year, "series must be ascending");
  }
  assert.match(p.totals!.seasons ?? "", /^\d{4}~\d{4}$/, "seasons range format");
});
check("③ 통산행·연도행 모두 없으면 null", () => {
  const empty = { playerName: "테스트", rows: [], career: null };
  assert.equal(mapCareerRecord(empty, "batter", "테스트"), null);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) { console.error("FAILURES:", failures.join(", ")); process.exit(1); }
