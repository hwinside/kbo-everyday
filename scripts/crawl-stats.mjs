#!/usr/bin/env node
/**
 * KBO 공식 사이트에서 타자/투수 스탯 크롤링 → static JSON 생성
 * Usage: node scripts/crawl-stats.mjs [--season 2025]
 *
 * 페이지: Basic1 (타자 기본 + 투수 전체) + Basic2 (타자 추가: BB/HBP/SO/SLG/OBP/OPS)
 * + Runner (도루)
 * 페이징: ASP.NET ViewState → Playwright 사용
 */

import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeDefenseRuns } from "./lib/defense-runs.mjs";
import {
  validateBatterSnapshot,
  validateDefenseRunsSnapshot,
  validateDefenseSnapshot,
  validatePitcherSnapshot,
} from "./lib/stats-snapshot-guard.mjs";
import { recoverPendingPromotion } from "./lib/atomic-promote.mjs";
import { promoteStatsSnapshot } from "./lib/verified-promote.mjs";
import { collectAllPages, createKboPageAdapter, signatureOf } from "./lib/kbo-pagination.mjs";
import { MIN_CONFIRM_READS } from "./lib/source-row-stability.mjs";
import { createSelectAdapter, selectAndConfirm } from "./lib/kbo-select.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONSTANTS_DIR = join(PROJECT_ROOT, "src/lib/constants");

const KBO_BASE = "https://www.koreabaseball.com";
const SEASON = process.argv.includes("--season")
  ? process.argv[process.argv.indexOf("--season") + 1]
  : "2025";

// Load roster for kboId matching
let roster = [];
try {
  roster = JSON.parse(
    readFileSync(join(CONSTANTS_DIR, "players-roster.json"), "utf-8")
  );
} catch {
  console.warn("⚠️  players-roster.json not found, kboId matching disabled");
}

function findKboId(name, team) {
  // Try exact name match, prefer same team
  const matches = roster.filter((p) => p.name === name);
  if (matches.length === 1) return matches[0].kboId || "";
  const teamMatch = matches.find((p) => p.teamName === team || p.shortTeam === team);
  return teamMatch?.kboId || matches[0]?.kboId || "";
}

// Extract playerId from href like /Record/Player/HitterDetail/Basic.aspx?playerId=76232
function extractPlayerId(html) {
  const match = html.match(/playerId=(\d+)/);
  return match ? match[1] : "";
}

/**
 * 드롭다운(시즌·시리즈) 전환 — 확인된 전환만 성공으로 본다.
 *
 * ⚠︎ 종전에는 `waitForFunction` 타임아웃을 catch 한 뒤 **고정 대기만 하고 무확인으로
 * 진행**했다(삼순 6차 지적). postback 이 유실되면 이전 시즌 표를 그대로 크롤해
 * **데이터셋 전체가 다른 시즌**이 된다. 스냅샷 가드는 개수만 보므로 이걸 못 잡는다.
 * oracle 과 동일한 fail-close 계약(`selectAndConfirm`)을 공유한다.
 */
async function changeSelectAndWait(page, selector, value) {
  // 표 읽기는 공용 adapter 를 쓴다 — 또 따로 구현하면 계약이 갈라진다.
  const adapter = createKboPageAdapter(page);
  await selectAndConfirm(
    createSelectAdapter(page, selector, async () => signatureOf(await adapter.scrapeTable())),
    value,
    { label: selector },
  );
  await page.waitForLoadState("networkidle").catch(() => {});
}

// export: 게이트가 실제 함수를 직접 태울 수 있어야 한다(문자열 검사는 `if (false)` 위장을 못 잡는다).
export async function selectSeason(page) {
  const seriesSelector = "select[name$='ddlSeries$ddlSeries']";
  const seasonSelector = "select[name$='ddlSeason$ddlSeason']";

  // Always use regular season for seasonal stat snapshots.
  const hasSeries = await page.$(seriesSelector);
  if (hasSeries) {
    await changeSelectAndWait(page, seriesSelector, "0");
  }

  await changeSelectAndWait(page, seasonSelector, SEASON);
}

