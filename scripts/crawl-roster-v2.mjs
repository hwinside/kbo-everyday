#!/usr/bin/env node
/**
 * KBO 로스터 크롤링 v2 - 기록 페이지(HitterBasic + PitcherBasic) 팀별 필터로 선수 추출
 * KBO 로스터 페이지(/Team/Roster.aspx)가 다운됨 → 기록 페이지에서 추출
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { preserveExistingRosterPlayers } from "./lib/roster-preservation.mjs";
import {
  TEAM_FAIL_REASONS,
  buildPhaseBaseline,
  classifyEndRequest,
  evaluateTeamCollection,
  evaluateSetStability,
  evaluateRosterCompletion,
  buildExpectedSlotKeys,
  phaseFiltersTrusted,
  formatCompletionFailure,
} from "./lib/roster-crawl-completion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const TEAMS = [
  ["HT", "KIA", 6], ["OB", "두산", 2], ["LT", "롯데", 7],
  ["SS", "삼성", 8], ["SK", "SSG", 4], ["NC", "NC", 5],
  ["HH", "한화", 9], ["WO", "키움", 10], ["LG", "LG", 1], ["KT", "KT", 3],
];

// Load existing roster for merging
let existingRoster = [];
try {
  existingRoster = JSON.parse(readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8"));
} catch { /* first run */ }

const existingMap = new Map();
for (const p of existingRoster) {
  if (p.kboId) existingMap.set(String(p.kboId), p);
}

const foreignMapSource = readFileSync(join(CONSTANTS_DIR, "foreign-id-map.ts"), "utf-8");
const FOREIGN_NUMERIC_TO_ALPHA = Object.fromEntries(
  [...foreignMapSource.matchAll(/"(\d+)":\s*"((?:FP|AQ)\d+)"/g)].map((m) => [m[1], m[2]])
);

function canonicalKboId(playerId) {
  return FOREIGN_NUMERIC_TO_ALPHA[playerId] || playerId;
}

function existingFor(playerId) {
  return existingMap.get(canonicalKboId(playerId)) || existingMap.get(playerId);
}

function upsertScrapedPlayer(allPlayers, { playerId, name, teamId, teamName, position }) {
  const canonicalId = canonicalKboId(playerId);
  const existing = existingFor(playerId);
  const prev = allPlayers.get(canonicalId);

  allPlayers.set(canonicalId, {
    ...prev,
    name: existing?.name || prev?.name || name,
    kboId: canonicalId,
    teamId,
    team: teamName,
    position: position || prev?.position || existing?.position || "야수",
    backNo: existing?.backNo || prev?.backNo || "",
    // 생년월일은 상세페이지 방문에서만 채워지므로 기존값 보존 (전수 재방문 방지).
    birthDate: existing?.birthDate ?? prev?.birthDate ?? null,
    _numericId: /^\d+$/.test(playerId) ? playerId : prev?._numericId,
  });
}

