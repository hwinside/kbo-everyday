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
import { parseCareerTotalsHtml, type CareerRecord } from "../../src/lib/baseball-qa/stats/career-series";
import { mapCareerRecord, getPlayerCareerResult, resolveExpectedPlayerName, recordIdentityMatches } from "../../src/lib/services/player-career";

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

// ── ① identity 대조 (recordIdentityMatches) ──────────────────────────────────
check("① 정확 일치 → true", () => {
  assert.equal(recordIdentityMatches("최형우", "72443", "최형우"), true);
});
check("① 무관한 선수 → false (타 선수 통산 차단)", () => {
  assert.equal(recordIdentityMatches("김도영", "72443", "최형우"), false);
});
check("① 외국인 KBO 등록명(부분 포함) → true: 웰스⊂라클란 웰스", () => {
  assert.equal(recordIdentityMatches("웰스", "55348", "라클란 웰스"), true);
  assert.equal(recordIdentityMatches("디아즈", "54400", "르윈 디아즈"), true);
  assert.equal(recordIdentityMatches("스기모토", "56011", "스기모토 고우키"), true);
});
check("① 부분 포함 없을 때 유니크 resolve→numericId 일치로 구제", () => {
  // 포함관계가 없는 이름 쌍(record ≠ expected 부분문자열)에서만 fallback 경로 검증.
  const resolveUnique = (n: string) => (n === "스미스" ? { numericId: "53827" } : null);
  assert.equal(recordIdentityMatches("스미스", "53827", "기예르모 에레디아", resolveUnique), true);
  // numericId 불일치면 false
  assert.equal(recordIdentityMatches("스미스", "99999", "기예르모 에레디아", resolveUnique), false);
  // resolve 도 모호면(null) false
  assert.equal(recordIdentityMatches("미상", "53827", "기예르모 에레디아", () => null), false);
});
check("① 1글자 잡음은 포함 판정에서 배제(과잉 매칭 방지)", () => {
  assert.equal(recordIdentityMatches("김", "72443", "최형우", () => null), false);
});

// ── ② UI 공식 컬럼 allowlist — 시즌 UI 공통 지표 노출 + 파생지표 배제 ──────────
check("② 타자 통산에 볼넷·출루율·장타율 노출(시즌 UI 공통)", () => {
  const p = mapCareerRecord(batter, "batter")!;
  for (const k of ["bb", "obp", "slg"]) {
    assert(p.totals![k] !== undefined, `missing UI metric ${k}`);
  }
  for (const k of ["avg", "hits", "hr", "rbi", "games"]) {
    assert(p.totals![k] !== undefined, `missing ${k}`);
  }
  // OPS/WAR/wRC+ 는 통산행에 없거나 파생 → 배제(계산 금지)
  for (const leaked of ["ops", "war", "wrc_plus"]) {
    assert.equal(p.totals![leaked], undefined, `leaked ${leaked}`);
  }
});
check("② 투수 통산에 완투·완봉·볼넷 노출(시즌 UI 공통)", () => {
  const p = mapCareerRecord(pitcher, "pitcher")!;
  for (const k of ["cg", "sho", "bb"]) {
    assert(p.totals![k] !== undefined, `missing UI metric ${k}`);
  }
  for (const k of ["era", "wins", "losses", "so", "games", "ip"]) {
    assert(p.totals![k] !== undefined, `missing ${k}`);
  }
  for (const leaked of ["fip", "k9"]) {
    assert.equal(p.totals![leaked], undefined, `leaked ${leaked}`);
  }
});