/**
 * 정렬 전환 — 이것도 **확인된 교체만** 성공으로 본다.
 *
 * ⚠︎ 종전에는 타임아웃을 catch 하고 고정 대기 후 그냥 진행했다(select 와 같은 결손).
 * 투수 수집은 ERA 기본정렬이 규정이닝 위주라, `GAME_CN` 정렬이 안 먹히면
 * 불펜·마무리가 통째로 빠진다. 역시 개수 가드로는 안 잡히는 대량 유실이다.
 */
export async function sortTable(page, sortKey, { attempts = 3, polls = 10, pollIntervalMs = 500 } = {}) {
  const adapter = createKboPageAdapter(page);
  const before = signatureOf(await adapter.scrapeTable());
  const selector = `a[href="javascript:sort('${sortKey}');"]`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const link = await page.$(selector);
    if (!link) throw new Error(`Sort link not found: ${sortKey}`);
    await link.click();
    await page.waitForLoadState("networkidle").catch(() => {});

    for (let poll = 0; poll < polls; poll++) {
      await page.waitForTimeout(pollIntervalMs);
      const now = signatureOf(await adapter.scrapeTable());
      if (now && now !== before) return;
    }
  }

  throw new Error(
    `sort_change_failed: ${sortKey} 정렬이 적용되지 않았다(재시도 ${attempts}회 소진)`
    + ` — 정렬 전 목록을 수집하면 대상이 통째로 바뀜다`,
  );
}

async function scrapeAllPages(page) {
  return collectAllPages({ ...createKboPageAdapter(page), log: (line) => console.log(line) });
}

/**
 * 수비 페이지 확인 조회 횟수. 하한은 lib 에서 가져온다 — 여기를 1 로 바꾸면 합집합이
 * 곰 단일 관측이 되어 계약이 사라진다(값은 그대로인데 보호만 없어져 아무도 못 잡는다).
 */
const DEFENSE_CONFIRM_READS = MIN_CONFIRM_READS;