// "2000년 07월 12일" -> "2000-07-12"
function parseKboBirthday(text) {
  const m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(text || "");
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 셀렉트를 바꾸고 표가 갱신될 때까지 기다린다.
 * @returns {Promise<boolean>} 셀렉트가 *실제로* 요청값을 들고 있는지.
 *   false 면 화면이 직전 팀 데이터일 수 있으므로 그 수집 결과를 신뢰하면 안 된다.
 *   (기존 판은 timeout 시 조용히 진행해 직전 팀 표를 그대로 긁었다.)
 */
/**
 * ASP.NET AJAX **응답 에포크** 카운터를 설치한다.
 *
 * 이 페이지는 UpdatePanel(`...udpContent`) 기반 **부분 포스트백**이다(실측:
 * `Sys.WebForms.PageRequestManager` 존재, 팀 전환 시 POST 1건, `framenavigated` 0).
 * 그래서 "서버 응답이 실제로 왔는가"를 `endRequest` 로 직접 셀 수 있다.
 *
 * ⚠︎ 이게 필요한 이유(삼순 NO-GO 3차 ①): 종전 `changeSelectAndWait` 는 표 전이가
 * timeout 돼도 마지막에 `settled === value` 만 보고 true 를 돌렸다. select 값은
 * 브라우저가 즉시 반영하므로 **서버 응답 없이도 항상 true** 가 된다.
 * 그러면 reset 이 실패해도 같은 팀 stale 표를 두 번 읽고 "집합 동일"로 통과한다.
 */
/**
 * 서버 응답 epoch 훅 설치.
 *
 * 이것이 **유일한 재조회 증거**다. 표시값(select value, 페이저 `on`, 첫행 텍스트)은
 * 전부 브라우저 로컬 상태라 서버가 응답하지 않아도 "바뀌었다"로 보일 수 있다.
 *
 * PRM 은 페이지 스크립트가 다 돌아야 생기므로 잠시 폴링해 기다린다.
 * 그래도 없으면 **검증 불가 → fail-close** — 호출측이 약한 근거로 대체하지 않는다.
 */
async function installRequestEpoch(page, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // 판정 함수 원본을 페이지에 주입한다(게이트가 테스트하는 그 함수 그대로).
  await page
    .evaluate((src) => {
      // eslint-disable-next-line no-new-func
      window.__kboClassifyEndRequest = new Function(`return (${src})`)();
    }, classifyEndRequest.toString())
    .catch(() => {});
  const ready = await page
    .evaluate(() => typeof window.__kboClassifyEndRequest === "function")
    .catch(() => false);
  // 판정 함수를 못 심었으면 재조회 증거를 만들 수 없다 → fail-close.
  if (!ready) return false;
  for (;;) {
    const ok = await page
      .evaluate(() => {
        if (window.__kboEpochInstalled) return true;
        const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.();
        if (!prm) return false;
        window.__kboEpoch = 0;
        window.__kboEpochError = 0;
        // ⚠︎ `endRequest` 는 성공 전용이 아니다 — 오류로 끝난 부분 포스트백도 발화한다.
        // (MS: Working with PageRequestManager Events — EndRequestEventArgs.get_error())
        // 오류까지 epoch 으로 세면 "서버가 응답했다"는 증거가 되지 못해,
        // 실패한 reset/select/1번클릭 뒤에도 로컬 select 값·표시 `on` · 같은 팀 stale 표로
        // 두 집합이 동일하게 통과할 수 있다. **오류 없는 응답만** 세서야 가설이 성립한다.
        //
        // 판정 자체는 페이지에 주입된 `window.__kboClassifyEndRequest` 가 한다.
        // 그 함수는 lib 의 `classifyEndRequest` 원본이고, 게이트가 **같은 함수를
        // 직접 호출해** 행동 매트릭스를 검증한다 — 인라인으로 두면 게이트가 소스
        // 문자열만 보게 돼서 6차 NO-GO(optional call fail-open)를 또 놓친다.
        prm.add_endRequest((sender, args) => {
          const verdict = window.__kboClassifyEndRequest(args);
          if (verdict !== "success") {
            window.__kboEpochError = (window.__kboEpochError || 0) + 1;
            return;
          }
          window.__kboEpoch = (window.__kboEpoch || 0) + 1;
        });
        window.__kboEpochInstalled = true;
        return true;
      })
      .catch(() => false);
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

/**
 * 셀렉트를 바꾸고 **서버 응답이 실제로 도착할 때까지** 기다린다.
 *
 * @returns {Promise<boolean>} 전이가 증명됐는지. timeout 은 **false** 다(종전에는 true 였다).
 *   증거 우선순위: ① epoch 증가(서버 응답 도착) ② epoch 미설치 시에만 표 변화 fallback.
 *   표 변화만 쓰면 "생성 결과가 우연히 같은" 팀(예: 전체→롯데)에서 오판이 난다.
 */
async function changeSelectAndWait(page, selector, value, waitMs = 8000) {
  const current = await page.$eval(selector, (el) => el.value).catch(() => null);
  if (current === value) return true;

  // epoch 을 못 쓰면 재조회를 증명할 수단이 없다 → fail-close.
  // 첫행 변화 폴백은 쓰지 않는다: 같은 팀을 다시 고르거나 결과가 같으면 영원히 false 이고,
  // 반대로 부분 렌더만 으로도 true 가 돼 양쪽 모두 틀린다.
  if (!(await installRequestEpoch(page))) return false;
  const epochBefore = await page.evaluate(() => window.__kboEpoch ?? 0).catch(() => null);
  if (epochBefore === null) return false;

  await page.selectOption(selector, value);

  const advanced = await page
    .waitForFunction(
      ({ selector, value, epochBefore }) => {
        const el = document.querySelector(selector);
        if (!el || el.value !== value) return false;
        // 서버 응답이 한 번 더 끝난 것이 유일한 재조회 증거다.
        return (window.__kboEpoch ?? 0) > epochBefore;
      },
      { selector, value, epochBefore },
      { timeout: waitMs }
    )
    .then(() => true)
    .catch(() => false);

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);

  // 전이 증거가 없으면 셀렉트 값과 무관하게 실패다 — stale 표를 들고 있을 수 있다.
  if (!advanced) return false;

  const settled = await page.$eval(selector, (el) => el.value).catch(() => null);
  return settled === value;
}

/**
 * phase 시작 전 series(정규시즌)·season(2026) 셀렉트를 건다.
 *
 * ⚠︎ 삼순 NO-GO ①: `changeSelectAndWait` 반환을 반드시 확인한다. 종전엔 반환을
 * 버려 season 전이가 실패해도(이전 연도/default 표) 팀 루프를 그대로 돌았고,
 * team witness 는 연도를 못 보므로 잘못된 연도 표 전체가 완주 계약을 통과했다.
 * 판정은 순수함수 phaseFiltersTrusted() 에 위임한다(게이트가 행동을 직접 검증하도록).
 *
 * @returns {Promise<boolean>} 전이가 신뢰 가능하면 true. false 면 호출측이 phase 전체를 fail-close 해야 한다.
 */
async function setupPhaseFilters(page, { seasonSel, seriesSel }) {
  const hasSeries = Boolean(await page.$(seriesSel));
  let seriesConfirmed = true;
  if (hasSeries) {
    seriesConfirmed = await changeSelectAndWait(page, seriesSel, "0", 5000);
  }
  const seasonConfirmed = await changeSelectAndWait(page, seasonSel, "2026", 8000);
  return phaseFiltersTrusted({ hasSeries, seriesConfirmed, seasonConfirmed });
}

/** season/series 전이 실패 시 phase 전 팀을 fail-close 하는 outcome. */
function phaseFilterFailureOutcome(teamName, teamId, phase) {
  return {
    teamName,
    teamId,
    phase,
    attempts: 0,
    result: {
      ok: false,
      reason: TEAM_FAIL_REASONS.SELECT_UNCONFIRMED,
      detail: "season/series 전이 실패 — 이전 연도 표일 수 있어 phase 전체 fail-close",
    },
  };
}

/**
 * 팀 1개를 완주 계약 아래에서 수집한다. 실패 사유가 있으면 bounded retry.
 * 수집된 행은 판정이 ok 일 때만 반영한다 — 오염 데이터를 넣고 나중에 되돌리지 않는다.
 */
async function collectTeamWithContract({
  page,
  teamSel,
  teamCode,
  teamName,
  teamId,
  phase,
  baseline,
  applyRows,
  maxAttempts = 3,
}) {
  let result = null;
  let attempts = 0;

  /**
   * 필터를 비운 뒤 다시 걸어 **독립적으로** 한 번 수집하고, 그 회차 자체를 완전히 판정한다.
   *
   * ⚠︎ reset 결과를 버리면 안 된다(삼순 NO-GO 2). 비우기가 실패한 채로 진행하면
   * `changeSelectAndWait` 가 현재값(이미 teamCode)에서 즉시 true 를 돌려줘
   * "독립 재조회"가 사실은 **같은 표를 다시 읽는 것**이 된다.
   */
  const collectPass = async () => {
    const resetOk = await changeSelectAndWait(page, teamSel, "", 5000).catch(() => false);
    if (!resetOk) {
      return {
        usable: [],
        verdict: {
          ok: false,
          reason: TEAM_FAIL_REASONS.SELECT_UNCONFIRMED,
          detail: "필터 reset 실패 — 이전 팀 표를 그대로 재독할 수 있음",
        },
      };
    }
    await page.waitForTimeout(800);

    // ⚠︎ 팀을 바꾸기 *전에* 페이저를 1페이지로 되돌린다.
    // KBO 그리드는 팀 전환 시 페이지 인덱스를 유지하므로, 직전 팀을 2페이지까지
    // 읽고 단일 페이지 팀으로 넘어가면 **빈 표**가 뜼다(dry-run 실측: KIA rows=0).
    // 순회 순서에 따라 특정 팀만 사라지는 사고였고, 종전 크롤러는 그걸 그대로 저장했다.
    await ensureFirstPage(page);

    const selectConfirmed = await changeSelectAndWait(page, teamSel, teamCode, 8000);
    const scraped = selectConfirmed
      ? await scrapeAllPages(page)
      : { rows: [], pagerComplete: false };
    const usable = selectConfirmed ? toUsableRows(scraped.rows) : [];

    // 매 회차가 자체적으로 team witness · pager · 중복 · floor · drop 을 전부 통과해야 한다.
    const verdict = evaluateTeamCollection({
      selectConfirmed,
      requestedTeamName: teamName,
      observedTeamNames: usable.map((r) => r.teamNameCell),
      collected: usable.length,
      uniqueIds: new Set(usable.map((r) => r.playerId)).size,
      pagerComplete: scraped.pagerComplete,
      baseline,
    });
    return { usable, verdict };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    if (attempt > 1) await page.waitForTimeout(1500);

    const first = await collectPass();
    result = first.verdict;

    // 1차가 통과했을 때만 독립 재조회로 집합 안정성을 본다.
    // KBO 는 같은 순간에도 조회마다 다른 행 집합을 주는 일이 있다(#1103).
    if (result.ok) {
      const second = await collectPass();
      // 2차 자체 판정도 통과해야 한다 — ID 집합만 비교하면 2차의 팀 오염·부분수집을 못 본다.
      result = second.verdict.ok
        ? evaluateSetStability(
            first.usable.map((r) => r.playerId),
            second.usable.map((r) => r.playerId)
          )
        : second.verdict;
    }

    if (result.ok) {
      applyRows(first.usable, teamId, teamName);
      console.log(`    → ${first.usable.length}명 (시도 ${attempt}, 재조회 동일)`);
      break;
    }

    console.log(`    ⚠️ ${teamName} 수집 판정 실패: ${result.reason} (${result.detail}) — 시도 ${attempt}/${maxAttempts}`);
  }

  await changeSelectAndWait(page, teamSel, "", 5000).catch(() => {});
  return { teamName, teamId, phase, result, attempts };
}

/**
 * 페이저를 끝까지 돌며 전 행을 수집한다.
 *
 * @returns {Promise<{rows: object[], pagerComplete: boolean, reason: string}>}
 *   `pagerComplete=false` 는 **quiet EOF** — 중간에서 끊겼다는 뜻이다.
 *   기존 판은 중간 0행과 정상 종료를 둘 다 `break` 로 똑같이 처리해
 *   부분 수집을 완주로 오인했다.
 */
/**
 * 표가 **안정될 때까지** 기다린다. 행 수가 0이 아니고 연속 두 번 같아야 읽는다.
 *
 * ⚠︎ 필수 — dry-run 실측으로 발견한 결손. 셀렉트 전환 직후·페이저 클릭 직후에는
 * ASP.NET 부분 포스트백이 끝나기 전 표가 **빈 상태 또는 절반만 렌더된 상태**로 있다.
 * `networkidle` + 고정 대기만으로는 부족해, 실측에서 두산이 `10행/5고유`(같은 페이지 중복),
 * KIA 가 `0행`으로 잡혔다. 같은 순간 독립 관측은 둘 다 30행/30고유였으므로
 * KBO 문제가 아니라 읽는 시점의 문제다.
 */
async function waitForTableSettled(page, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  let stableHits = 0;
  while (Date.now() - started < timeoutMs) {
    // 행 수만 보면 부분 렌더가 우연히 같은 수로 멈춰 있을 때 "안정"으로 오인한다.
    // 실측: 두산이 5행 상태로 잠시 멈춰 있다 30행으로 차는데, 그 5행을 읽어
    // 같은 페이지를 두 번 수집(10행/5고유)하는 사고가 재현됐다.
    // 그래서 행 수 + 첫행 + 끝행 텍스트를 함께 보고, 연속 3회 동일을 요구한다.
    const sig = await page
      .$$eval("tbody tr", (trs) => {
        if (trs.length === 0) return "0|";
        const first = trs[0].textContent?.trim() || "";
        const last = trs[trs.length - 1].textContent?.trim() || "";
        return `${trs.length}|${first}|${last}`;
      })
      .catch(() => null);

    if (sig && !sig.startsWith("0|") && sig === last) {
      stableHits++;
      if (stableHits >= 3) return true;
    } else {
      stableHits = 0;
    }
    last = sig;
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * 수집 시작 전 페이저를 **1페이지로 되돌린다.**
 *
 * ⚠︎ 근본 결손 — dry-run 실측으로 확정. KBO 그리드는 팀 필터를 바꿔도
 * **페이지 인덱스를 유지**한다. 그래서 A팀을 2페이지까지 읽고 B팀으로 전환하면
 * B팀의 **2페이지**를 보게 된다. B팀이 1페이지뿐이면 빈 표(0행)가 나온다.
 *
 * 실측 기록(팀 순회 LG→두산→KIA):
 *   두산 page2 클릭 후 → on=2
 *   KIA select 후  → rows=0 pages=[1]   ← 빈 페이지
 * 이게 `empty` / `duplicate_ids` 사고의 직접 원인이었고,
 * 종전 크롤러는 이를 그대로 저장해 roster 가 조용히 비거나 중복됐다.
 */
async function ensureFirstPage(page) {
  const first = page.locator('a[id*="ucPager_btnNo"]').filter({ hasText: /^1$/ }).first();
  // 페이저 자체가 없으면 단일 페이지다.
  if (!(await first.count())) return true;

  // ⚠︎ 표시상 `on` 을 신뢰하면 안 된다 — dry-run 으로 확정한 결함.
  //
  // 실측(투수 페이지, LG→KT):
  //   LG 2페이지 순회 후          → on=2
  //   팀 필터 reset 후            → **on=1 표시**, pages=[1], rows=0
  //   그 상태에서 KT 선택      → rows=0 (KT 투수는 1페이지뿐)
  //   "1" 버튼을 명시적으로 클릭 → rows=23 ✅
  //
  // 즉 표시는 1이므로 구판 `on === "1"` 조기종료는 **아무것도 안 하고** 통과했고,
  // 서버 내부 페이지 인덱스는 2 로 남아 단일 페이지 팀이 통째로 비었다.
  // 그래서 **항상 1번 버튼을 눌러 서버 상태를 강제로 맞춘다.**
  // 표시만으로는 서버 인덱스가 1로 돌아갔는지 알 수 없다 → epoch 없으면 fail-close.
  if (!(await installRequestEpoch(page))) return false;
  const epochBefore = await page.evaluate(() => window.__kboEpoch ?? 0).catch(() => null);
  if (epochBefore === null) return false;

  await first.click().catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});

  // 서버 응답이 실제로 끝나고 표시도 1페이지여야 한다.
  return page
    .waitForFunction(
      (prev) => {
        if ((window.__kboEpoch ?? 0) <= prev) return false;
        const on = document.querySelector('a[id*="ucPager_btnNo"].on')?.textContent?.trim();
        return on === undefined || on === "1";
      },
      epochBefore,
      { timeout: 12000 }
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * 한 팀의 페이지 순회 상한. KBO 기록 표는 한 팀당 30행/페이지로 최대 수십 명이므로
 * 정상 순회는 2~3페이지면 끝난다. 20 은 넘치는 상한이고, 여기 닿으면 순회 자체가 고장이다.
 */
export const MAX_PAGES_PER_TEAM = 20;

async function scrapeAllPages(page) {
  const allRows = [];
  let pageNum = 1;
  // 같은 페이저 상태를 다시 방문하면 순회가 순환하고 있다는 뜻이다.
  const seenStates = new Set();

  // 팀 전환 후에도 이전 팀의 페이지 인덱스가 남아 있다 — 반드시 1페이지로 맞춤다.
  if (!(await ensureFirstPage(page))) {
    return { rows: allRows, pagerComplete: false, reason: "cannot_reach_first_page" };
  }

  while (true) {
    // ⚠︎ 삼순 NO-GO 3차 ②: `while (true)` 에 상한이 없으면 한 pass 가 영원히 돌아
    // 상위의 `maxAttempts = 3` 재시도까지 무효화된다(크론 자체가 멈춘다).
    if (pageNum > MAX_PAGES_PER_TEAM) {
      return { rows: allRows, pagerComplete: false, reason: `max_pages_exceeded_${MAX_PAGES_PER_TEAM}` };
    }
    // 표가 안정되기 전에 읽으면 부분·빈 표를 수집한다.
    if (!(await waitForTableSettled(page))) {
      return { rows: allRows, pagerComplete: false, reason: `table_unsettled_at_${pageNum}` };
    }

    // 페이저 상태(현재 페이지 + 버튼 구성 + 첫행)가 이전에 본 것과 같으면 순환이다.
    const pagerState = await page
      .evaluate(() => {
        const on = document.querySelector('a[id*="ucPager_btnNo"].on')?.textContent?.trim() || "-";
        const nos = [...document.querySelectorAll('a[id*="ucPager_btnNo"]')]
          .map((a) => a.textContent?.trim())
          .join(",");
        const first = document.querySelector("tbody tr")?.textContent?.trim() || "";
        return `${on}|${nos}|${first}`;
      })
      .catch(() => null);
    if (pagerState) {
      if (seenStates.has(pagerState)) {
        return { rows: allRows, pagerComplete: false, reason: `pager_cycle_at_${pageNum}` };
      }
      seenStates.add(pagerState);
    }

    const rows = await page.$$eval("tbody tr", (trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")];
        return {
          texts: cells.map((td) => td.textContent.trim()),
          hrefs: cells.map((td) => {
            const a = td.querySelector("a");
            return a ? a.getAttribute("href") : "";
          }),
        };
      })
    );

    if (rows.length === 0) {
      // 1페이지가 비었으면 그것만으로는 페이저 결손이 아니다(결과 없음).
      // 수집 0명 자체는 팀 판정의 EMPTY 가 잡는다.
      // 반면 2페이지 이후의 0행은 중간에서 끊긴 것이다.
      return {
        rows: allRows,
        pagerComplete: pageNum === 1,
        reason: pageNum === 1 ? "empty_first_page" : `blank_page_at_${pageNum}`,
      };
    }
    allRows.push(...rows);

    const targetPageText = String(pageNum + 1);
    const nextVisibleBtn = await page.locator('a[id*="ucPager_btnNo"]').filter({ hasText: targetPageText }).first();
    if (await nextVisibleBtn.count()) {
      // 페이저 이동은 첫 행이 *실제로* 바뀌는 걸 확인해야 한다.
      // 고정 대기만 하면 이전 페이지를 한 번 더 긁어 중복이 쌓인다(실측됨).
      const beforeFirst = await page.locator("tbody tr").first().textContent().catch(() => "");
      await nextVisibleBtn.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      // 첫 행이 *실제로* 바뀌고 페이저의 `on` 이 목표 페이지로 옴길 때까지 기다린다.
      const advanced = await page
        .waitForFunction(
          ({ prev, target }) => {
            const first = document.querySelector("tbody tr")?.textContent?.trim() || "";
            const on = document.querySelector('a[id*="ucPager_btnNo"].on')?.textContent?.trim();
            return first !== prev && on === target;
          },
          { prev: (beforeFirst || "").trim(), target: targetPageText },
          { timeout: 12000 }
        )
        .then(() => true)
        .catch(() => false);
      // 페이지 전이가 확인 안 되면 같은 페이지를 다시 긁게 된다 — 중복 수집의 직접 원인.
      if (!advanced) {
        return { rows: allRows, pagerComplete: false, reason: `page_advance_failed_at_${pageNum + 1}` };
      }
      pageNum++;
      continue;
    }

    // 다음 페이지 버튼도 그룹 이동 버튼도 없다 = 명시적 끝.
    const nextGroupBtn = await page.$('a[id$="btnNext"]');
    if (!nextGroupBtn) return { rows: allRows, pagerComplete: true, reason: "exhausted" };

    // btnNext 가 *비활성*이면 그것도 명시적 끝이다.
    const nextDisabled = await nextGroupBtn.evaluate((a) => {
      const cls = a.className || "";
      const href = a.getAttribute("href") || "";
      return (
        /disabled|off\b/i.test(cls) ||
        a.hasAttribute("disabled") ||
        a.getAttribute("aria-disabled") === "true" ||
        href === "" ||
        href === "#" ||
        href === "javascript:void(0)" ||
        href === "javascript:;"
      );
    });
    if (nextDisabled) return { rows: allRows, pagerComplete: true, reason: "next_disabled" };

    const beforePager = await page.$$eval('a[id*="ucPager_btnNo"]', (links) =>
      links.map((a) => `${a.textContent?.trim()}:${a.className}`).join("|")
    );
    await nextGroupBtn.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
    const afterPager = await page.$$eval('a[id*="ucPager_btnNo"]', (links) =>
      links.map((a) => `${a.textContent?.trim()}:${a.className}`).join("|")
    );

    // ⚠︎ 삼순 NO-GO 3: 활성 btnNext 를 눌렀는데 pager 가 그대로라면
    // 그건 "끝에 도달"이 아니라 **전이 실패(stalled navigation)** 다.
    // 종전에는 이걸 `last_group` 으로 정상 EOF 처리해 부분수집을 완주로 통과시켰다.
    if (!afterPager || afterPager === beforePager) {
      return { rows: allRows, pagerComplete: false, reason: "stalled_navigation" };
    }
    pageNum++;
  }
}

/** 유효 행(선수명+playerId 보유)만 추려내고 팀명 witness 를 함께 넘긴다. */
function toUsableRows(rows) {
  const usable = [];
  for (const r of rows) {
    const name = r.texts[1] || "";
    const playerId = extractPlayerId(r.hrefs[1] || "");
    if (!name || !playerId) continue;
    // KBO 기록 표 헤더 실측: 순위 · 선수명 · **팀명** · AVG …
    usable.push({ playerId, name, teamNameCell: r.texts[2] || "" });
  }
  return usable;
}

function extractPlayerId(href) {
  const match = (href || "").match(/playerId=(\d+)/);
  return match ? match[1] : "";
}

async function main() {
  console.log("🏟️  KBO 로스터 크롤링 v2 (기록 페이지 기반)");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const allPlayers = new Map();
  // baseline 은 **같은 축**이어야 한다(삼순 NO-GO ①).
  // 전체 roster 인원(투수·미출장 보존분 포함)을 타자 phase 수집분과 비교하면
  // 정상 크롤도 통과할 수 없어 actual crawl 이 영구 RED 가 된다.
  // 직전 저장본의 *같은 phase* 팀별 수를 기준으로 삼는다.
  const readJsonSafe = (file) => {
    try {
      return JSON.parse(readFileSync(join(CONSTANTS_DIR, file), "utf-8"));
    } catch {
      return [];
    }
  };
  const rosterById = new Map(existingRoster.map((p) => [String(p.kboId), p]));
  const baselineByPhase = {
    batters: buildPhaseBaseline(readJsonSafe("stats-2026-batters.json"), rosterById),
    pitchers: buildPhaseBaseline(readJsonSafe("stats-2026-pitchers.json"), rosterById),
  };
  const teamOutcomes = [];

  // Season selector IDs
  const seasonSel = "select[name$='ddlSeason$ddlSeason']";
  const seriesSel = "select[name$='ddlSeries$ddlSeries']";
  const teamSel = "select[name$='ddlTeam$ddlTeam']";

  // ===== BATTERS =====
  console.log("\n📊 타자 크롤링...");
  await page.goto("https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx", { waitUntil: "networkidle" });

  // series(정규시즌)·season(2026) 셀렉트 — 전이 반환을 반드시 확인(삼순 NO-GO ①)
  const battersFilterOk = await setupPhaseFilters(page, { seasonSel, seriesSel });
  if (!battersFilterOk) {
    console.warn("  ⚠️ 타자 season/series 전이 실패 — phase 전체 fail-close");
  }

  for (const [teamCode, teamName, teamId] of TEAMS) {
    if (!battersFilterOk) {
      // 전이가 실패하면 이전 연도 표를 읽게 되므로 수집하지 않고 슬롯을 실패로 남긴다.
      teamOutcomes.push(phaseFilterFailureOutcome(teamName, teamId, "batters"));
      continue;
    }
    console.log(`  ${teamName}...`);
    teamOutcomes.push(
      await collectTeamWithContract({
        page,
        teamSel,
        teamCode,
        teamName,
        teamId,
        phase: "batters",
        baseline: baselineByPhase.batters.get(teamId),
        // ⚠︎ rows 는 `toUsableRows` 산출물 — `{playerId, name, teamNameCell}` 이다.
        // 원본 DOM 행(`hrefs`/`texts`)이 아니다.
        applyRows: (rows, tid, tname) => {
          for (const r of rows) {
            upsertScrapedPlayer(allPlayers, {
              playerId: r.playerId,
              name: r.name,
              teamId: tid,
              teamName: tname,
              position: existingFor(r.playerId)?.position || "야수",
            });
          }
        },
      })
    );
  }

  // ===== PITCHERS =====
  console.log("\n📊 투수 크롤링...");
  await page.goto("https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx", { waitUntil: "networkidle" });

  const pitchersFilterOk = await setupPhaseFilters(page, { seasonSel, seriesSel });
  if (!pitchersFilterOk) {
    console.warn("  ⚠️ 투수 season/series 전이 실패 — phase 전체 fail-close");
  }

  for (const [teamCode, teamName, teamId] of TEAMS) {
    if (!pitchersFilterOk) {
      teamOutcomes.push(phaseFilterFailureOutcome(teamName, teamId, "pitchers"));
      continue;
    }
    console.log(`  ${teamName}...`);
    teamOutcomes.push(
      await collectTeamWithContract({
        page,
        teamSel,
        teamCode,
        teamName,
        teamId,
        phase: "pitchers",
        baseline: baselineByPhase.pitchers.get(teamId),
        // ⚠︎ rows 는 `toUsableRows` 산출물 — `{playerId, name, teamNameCell}` 이다.
        applyRows: (rows, tid, tname) => {
          for (const r of rows) {
            upsertScrapedPlayer(allPlayers, {
              playerId: r.playerId,
              name: r.name,
              teamId: tid,
              teamName: tname,
              position: "투수",
            });
          }
        },
      })
    );
  }

  // 완주 계약: 한 팀이라도 실패하면 저장하지 않는다.
  // 부분 수집을 정상 완주로 저장하던 결손이 `②-b roster 자동머지 보류` 의 근거였다.
  // 개수가 아니라 phase×teamId 슬롯 key 집합으로 판정(삼순 NO-GO ②):
  // 중복 슬롯 1개가 누락 슬롯을 메꿐는 사건까지 잡는다.
  const completion = evaluateRosterCompletion(
    teamOutcomes,
    buildExpectedSlotKeys(TEAMS.map(([, , teamId]) => teamId))
  );
  if (!completion.complete) {
    await browser.close();
    console.error(`\n${formatCompletionFailure(completion)}`);
    process.exit(1);
  }
  console.log(`\n✅ 수집 완주 계약 통과 — ${completion.summary}`);

  // ===== 상세페이지 보강 (등번호 + 생년월일) =====
  // 기록 페이지(HitterBasic/PitcherBasic)에는 등번호·생년월일이 없음.
  // 선수 상세 페이지(PitcherDetail/HitterDetail)에서 #lblBackNo·#lblBirthday 스팬을 긁어 채움.
  // 등번호 또는 생년월일이 비어있는 선수만 방문 — 부하 최소화(생년월일 백필 후엔 신규만).
  const needsDetail = [...allPlayers.values()].filter((p) => {
    const missingBackNo = !(p.backNo && String(p.backNo).trim() !== "");
    const missingBirth = !p.birthDate;
    if (!missingBackNo && !missingBirth) return false;
    // KBO 숫자형 playerId만 상세 페이지가 존재. 외국인 canonical(FP/AQ)은
    // 스탯 페이지에서 발견한 숫자 alias(_numericId)로 보강한다.
    return /^\d+$/.test(p._numericId || p.kboId || "");
  });
  if (needsDetail.length > 0) {
    console.log(`\n🔢 상세 보강(등번호·생년월일): ${needsDetail.length}명 개별 페이지 방문`);
    let filled = 0;
    let failed = 0;
    for (let i = 0; i < needsDetail.length; i++) {
      const p = needsDetail[i];
      // 포지션에 따라 Pitcher/Hitter detail URL 선택 (둘 다 구조 동일, 실패 시 다른 쪽 재시도)
      const detailPlayerId = p._numericId || p.kboId;
      const urls = p.position === "투수"
        ? [
            `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailPlayerId}`,
            `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailPlayerId}`,
          ]
        : [
            `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${detailPlayerId}`,
            `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${detailPlayerId}`,
          ];
      let backNo = "";
      let birthDate = null;
      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
          backNo = await page.$eval(
            "#cphContents_cphContents_cphContents_playerProfile_lblBackNo",
            (el) => el.textContent.trim()
          ).catch(() => "");
          const birthTxt = await page.$eval(
            "#cphContents_cphContents_cphContents_playerProfile_lblBirthday",
            (el) => el.textContent.trim()
          ).catch(() => "");
          birthDate = parseKboBirthday(birthTxt);
          if (backNo || birthDate) break;
        } catch { /* try next url */ }
      }
      const rec = allPlayers.get(p.kboId);
      if (backNo && !(rec.backNo && String(rec.backNo).trim() !== "")) rec.backNo = backNo;
      if (birthDate && !rec.birthDate) rec.birthDate = birthDate;
      if (backNo || birthDate) filled++;
      else failed++;
      if ((i + 1) % 20 === 0) {
        console.log(`  진행 ${i + 1}/${needsDetail.length} (fill=${filled}, fail=${failed})`);
      }
    }
    console.log(`  ✅ 상세 보강 완료: 성공 ${filled}명, 실패 ${failed}명`);
  }

  await browser.close();

  // Merge with existing roster (keep existing players who have no 2026 stats yet).
  // If a numeric KBO id is an alias of an FP/AQ foreign canonical id, never
  // re-add it as a separate roster row.
  const preserved = preserveExistingRosterPlayers(allPlayers, existingMap, canonicalKboId);
  console.log(`  기존 roster 보존(군 복무·미출장 포함): ${preserved}명`);

  const roster = [...allPlayers.values()]
    .map((p) => ({
      name: p.name,
      kboId: p.kboId,
      teamId: p.teamId,
      position: p.position,
      backNo: p.backNo || "0",
      team: p.team || p.teamName || p.shortTeam,
      birthDate: p.birthDate ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  console.log(`\n✅ 총 ${roster.length}명 (기존 ${existingRoster.length}명)`);

  // Check for 곽빈
  const kwakbin = roster.find(p => p.name === "곽빈");
  console.log("곽빈:", kwakbin ? `✅ ${kwakbin.kboId}` : "❌ 누락");

  writeFileSync(join(CONSTANTS_DIR, "players-roster.json"), JSON.stringify(roster, null, 2));
  console.log("Saved to src/lib/constants/players-roster.json");
}

main().catch((e) => {
  console.error("❌ 크롤링 실패:", e.message);
  process.exit(1);
});