// ── ③ 소속 이력 압축 + 연도별 ────────────────────────────────────────────────
check("③ 연속 동일 팀은 한 구간, 팀 이동은 분리", () => {
  const p = mapCareerRecord(batter, "batter")!;
  assert(p.teams.length >= 1, "expected team spans");
  for (const t of p.teams) assert(t.from <= t.to, `span order ${t.team}`);
  // 인접 구간은 서로 다른 팀이어야 압축이 된 것
  for (let i = 1; i < p.teams.length; i += 1) {
    assert.notEqual(p.teams[i].team, p.teams[i - 1].team, "adjacent spans same team = not compressed");
  }
});
check("③ 연도별 series 오름차순 + seasons 범위 표기", () => {
  const p = mapCareerRecord(batter, "batter")!;
  assert(p.series.length > 0, "expected series rows");
  for (let i = 1; i < p.series.length; i += 1) {
    assert(p.series[i].year > p.series[i - 1].year, "series must be ascending");
  }
  assert.match(p.totals!.seasons ?? "", /^\d{4}~\d{4}$/, "seasons range format");
});
check("③ 통산행·연도행 모두 없으면 null", () => {
  const empty = { playerName: "테스트", rows: [], career: null };
  assert.equal(mapCareerRecord(empty, "batter"), null);
});

// ── ①-종단: route→service 실경로 identity 결속 (삼순 #1334 재NO-GO) ──────────
// getPlayerCareerResult 가 서버 roster 로 expectedName 을 정하고 mapCareerRecord 에
// **결속**하는지 종단 검증한다. route 가 name 을 버리거나 서비스가 expectedName 을
// mapCareerRecord 에 넘기지 않으면(=결속 제거 mutation) 아래 identity 테스트가 RED 된다.
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

// roster 정본: 72443 → 최형우 (실제 roster SSOT)
const REAL_ID = "72443";
const realName = resolveExpectedPlayerName(REAL_ID);
check("①-종단 roster 정본화 — kboId→정본 이름 해석", () => {
  assert.equal(realName, batter.playerName, `roster name mismatch: ${realName}`);
});

// 같은 id 인데 KBO 가 다른 선수를 반환하는 상황을 fetcher 로 주입.
function fakeFetcher(record: CareerRecord | null) {
  return async () => record;
}
const wrongRecord: CareerRecord = { playerName: "김도영", rows: batter.rows, career: batter.career };
const foreignRecord: CareerRecord = { playerName: "웰스", rows: batter.rows, career: batter.career };

checkAsync("①-종단 실경로: 정본과 다른 선수 응답이면 payload null (타 선수 통산 차단)", async () => {
  const res = await getPlayerCareerResult(REAL_ID, "타자", { fetcher: fakeFetcher(wrongRecord) });
  assert.equal(res.body.payload, null, "mismatched KBO record must fail-close end-to-end");
});
checkAsync("①-종단 실경로: 정본과 같은 선수면 payload 서빙", async () => {
  const res = await getPlayerCareerResult(REAL_ID, "타자", { fetcher: fakeFetcher(batter) });
  assert(res.body.payload && res.body.payload.totals, "matching record must serve");
});
checkAsync("①-종단 실경로: 외국인(roster 풀네임 vs KBO 등록명)도 서빙", async () => {
  // rawId 55348=라클란 웰스, KBO 응답 playerName=웰스 → 부분 포함으로 통과해야 함
  const res = await getPlayerCareerResult("55348", "타자", {
    fetcher: fakeFetcher(foreignRecord),
    resolveName: () => "라클란 웰스",
  });
  assert(res.body.payload && res.body.payload.totals, "foreign player must serve");
});
checkAsync("①-종단 실경로: roster 미등록 id 는 404 fail-close (오매핑 노출 차단)", async () => {
  const res = await getPlayerCareerResult("99999", "타자", { fetcher: fakeFetcher(batter) });
  assert.equal(res.status, 404, "unknown player must 404");
  assert.equal(res.body.payload, null, "unknown player payload null");
});
checkAsync("①-종단 실경로: 숫자 아닌 id 는 400", async () => {
  const res = await getPlayerCareerResult("abc", "타자", { fetcher: fakeFetcher(batter) });
  assert.equal(res.status, 400);
});

async function main() {
  await Promise.all(asyncChecks.map(async ({ name, fn }) => {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
  }));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) { console.error("FAILURES:", failures.join(", ")); process.exit(1); }
}

void main();