async function crawlBatterBasic1(page) {
  console.log("\n📊 타자 Basic1 크롤링...");
  // GAME_CN 정렬로 출장기록 있는 전체 타자 수집 (HRA_RT는 규정타석 충족자만 반환)
  await page.goto(
    `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) AVG(3) G(4) PA(5) AB(6) R(7) H(8) 2B(9) 3B(10) HR(11) TB(12) RBI(13) SAC(14) SF(15)
  return rows.map((r, i) => {
    const c = r.texts;
    const playerId = extractPlayerId(r.hrefs[1] || "");
    return {
      name: c[1] || "",
      team: c[2] || "",
      avg: c[3] || ".000",
      games: parseInt(c[4]) || 0,
      pa: parseInt(c[5]) || 0,
      ab: parseInt(c[6]) || 0,
      runs: parseInt(c[7]) || 0,
      hits: parseInt(c[8]) || 0,
      doubles: parseInt(c[9]) || 0,
      triples: parseInt(c[10]) || 0,
      hr: parseInt(c[11]) || 0,
      tb: parseInt(c[12]) || 0,
      rbi: parseInt(c[13]) || 0,
      sac: parseInt(c[14]) || 0,
      sf: parseInt(c[15]) || 0,
      _playerId: playerId,
    };
  });
}

async function crawlBatterBasic2(page) {
  console.log("\n📊 타자 Basic2 크롤링...");
  // GAME_CN URL 파라미터로 전체 타자 포함 (Basic2 페이지에는 GAME_CN 정렬 링크가 없으므로 URL로 처리)
  await page.goto(
    `${KBO_BASE}/Record/Player/HitterBasic/Basic2.aspx?sort=GAME_CN`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) AVG(3) BB(4) IBB(5) HBP(6) SO(7) GDP(8) SLG(9) OBP(10) OPS(11) MH(12) RISP(13) PH-BA(14)
  return rows.map((r) => {
    const c = r.texts;
    return {
      name: c[1] || "",
      team: c[2] || "",
      bb: parseInt(c[4]) || 0,
      ibb: parseInt(c[5]) || 0,
      hbp: parseInt(c[6]) || 0,
      so: parseInt(c[7]) || 0,
      gdp: parseInt(c[8]) || 0,
      slg: c[9] || ".000",
      obp: c[10] || ".000",
      ops: c[11] || ".000",
      _playerId: extractPlayerId(r.hrefs[1] || ""),
    };
  });
}

async function crawlRunner(page) {
  console.log("\n📊 도루 크롤링...");
  await page.goto(`${KBO_BASE}/Record/Player/Runner/Basic.aspx`);
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) G(3) SBA(4) SB(5) CS(6) SB%(7) OOB(8) PKO(9)
  return rows.map((r) => {
    const c = r.texts;
    return {
      name: c[1] || "",
      team: c[2] || "",
      sb: parseInt(c[5]) || 0,
      cs: parseInt(c[6]) || 0,
      _playerId: extractPlayerId(r.hrefs[1] || ""),
    };
  });
}

async function crawlPitcher(page) {
  console.log("\n📊 투수 Basic1 크롤링...");
  await page.goto(
    `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=ERA_RT`
  );
  await page.waitForLoadState("networkidle");
  await selectSeason(page);

  // ERA 기본 정렬은 규정이닝 투수 위주라 불펜/마무리가 빠진다.
  // 전체 투수 목록을 얻기 위해 등판수(G) 기준으로 재정렬 후 전 페이지를 순회한다.
  await sortTable(page, "GAME_CN");

  const rows = await scrapeAllPages(page);

  // Columns: 순위(0) 선수명(1) 팀명(2) ERA(3) G(4) W(5) L(6) SV(7) HLD(8) WPCT(9) IP(10) H(11) HR(12) BB(13) HBP(14) SO(15) R(16) ER(17) WHIP(18)
  return rows.map((r, i) => {
    const c = r.texts;
    const playerId = extractPlayerId(r.hrefs[1] || "");
    const name = c[1] || "";
    const team = c[2] || "";
    const kboId = playerId || findKboId(name, team);

    return {
      rank: i + 1,
      name,
      team,
      era: c[3] || "0.00",
      games: parseInt(c[4]) || 0,
      wins: parseInt(c[5]) || 0,
      losses: parseInt(c[6]) || 0,
      saves: parseInt(c[7]) || 0,
      holds: parseInt(c[8]) || 0,
      wpct: c[9] || "0.000",
      ip: c[10] || "0",
      h: parseInt(c[11]) || 0,
      hr: parseInt(c[12]) || 0,
      bb: parseInt(c[13]) || 0,
      hbp: parseInt(c[14]) || 0,
      so: parseInt(c[15]) || 0,
      r: parseInt(c[16]) || 0,
      er: parseInt(c[17]) || 0,
      whip: c[18] || "0.00",
      kboId,
      playerId: kboId,
    };
  });
}

/**
 * 수비 크롤 — **확인 재조회 후 합집합**으로 산출물을 굳힌다.
 *
 * ⚠︎ 수비 페이지만 이렇게 한다. 2026-08-08 실측에서 행 존재가 조회마다 흔린 건
 * 수비였다(rank 동률 최하위 구간, 전달민—전다민 54214 — 824↔825 반복).
 *
 * 한 번만 읽으면 그 회차의 운이 그대로 서빙 데이터가 된다 — 어제 있던 포지션 행이
 * 오늘 사라졌다 내일 돌아오는 플리핑이 기록실·파생 WAR 보정에 그대로 노출된다.
 *
 * 합집합이지만 **영욱 누적이 아니다**: 진짜 말소된 행은 다음 런에서 전 회차 부재로
 * 관측되어 자연히 빠진다 — 직전 산출물을 전혀 참조하지 않기 때문이다.
 */
async function crawlDefense(page) {
  console.log("\n📊 수비 크롤링...");
  const rowsByKey = new Map();

  for (let read = 1; read <= DEFENSE_CONFIRM_READS; read++) {
    // GAME_CN 정렬로 출장기록 있는 전체 수비수 수집 (기본 정렬=수비이닝은 상위권만)
    await page.goto(`${KBO_BASE}/Record/Player/Defense/Basic.aspx?sort=GAME_CN`);
    await page.waitForLoadState("networkidle");
    await selectSeason(page);

    const observed = await scrapeAllPages(page);
    // 0행 관측은 "전부 사라졌다"가 아니라 수집 실패다. 합집합에 섮으면 조용히 무시된다.
    if (observed.length === 0) {
      throw new Error(
        `defense_empty_observation: 수비 ${read}회차 0행 — 수집 실패를 합집합으로 숨길 수 없다`,
      );
    }
    for (const r of observed) {
      const id = extractPlayerId(r.hrefs?.[1] || "")
        || findKboId(r.texts?.[1] || "", r.texts?.[2] || "");
      rowsByKey.set(`${id}|${r.texts?.[3] ?? ""}`, r);
    }
    console.log(
      `    확인 조회 ${read}/${DEFENSE_CONFIRM_READS}: ${observed.length}행 · 합집합 ${rowsByKey.size}행`,
    );
  }

  const rows = [...rowsByKey.values()];

  // 한 선수가 여러 포지션을 보면 포지션별로 행이 나뉜다 → 행 단위로 보존(포지션 보정용).
  // Columns: 순위(0) 선수명(1) 팀명(2) POS(3) G(4) GS(5) IP(6) E(7) PKO(8) PO(9) A(10) DP(11) FPCT(12) PB(13) SB(14) CS(15) CS%(16)
  return rows.map((r) => {
    const c = r.texts;
    const name = c[1] || "";
    const team = c[2] || "";
    const kboId = extractPlayerId(r.hrefs[1] || "") || findKboId(name, team);
    return {
      name,
      team,
      kboId,
      pos: c[3] || "",
      games: parseInt(c[4]) || 0,
      ip: c[6] || "0",
      e: parseInt(c[7]) || 0,
      pko: parseInt(c[8]) || 0,
      po: parseInt(c[9]) || 0,
      a: parseInt(c[10]) || 0,
      dp: parseInt(c[11]) || 0,
      fpct: c[12] || "0.000",
      pb: parseInt(c[13]) || 0,
      sb: parseInt(c[14]) || 0,
      cs: parseInt(c[15]) || 0,
    };
  });
}

function parseIpToFloat(ip) {
  // "180 2/3" → 180.67, "164 1/3" → 164.33
  if (!ip || ip === "0") return 0;
  const parts = ip.split(" ");
  let whole = parseInt(parts[0]) || 0;
  if (parts[1]) {
    const frac = parts[1].split("/");
    whole += (parseInt(frac[0]) || 0) / (parseInt(frac[1]) || 1);
  }
  return Math.round(whole * 100) / 100;
}

/**
 * ⚠︎ export 이유: 게이트가 **실제 write 경로를 실행**해야 하기 때문이다.
 * 소스 문자열 검사로는 `false && await promoteStatsSnapshot(...)` 처럼 호출을 통째 끊는
 * 우회를 못 잡는다(merged main 에서 실제로 GREEN 이었다). 게이트가 main() 을 직접 돌려
 * "검증기가 호출됐는가 / 검증 실패 시 산출물이 그대로인가" 를 행동으로 확인한다.
 */
export async function main() {
  console.log(`🏟️  KBO 스탯 크롤링 시작 (시즌: ${SEASON})`);

  // ⚠︎ 어떤 데이터 read 보다 *먼저* 미완료 promote 를 복구한다.
  //
  // 종전에는 recoverPendingPromotion() 이 promoteAtomically() 진입 시점에 있었다.
  // 그러면 크롤·기존 snapshot read·검증을 전부 끝낸 뒤에야 복구되므로,
  // 직전 실행이 hard-exit 로 죽어 혼합 세대가 남은 상태에서 그대로 출발한다
  // (= "항상 old 전체 또는 new 전체" 계약 위반, 삼순 5차 지적).
  // 여기가 startup recovery 의 유일한 올바른 위치다.
  const recovery = recoverPendingPromotion(CONSTANTS_DIR);
  if (recovery.recovered) {
    console.log(
      `♻️  이전 실행의 미완료 promote 복구: ${recovery.restored.length}개 파일을 이전 세대로 되돌림`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // ===== BATTERS =====
    const basic1 = await crawlBatterBasic1(page);
    const basic2 = await crawlBatterBasic2(page);
    const runner = await crawlRunner(page);

    // Merge batter data
    //
    // ⚠︎ 병합 키는 반드시 KBO playerId(canonical ID)다.
    // 종전에는 `${name}|${team}`을 썼는데, 같은 팀 동명이인이 서로를 덮어써
    // 한 명이 통째 사라졌다. 실측 결손: 키움 이주형이 둘(50167 외야수 / 51302 내야수)인데
    // `stats-2026-batters.json`에 51302만 남아 50167의 타격 기록이 서비스에서 통째 사라졌다.
    // 인원수 게이트(Δ≤10)로는 1명 실종이 절대 잡힐지 않는다.
    // 투수 경로는 이미 playerId를 쓰고 있었고, 타자 경로만 이름+팀 키였다.
    console.log("\n🔗 타자 데이터 병합...");
    const batterMap = new Map();

    /**
     * canonical ID로만 병합한다. ID가 없는 행은 이름+팀으로 보정하되,
     * 그 조합이 둘 이상이면(= 동명이인 모호) 추측하지 않고 fail-close 한다.
     */
    const ambiguousNameTeam = new Set();
    {
      const nameTeamCount = new Map();
      for (const b of basic1) {
        const nt = `${b.name}|${b.team}`;
        nameTeamCount.set(nt, (nameTeamCount.get(nt) ?? 0) + 1);
      }
      for (const [nt, count] of nameTeamCount) if (count > 1) ambiguousNameTeam.add(nt);
    }

    const nameTeamToId = new Map();
    for (const b of basic1) {
      const nt = `${b.name}|${b.team}`;
      const id = String(b._playerId || "").trim();
      if (!id) {
        throw new Error(
          `batter_identity_missing: ${nt} — KBO 행에 playerId 링크가 없어 canonical 병합 불가`,
        );
      }
      if (batterMap.has(id)) {
        throw new Error(`batter_identity_duplicate: playerId=${id} (${nt}) 행이 중복입니다`);
      }
      batterMap.set(id, { ...b });
      if (!ambiguousNameTeam.has(nt)) nameTeamToId.set(nt, id);
    }

    /** 보조 페이지(Basic2/Runner) 행을 canonical ID로 해석. 모호하면 null. */
    const resolveBatterKey = (row, source) => {
      const id = String(row._playerId || "").trim();
      if (id) return batterMap.has(id) ? id : null;
      const nt = `${row.name}|${row.team}`;
      if (ambiguousNameTeam.has(nt)) {
        // 동명이인 — 추측해서 붙이면 엉뚝한 선수 기록이 오염된다.
        throw new Error(
          `batter_merge_ambiguous: ${source} \`${nt}\` 행에 playerId가 없고 동명이인이 있어 해석 불가`,
        );
      }
      return nameTeamToId.get(nt) ?? null;
    };

    for (const b2 of basic2) {
      const key = resolveBatterKey(b2, "Basic2");
      const existing = key ? batterMap.get(key) : null;
      if (existing) {
        Object.assign(existing, {
          bb: b2.bb,
          ibb: b2.ibb,
          hbp: b2.hbp,
          so: b2.so,
          gdp: b2.gdp,
          slg: b2.slg,
          obp: b2.obp,
          ops: b2.ops,
        });
      }
    }

    for (const r of runner) {
      const key = resolveBatterKey(r, "Runner");
      const existing = key ? batterMap.get(key) : null;
      if (existing) {
        existing.sb = r.sb;
        existing.cs = r.cs;
      }
    }

    // Sort by AVG desc and assign ranks + kboId
    const batters = [...batterMap.entries()]
      .sort(([, a], [, b]) => parseFloat(b.avg) - parseFloat(a.avg))
      .map(([canonicalId, b], i) => {
        const kboId = canonicalId;
        delete b._playerId;
        return {
          rank: i + 1,
          ...b,
          sb: b.sb || 0,
          cs: b.cs || 0,
          bb: b.bb || 0,
          hbp: b.hbp || 0,
          so: b.so || 0,
          slg: b.slg || ".000",
          obp: b.obp || ".000",
          ops: b.ops || ".000",
          kboId,
          playerId: kboId,
        };
      });

    // ===== PITCHERS =====
    const pitchers = await crawlPitcher(page);

    // ===== DEFENSE ===== (예상 WAR 수비 runs 보정용, 포지션별 행)
    const defense = await crawlDefense(page);

    // ===== SAVE =====
    const batterPath = join(CONSTANTS_DIR, `stats-${SEASON}-batters.json`);
    const pitcherPath = join(CONSTANTS_DIR, `stats-${SEASON}-pitchers.json`);
    const defensePath = join(CONSTANTS_DIR, `stats-${SEASON}-defense.json`);

    // 수비 runs(RF-lite) 파생 → 기록실/예상 WAR 보정용
    const defenseRunsPath = join(CONSTANTS_DIR, `player-defense-runs.json`);
    const defenseRuns = computeDefenseRuns(defense);

    // 기록실 "마지막 업데이트" 표기용 메타(크롤 시각). 타자/투수는 런타임 라이브가 우선, 폴백/수비 표기에 사용.
    const metaPath = join(CONSTANTS_DIR, `stats-${SEASON}-meta.json`);
    const nowIso = new Date().toISOString();
    const meta = { battersGeneratedAt: nowIso, pitchersGeneratedAt: nowIso, defenseGeneratedAt: nowIso };

    // A transient pager skip can return a syntactically valid snapshot with one
    // complete 30-row page missing. Reject it before any stats/meta artifact is
    // written so a fresh timestamp can never bless a partial dataset.
    // ⚠︎ 종전에는 이 가드가 *투수에만* 걸려 있었다. 그래서 페이지네이션이 끊기면
    // 타자·수비·수비runs는 무너진 채로 그대로 썰다.
    // 실측 사고(2026-08-04): 수비 823행 → 30행(첫 페이지 한 장만 남음)으로 유실됐는데
    // 아무 게이트도 발동하지 않고 정상 종료했다. 이제 네 데이터셋 전부에 건다.
    const readPrevious = (path, fallback) => {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        // First-time season generation has no baseline; non-empty is still enforced.
        return fallback;
      }
    };
    validatePitcherSnapshot(readPrevious(pitcherPath, []), pitchers);
    validateBatterSnapshot(readPrevious(batterPath, []), batters);
    validateDefenseSnapshot(readPrevious(defensePath, []), defense);
    validateDefenseRunsSnapshot(readPrevious(defenseRunsPath, {}), defenseRuns);

    // 개수·델타 가드는 *값*을 보지 않는다. 곽빈 ERA를 99.99로 바꿔도 전 게이트가 GREEN이었고,
    // 동명이인 병합 붕괴로 한 명이 통째 사라져도 Δ≤10 안이라 통과됐다.
    // 그래서 쓰기 *직전*에 KBO 원본을 독립 재조회해 전 행·전 필드를 대조하고,
    // 값 오염 1건 또는 행 누락/잉여 1건이라도 있으면 아무것도 쓰지 않고 죽는다.
    // 검증 자체가 불가해도(수집 0행) 실패다 — 검증 불가를 통과로 취급하면 게이트가 아니다.
    //
    // 판정·예외는 라이브러리(assertSourceTruth)가 끝낸다. 호출자 쪽에 `if (failures.length)`
    // 분기를 두면 한 줄로 무력화되는데 "호출이 존재하는가" 식 게이트는 그 상태에서도 GREEN이다
    // (실제로 이 파일의 초기 구현이 그랬고, mutation으로 잡아 여기로 옮겼다).
    console.log("\n🔎 원본 정합성 재대조(KBO 독립 재조회)...");

    const artifacts = [
      { path: batterPath, body: JSON.stringify(batters, null, 2) },
      { path: pitcherPath, body: JSON.stringify(pitchers, null, 2) },
      { path: defensePath, body: JSON.stringify(defense, null, 2) },
      { path: defenseRunsPath, body: JSON.stringify(defenseRuns, null, 2) },
      { path: metaPath, body: JSON.stringify(meta, null, 2) },
    ];

    // ⚠︎ 검증기(assertSourceTruth)는 promoteStatsSnapshot **내부에 고정**돼 있다 — caller 가
    // 고를 수 없다. verifier 를 파라미터로 열어두면 `verify: async () => {}` 한 줄로
    // 검증 0회가 되고, 문자열 게이트는 위장 필드만 있으면 GREEN 이었다(삼순 실증).
    // 검증 입력도 caller 가 넘기지 않는다. **promote payload
    // 에서 파생**해 검증기에 넣는다. 종전에는 caller 한 줄만 바꾸면 우회가 됐고
    // (`false && await assertSourceTruth`, 옛 defenseRuns 스냅샷 검증) 전 게이트가 GREEN 이었다.
    // 문자열 검사로는 같은 의미의 다른 표기를 끝없이 놓치므로, 구조로 막는다.
    await promoteStatsSnapshot({
      artifacts,
      context: {
        browser,
        kboBase: KBO_BASE,
        season: SEASON,
        roster: readPrevious(join(CONSTANTS_DIR, "players-roster.json"), []),
        foreignIdSource: readFileSync(join(CONSTANTS_DIR, "foreign-id-map.ts"), "utf-8"),
      },
    });

    console.log(`\n✅ 타자 ${batters.length}명 → ${batterPath}`);
    console.log(`✅ 투수 ${pitchers.length}명 → ${pitcherPath}`);
    console.log(`✅ 수비 ${defense.length}행 → ${defensePath}`);
    console.log(`✅ 수비 runs ${Object.keys(defenseRuns).length}명 → ${defenseRunsPath}`);
    console.log(`✅ 메타(크롤 시각) → ${metaPath}`);

    // Validation: compare top 5 with expected
    console.log("\n📋 타자 Top 5:");
    batters.slice(0, 5).forEach((b) =>
      console.log(
        `  ${b.rank}. ${b.name} (${b.team}) AVG ${b.avg} G${b.games} PA${b.pa} HR${b.hr} RBI${b.rbi} OPS${b.ops}`
      )
    );

    console.log("\n📋 투수 Top 5:");
    pitchers.slice(0, 5).forEach((p) =>
      console.log(
        `  ${p.rank}. ${p.name} (${p.team}) ERA ${p.era} G${p.games} W${p.wins} L${p.losses} IP${p.ip} SO${p.so} WHIP${p.whip}`
      )
    );
  } finally {
    await browser.close();
  }
}

// 직접 실행일 때만 크롤한다. 게이트가 `selectSeason`·`sortTable` 을 import 해
// 행동을 직접 검증해야 하는데, top-level 실행이면 import 만으로 크롤이 시작된다.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("❌ 크롤링 실패:", e.message);
    process.exit(1);
  });
}
