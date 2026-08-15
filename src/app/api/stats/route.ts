import { NextRequest, NextResponse } from "next/server";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats2025 from "@/lib/constants/stats-2025-batters.json";
import pitcherStats2025 from "@/lib/constants/stats-2025-pitchers.json";
import batterStats2026 from "@/lib/constants/stats-2026-batters.json";
import pitcherStats2026 from "@/lib/constants/stats-2026-pitchers.json";
import defenseStats2026 from "@/lib/constants/stats-2026-defense.json";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import { canonicalKboId } from "@/lib/utils/resolve-player";
import { aggregateDefense, type DefenseRow } from "@/lib/utils/defense-aggregate";
import {
  mergeFullEntry,
  oldestFullEntryTimestamp,
  requireOldestFullEntryTimestamp,
  StatsFreshnessContractError,
} from "@/lib/stats/full-entry";
import {
  fetchNaverPlayerStats,
  type NaverPlayerStat,
} from "@/lib/crawler/naver-player-stats";

const KBO_BASE = "https://www.koreabaseball.com";
const RUNNER_URL = `${KBO_BASE}/Record/Player/Runner/Basic.aspx?sort=SB_CN`;
const RUNNER_PAGER_PREFIX =
  "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$";
const RUNNER_CRAWL_TIMEOUT_MS = 5_000;
const RUNNER_MIN_PAGES = 9;
const RUNNER_MIN_ROWS = 250;
const STATS_TOTAL_DEADLINE_MS = 5_000;
const STATS_KBO_BUDGET_MS = 2_500;
const KBO_TABLE_MIN_ROWS = 30;
const KBO_TEAM_NAMES = new Set(["한화", "KIA", "KT", "LG", "롯데", "NC", "두산", "SSG", "삼성", "키움"]);
const KBO_TEAM_MINIMUM = { batter: 3, pitcher: 6 } as const;

interface PlayerStat {
  rank: number;
  name: string;
  team: string;
  [key: string]: string | number;
}

type RunnerStat = { sb: number; cs: number };
type RunnerSource = "live" | "static-fallback";

function readTextWithSignal(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    response.text().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": KBO_BASE,
    },
    next: { revalidate: 0 },  // 캐싱은 인메모리 캐시에서 관리 (getCacheTtl)
    signal,
  });
  if (!res.ok) throw new Error(`KBO stats HTTP ${res.status}`);
  if (!signal) return res.text();
  return readTextWithSignal(res, signal);
}

export type ParsedTableRow = string[] & { playerId?: string };

// ⚠️ export 는 identity 게이트(qa:stats-kboid-identity)가 **실제 배포 함수**를 태우기 위해서다.
export function parseTable(html: string): ParsedTableRow[] {
  const rows: ParsedTableRow[] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const tbody = tbodyMatch[1];
  const trMatches = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells = [] as ParsedTableRow;
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        const text = td.replace(/<[^>]+>/g, "").trim();
        cells.push(text);
      }
    }
    // KBO 기록실 이름 링크의 공식 playerId를 보존한다. 동명이인은 name+team으로 풀 수 없다.
    const playerId = tr.match(/\bplayerId=(\d+)\b/i)?.[1];
    if (playerId) cells.playerId = playerId;
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/**
 * KBO 표 행에 결속된 공식 playerId (canonical). 없으면 "".
 *
 * ⚠️ 왜 identity 인가 (#1100 삼순 4차 P0-3): 같은 팀 동명이인(로스터 실측 복수 그룹 —
 * 이주형/키움, 이승현/삼성 등)은 `이름::팀` 으로 풀 수 없고, 그 키로 병합하면
 * 서로의 값을 덮어쓴다. 하류에서 kboId 로 걸러도 **이미 오염된 값**이라 복구되지 않는다.
 */
export function rowKboId(row: ParsedTableRow): string {
  return canonicalKboId(row.playerId);
}

/**
 * 같은 canonical ID 가 다른 name/team 으로 재등장하면 식별 체계 오염이다 — throw.
 * (삼순 #1196 2차 P0: 충돌을 조용히 삼키면 오인 ID 가 정상 응답으로 통과한다.)
 */
function assertRowIdentityConsistent(existing: ParsedTableRow, row: ParsedTableRow, key: string): void {
  const same =
    (existing[1] || "").trim() === (row[1] || "").trim() &&
    (existing[2] || "").trim() === (row[2] || "").trim();
  if (!same) throw new Error(`KBO stats identity conflict: ${key}`);
}

/**
 * Basic1 union — 각 정렬 상위 30 합집합을 **identity 로** 묶는다.
 * production 경로와 게이트가 공유하는 유일한 구현이다.
 *
 * ⚠️ `이름::팀` 하위호환은 없다(삼순 #1196 1차 P0). ID 결손 행은 조용히 이름 키로
 * 흘러보내지 않고 **fail-close** 한다 — 혼합보다 전체 fallback 이 안전하다.
 * ⚠️ 중복 규칙(삼순 #1196 2차 P0): **같은 테이블 안** 같은 ID 재등장 = 소스 오염 → throw.
 * 테이블 간 재등장은 union 의 정상 dedupe 이되, name/team 이 다르면 충돌 → throw.
 */
export function mergeBasicRows(tables: ParsedTableRow[][]): ParsedTableRow[] {
  const merged = new Map<string, ParsedTableRow>();
  for (const table of tables) {
    const seenInTable = new Set<string>();
    for (const row of table) {
      const key = rowKboId(row);
      if (!key) throw new Error("KBO stats row identity missing");
      if (seenInTable.has(key)) throw new Error(`KBO stats row identity duplicated in table: ${key}`);
      seenInTable.add(key);
      const existing = merged.get(key);
      if (existing) {
        assertRowIdentityConsistent(existing, row, key);
        continue;
      }
      merged.set(key, row);
    }
  }
  return [...merged.values()];
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function runnerPostbackBody(html: string, eventTarget: string): URLSearchParams {
  const body = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const tag = match[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) body.set(decodeHtmlAttribute(name), decodeHtmlAttribute(value));
  }
  if (!body.get("__VIEWSTATE") || !body.get("__EVENTVALIDATION")) {
    throw new Error("Runner WebForms hidden fields missing");
  }
  body.set("__EVENTTARGET", eventTarget);
  body.set("__EVENTARGUMENT", "");
  return body;
}

function runnerCurrentPage(html: string): number {
  const page = html.match(/ucPager_btnNo\d+["'][^>]*class=["']on["'][^>]*>(\d+)</i)?.[1];
  if (!page) throw new Error("Runner current page missing");
  return Number(page);
}

function runnerNextTarget(html: string, currentPage: number): string | null {
  for (const match of html.matchAll(
    /<a\b[^>]*href=["'][^"']*__doPostBack\((?:&#39;|')([^'&]+)(?:&#39;|')[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const target = decodeHtmlAttribute(match[1]);
    const label = match[2].replace(/<[^>]+>/g, "").trim();
    if (target.startsWith(RUNNER_PAGER_PREFIX) && Number(label) === currentPage + 1) {
      return target;
    }
  }
  return html.includes(`${RUNNER_PAGER_PREFIX}btnNext`)
    ? `${RUNNER_PAGER_PREFIX}btnNext`
    : null;
}

/**
 * KBO Runner WebForms 전 페이지를 같은 ASP.NET session으로 순차 수집한다.
 * 한 페이지라도 실패하면 부분 결과를 반환하지 않아 호출측이 static 전체 fallback으로 전환한다.
 */
export async function fetchAllRunnerRows(
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal,
): Promise<ParsedTableRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNNER_CRAWL_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  try {
    let response = await fetchImpl(RUNNER_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": RUNNER_URL,
      },
      signal,
    });
    if (!response.ok) throw new Error(`Runner GET HTTP ${response.status}`);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Runner ASP.NET session cookie missing");

    let html = await readTextWithSignal(response, signal);
    const rows: ParsedTableRow[] = [];
    const seenPages = new Set<number>();
    while (true) {
      const page = runnerCurrentPage(html);
      if (seenPages.has(page)) throw new Error(`Runner pager loop at page ${page}`);
      if (page !== seenPages.size + 1) {
        throw new Error(`Runner pager skipped: expected ${seenPages.size + 1}, got ${page}`);
      }
      seenPages.add(page);
      rows.push(...parseTable(html));

      const eventTarget = runnerNextTarget(html, page);
      if (!eventTarget) break;
      response = await fetchImpl(RUNNER_URL, {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": RUNNER_URL,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookie,
        },
        body: runnerPostbackBody(html, eventTarget).toString(),
        signal,
      });
      if (!response.ok) throw new Error(`Runner page ${page + 1} POST HTTP ${response.status}`);
      html = await readTextWithSignal(response, signal);
    }
    if (seenPages.size < RUNNER_MIN_PAGES || rows.length < RUNNER_MIN_ROWS) {
      throw new Error(`Runner full crawl incomplete: ${seenPages.size} pages, ${rows.length} rows`);
    }
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBatterStats(signal?: AbortSignal): Promise<{
  stats: PlayerStat[];
  runnerMap: Map<string, RunnerStat>;
  runnerSource: RunnerSource;
  runnerUpdatedAt: string;
}> {
  // Basic1: 순위(0) 선수명(1) 팀명(2) AVG(3) G(4) PA(5) AB(6) R(7) H(8) 2B(9) 3B(10) HR(11) TB(12) RBI(13) SAC(14) SF(15)
  // Basic2: 순위(0) 선수명(1) 팀명(2) AVG(3) BB(4) IBB(5) HBP(6) SO(7) GDP(8) SLG(9) OBP(10) OPS(11) MH(12) RISP(13) PH-BA(14)
  // Runner: 순위(0) 선수명(1) 팀명(2) G(3) SBA(4) SB(5) CS(6) SB%(7) OOB(8) PKO(9)
  // KBO 레코드는 페이지당 30행 + 포스트백 페이지네이션 → 단일 정렬로는 31위↓ 누락.
  // 카테고리별 정렬을 union해 각 부문 리더가 빠지지 않게 수집 (투수와 동일 패턴).
  // 비율스탯(*_RT) 리더보드는 KBO가 규정타석 충족자만 노출 → 규정타석 셋 산출에도 사용.
  const rateSorts = ["HRA_RT", "OPS_RT", "OBP_RT", "SLG_RT"];
  const basic1Sorts = ["GAME_CN", "HR_CN", "RBI_CN", "HIT_CN", "SB_CN", ...rateSorts];
  // Basic2 누적스탯(BB/SO/HBP/GDP)도 union으로 수집. basic1과 동일 정렬 셋을 공유해야
  // basic1 union으로 들어온 모든 선수(도루·안타 정렬 포함)의 b2 데이터가 미스 없이 채워짐.
  // 추가로 BB/KK/HP/GD 정렬을 넣어 각 누적 부문 리더(예: 김재환 BB, 송찬의 HBP)까지 커버.
  const basic2Sorts = [...basic1Sorts, "BB_CN", "KK_CN", "HP_CN", "GD_CN"];

  const [basic1Htmls, basic2Htmls, runnerResult] = await Promise.all([
    Promise.all(basic1Sorts.map((s) => fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=${s}`, signal))),
    Promise.all(basic2Sorts.map((s) => fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic2.aspx?sort=${s}`, signal))),
    fetchAllRunnerRows(fetch, signal)
      .then((rows) => ({ rows, live: true as const }))
      .catch((error) => {
        console.warn("[stats] Runner full crawl failed; using static fallback", error);
        return { rows: [] as string[][], live: false as const };
      }),
  ]);
  const basic1Tables = basic1Htmls.map(parseTable);
  const basic2Tables = basic2Htmls.map(parseTable);
  // ⚠️ 행 identity(공식 playerId)도 스키마 계약이다(삼순 #1196 1차 P0). 결손 행을
  // `이름::팀` 으로 혼합 흡수하지 않고 전체 fallback 으로 fail-close 한다.
  if (
    basic1Tables.some(
      (table) =>
        table.length < KBO_TABLE_MIN_ROWS ||
        table.some((row) => row.length < 16 || !row[1]?.trim() || !row[2]?.trim() || !rowKboId(row)),
    ) ||
    basic2Tables.some(
      (table) =>
        table.length < KBO_TABLE_MIN_ROWS ||
        table.some((row) => row.length < 12 || !row[1]?.trim() || !row[2]?.trim() || !rowKboId(row)),
    )
  ) {
    throw new Error("KBO batter stats table incomplete");
  }

  // Basic1 union — identity(playerId exact 우선)로 병합 (각 정렬 상위 30 합집합).
  // `이름::팀` 이면 같은 팀 동명이인의 source row 자체가 서로를 가린다(#1100 4차 P0-3).
  const rows = mergeBasicRows(basic1Tables);

  // Basic2 union (OBP/OPS/SLG 등) — 테이블 경계를 유지해 소스별 중복을 판정한다(아래 주석).
  // 규정타석 충족 선수 셋 — 비율스탯 리더보드(규정타석만 노출) union
  // (단일 HRA_RT는 타율 31위↓ 규정타석 선수를 놓쳐 OPS/OBP/SLG 랭킹 누락 유발)
  const qualifiedKeys = new Set<string>();
  for (const sort of rateSorts) {
    const idx = basic1Sorts.indexOf(sort);
    for (const c of basic1Tables[idx]) {
      // ⚠️ 저장키와 조회키가 갈라지면 규정타석 플래그가 전부 0 이 된다 — 병합과 같은 키.
      qualifiedKeys.add(rowKboId(c));
    }
  }

  // Basic2 lookup: identity → { bb, ibb, hbp, so, gdp, slg, obp, ops }
  // ⚠️ 같은 테이블 내 중복 ID · 테이블 간 name/team 충돌은 조용한 덮어쓰기가 아니라
  // fail-close 다(삼순 #1196 2차 P0).
  const basic2Map = new Map<string, Basic2Entry>();
  const basic2RowByKey = new Map<string, ParsedTableRow>();
  for (const table of basic2Tables) {
    const seenInTable = new Set<string>();
    for (const c of table) {
      const key = rowKboId(c);
      if (seenInTable.has(key)) throw new Error(`KBO stats row identity duplicated in table: ${key}`);
      seenInTable.add(key);
      const existing = basic2RowByKey.get(key);
      if (existing) {
        assertRowIdentityConsistent(existing, c, key);
        continue;
      }
      basic2RowByKey.set(key, c);
      basic2Map.set(key, {
        bb: parseInt(c[4]) || 0,
        ibb: parseInt(c[5]) || 0,
        hbp: parseInt(c[6]) || 0,
        so: parseInt(c[7]) || 0,
        gdp: parseInt(c[8]) || 0,
        slg: c[9] || ".000",
        obp: c[10] || ".000",
        ops: c[11] || ".000",
      });
    }
  }
  const missingBasic2 = rows.map(rowKboId).filter((key) => !basic2Map.has(key));
  if (missingBasic2.length > 0) {
    throw new Error(
      `KBO batter Basic2 join incomplete: missing=${missingBasic2.length}`,
    );
  }
  // ⚠️ Basic1↔Basic2 교차 식별 충돌(삼순 #1196 3차 P0-2): 같은 kboId 가 두 표에서
  // 다른 name/team 이면 다른 사람의 수치가 조용히 붙는다 — join 전체 fail-close.
  for (const row of rows) {
    const b2row = basic2RowByKey.get(rowKboId(row));
    if (b2row) assertRowIdentityConsistent(row, b2row, rowKboId(row));
  }

  // Runner 전 페이지 live 수집이 완전히 성공했을 때만 사용한다. 일부 페이지만 성공한 결과와
  // static을 선수별로 섞지 않고, WebForms 수집이 실패한 요청에 한해 static 전체를 최종 fallback.
  // ⚠️ Runner 가 수집은 됐는데 identity 가 깨졌으면(결손/중복) 부분 혼합이 아니라
  // **전체 fail-close** 다 — buildRunnerMap 이 throw 해 batter 전체가 fallback 으로 넘어간다
  // (삼순 #1196 1차: live+static 혼합으로 남기지 말 것). 수집 자체가 실패한 경우
  // (live=false)만 기존 static Runner 전체 fallback 경로를 탄다.
  const runnerMap = runnerResult.live
    ? buildRunnerMap(runnerResult.rows)
    : new Map<string, RunnerStat>();
  // HTTP 200이어도 pager가 조기 종료될 수 있다. 최종 full 후보(live union + static 전체)를
  // Runner map이 모두 덮지 못하면 부분 live 전체를 폐기하고 static fallback으로 전환한다.
  // ⚠️ 요구 키도 kboId 다. live 행은 위 검증으로 전부 ID 보유가 보장된다.
  const requiredRunnerKeys = new Set(
    [
      ...rows.map(rowKboId),
      ...(batterStats2026 as unknown as PlayerStat[]).map((p) =>
        canonicalKboId(String(p.kboId || "").trim()),
      ),
    ].filter((key) => key !== ""),
  );
  const runnerLiveAccepted =
    runnerResult.live &&
    [...requiredRunnerKeys].every((key) => runnerMap.has(key));
  if (!runnerLiveAccepted) {
    runnerMap.clear();
    for (const p of batterStats2026 as unknown as PlayerStat[]) {
      const key = canonicalKboId(String(p.kboId || "").trim());
      if (key) runnerMap.set(key, { sb: Number(p.sb) || 0, cs: Number(p.cs) || 0 });
    }
  }

  const stats = rows.map((c, i) => buildBatterStat(c, i, basic2Map, qualifiedKeys));
  return {
    stats,
    runnerMap,
    runnerSource: runnerLiveAccepted ? "live" : "static-fallback",
    runnerUpdatedAt: runnerLiveAccepted ? new Date().toISOString() : statsMeta.battersGeneratedAt,
  };
}

/**
 * Runner 수집 행 → kboId exact 도루 map.
 *
 * ⚠️ 키는 **kboId exact** 다(#1100 4차 P0-3). ID 결손·중복 행은 skip(혼합)이 아니라
 * **throw** 다(삼순 #1196 1차 P0) — identity 무결성이 깨진 live 세트는 통째로 폐기하고
 * 전체 fallback 으로 닫는다.
 * (export 는 identity 게이트가 실제 배포 함수를 태우기 위해서다 — 인라인이면 되돌려도 GREEN.)
 */
export function buildRunnerMap(rows: ParsedTableRow[]): Map<string, RunnerStat> {
  const runnerMap = new Map<string, RunnerStat>();
  for (const c of rows) {
    const key = rowKboId(c);
    if (!key) throw new Error("KBO runner row identity missing");
    if (runnerMap.has(key)) throw new Error(`KBO runner row identity duplicated: ${key}`);
    runnerMap.set(key, {
      sb: parseInt(c[5]) || 0,
      cs: parseInt(c[6]) || 0,
    });
  }
  return runnerMap;
}

export interface Basic2Entry {
  bb: number; ibb: number; hbp: number; so: number; gdp: number;
  slg: string; obp: string; ops: string;
}

/**
 * KBO Basic1 행 1개 → 응답 stat 객체.
 *
 * ⚠️ 순수 함수로 따로 뽑은 이유(#1100 삼순 8차 P0-2/P0-3): 출력 `kboId`·`qualifiedRate` 가
 * identity 계약의 종단인데, 인라인 클로저 안에 있으면 게이트가 호출할 수 없어
 * 그 줄을 되돌려도 GREEN 이된다. 게이트는 이 **실제 배포 함수**를 그대로 실행한다.
 */
export function buildBatterStat(
  c: ParsedTableRow,
  i: number,
  basic2Map: Map<string, Basic2Entry>,
  qualifiedKeys: Set<string>,
) {
  const name = (c[1] || "").trim();
  const team = (c[2] || "").trim();
  // ⚠️ KBO 원본 playerId 가 **canonical identity** 다. 로스터 이름 조회(resolvePlayer)는
  // 같은 팀 동명이인을 first-match 로 합치므로 fallback 으로도 쓰지 않는다(삼순 #1196 1차 P0)
  // — ID 없는 행은 정답 추정 대신 fail-close.
  const rowId = rowKboId(c);
  if (!rowId) throw new Error("KBO batter row identity missing");
  const b2 = basic2Map.get(rowId);
  return {
    rank: i + 1,
    name,
    team,
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
    // Basic2 stats
    bb: b2?.bb || 0,
    ibb: b2?.ibb || 0,
    hbp: b2?.hbp || 0,
    so: b2?.so || 0,
    gdp: b2?.gdp || 0,
    slg: b2?.slg || ".000",
    obp: b2?.obp || ".000",
    ops: b2?.ops || ".000",
    // Runner stats
    sb: 0,
    cs: 0,
    kboId: rowId,
    playerId: rowId,
    // ⚠️ 저장키(rowKboId)와 같은 키로 조회해야 한다 — 갈라지면 전부 0 이 된다.
    qualifiedRate: qualifiedKeys.has(rowId) ? 1 : 0,
  };
}

export function applyRunnerStats<T extends PlayerStat>(
  stats: T[],
  runnerMap: Map<string, RunnerStat>,
): T[] {
  return stats.map((player) => {
    // kboId exact — `이름::팀` 은 같은 팀 동명이인이 서로의 도루를 덮어쓴다(#1100 4차 P0-3).
    const kboId = canonicalKboId(String(player.kboId || "").trim());
    const runner = kboId ? runnerMap.get(kboId) : undefined;
    return {
      ...player,
      sb: runner?.sb ?? (Number(player.sb) || 0),
      cs: runner?.cs ?? (Number(player.cs) || 0),
    };
  });
}

function parsePitcherRow(c: ParsedTableRow): PlayerStat {
  const name = c[1] || "";
  const team = c[2] || "";
  const officialId = canonicalKboId(c.playerId);
  // ⚠️ 로스터 이름 조회 fallback 없음(삼순 #1196 1차 P0) — ID 결손은 fail-close.
  if (!officialId) throw new Error("KBO pitcher row identity missing");
  const found = { kboId: officialId };
  return {
    rank: 0,
    name,
    team: c[2] || "",
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
    kboId: found?.kboId || "",
    playerId: found?.kboId || "",
  };
}

async function fetchPitcherStats(signal?: AbortSignal): Promise<PlayerStat[]> {
  // ERA_RT는 규정이닝 투수만 반환 (시즌초 17명 등), SV/HOLD/W/KK/INN2는 전체 30명
  // 여러 정렬로 크롤링 후 병합해야 세이브/홀드/이닝 리더가 빠지지 않음.
  // INN2_CN(이닝) 미포함 시 규정이닝 미달 이닝이터(선발 기량투수)가 라이브 집합에서 전부 누락된다.
  const sortKeys = ["ERA_RT", "SV_CN", "HOLD_CN", "W_CN", "KK_CN", "INN2_CN"];
  const merged = new Map<string, PlayerStat>(); // key: canonical kboId
  const qualifiedKeys = new Set<string>(); // ERA_RT 페이지에 나오는 규정이닝 충족 선수

  const results = await Promise.all(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url, signal);
      const rows = parseTable(html);
      // ERA_RT는 규정이닝 충족자만 내려와 현재 정상 응답도 19행이다.
      // 나머지 누적 정렬은 정상 페이지의 30행 계약을 그대로 요구한다.
      const minimumRows = sort === "ERA_RT" ? 15 : KBO_TABLE_MIN_ROWS;
      // ⚠️ 행 identity 결손도 스키마 계약 위반이다 — 혼합 없이 전체 fallback (삼순 #1196 1차 P0).
      if (
        rows.length < minimumRows ||
        rows.some((row) => row.length < 19 || !row[1]?.trim() || !row[2]?.trim() || !rowKboId(row))
      ) {
        throw new Error(`KBO pitcher stats ${sort} table incomplete`);
      }
      return { sort, rows };
    })
  );

  const pitcherRowByKey = new Map<string, ParsedTableRow>();
  for (const { sort, rows } of results) {
    const seenInTable = new Set<string>();
    for (const c of rows) {
      // 타자와 같은 identity 계약 — kboId exact만. 결손은 위 검증에서 이미 fail-close 됐다.
      // 중복 규칙도 타자와 동일(삼순 #1196 2차 P0): 같은 테이블 내 재등장 throw · 테이블 간 충돌 throw.
      const key = rowKboId(c);
      if (seenInTable.has(key)) throw new Error(`KBO stats row identity duplicated in table: ${key}`);
      seenInTable.add(key);
      if (sort === "ERA_RT") {
        qualifiedKeys.add(key);
      }
      const existing = pitcherRowByKey.get(key);
      if (existing) {
        assertRowIdentityConsistent(existing, c, key);
        continue;
      }
      pitcherRowByKey.set(key, c);
      merged.set(key, parsePitcherRow(c));
    }
  }

  // ⚠️ 규정이닝 플래그는 **병합과 같은 키**로 판정한다(#1100 삼순 8차 P0-3:
  // 저장키와 조회키가 갈라지면 플래그가 전부 0 이 된다). 재구성 전 map 엔트리에서 먼저 찍는다.
  for (const [key, p] of merged) {
    p.qualifiedRate = qualifiedKeys.has(key) ? 1 : 0;
  }

  // ERA 기준 정렬 후 순위 부여
  const stats = [...merged.values()]
    .sort((a, b) => Number(a.era || 99) - Number(b.era || 99));
  stats.forEach((p, i) => {
    p.rank = i + 1;
  });
  return stats;
}

interface StatsResult {
  stats: PlayerStat[];
  type: string;
  count: number;
  source?: string;
  updatedAt?: string; // ISO. 라이브(타자/투수)=fetch 시각 / 수비=일일 크롤 시각(meta)
  runnerSource?: RunnerSource;
  runnerUpdatedAt?: string;
}

const cache: Record<string, { data: StatsResult; ts: number }> = {};

// 경기시간대(KST 11~24시) 10분, 그 외 1시간 — 더블헤더/주말 조기경기 대응
function getCacheTtl(): number {
  const kstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  return kstHour >= 11 && kstHour < 24 ? 10 * 60 * 1000 : 60 * 60 * 1000;
}

// 엣지캐시는 remaining-TTL 방식 — 인메모리 엔트리의 잔여 수명만큼만 캐시해
// 총 stale 상한 = TTL 1회분(기존과 동일)으로 고정한다(삼순 NO-GO #2: TTL 누적 금지).
// SWR 미사용·degraded(fallback/runner static-fallback)/에러 응답 캐시 금지(#1114 동일 축).
function edgeCacheHeaders(ageMs: number): Record<string, string> {
  const remainingSec = Math.max(1, Math.floor((getCacheTtl() - ageMs) / 1000));
  return { "Cache-Control": `public, s-maxage=${remainingSec}` };
}
const NO_STORE = { "Cache-Control": "no-store" } as const;

// degraded 구성요소(runner static-fallback 혼합 포함)는 엣지에 고정되면 회복이 지연된다 — 캐시 금지(삼순 NO-GO #4).
function statsEdgeHeaders(result: StatsResult, ageMs: number): Record<string, string> {
  if (result.runnerSource === "static-fallback" || result.source === "fallback") return NO_STORE;
  return edgeCacheHeaders(ageMs);
}

function getCached(key: string): { data: StatsResult; ageMs: number } | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < getCacheTtl()) return { data: entry.data, ageMs: Date.now() - entry.ts };
  return null;
}
function setCache(key: string, data: StatsResult) {
  cache[key] = { data, ts: Date.now() };
}

/**
 * 응답 행의 `kboId`·`playerId` 를 **canonical 값으로 rewrite** 한다(삼순 #1196 4차).
 *
 * ⚠️ static JSON 은 외국인을 숫자ID(56950 등)로 들고 있다(실측 타자 11·투수 21명).
 * 검증만 하고 raw 를 그대로 내보내면 하류(앱·봇)가 live(영문ID)와 static(숫자ID)을
 * 다른 사람으로 본다. 결손은 fail-close.
 * export 는 identity 게이트가 실제 배포 함수를 태우기 위해서다.
 */
export function canonicalizeStatsIdentity<T extends PlayerStat>(stats: T[]): T[] {
  return stats.map((row) => {
    const id = canonicalKboId(String(row.kboId || "").trim());
    if (!id) throw new Error(`KBO stats identity missing: ${row.name}::${row.team}`);
    return { ...row, kboId: id, playerId: id };
  });
}

/**
 * 같은 canonical ID 가 여러 번 들어있는 static 행을 접는다(삼순 #1196 5차).
 *
 * ⚠️ 2025 투수 static 은 **rank 를 제외하면 완전히 동일한 행**이 30쌍 들어있다(실측).
 * 즉 현재 프로덕션은 같은 선수를 두 번씩 노출하고 있다. 동일 행은 접고,
 * 값이 다른 동일 ID(서로 다른 선수가 같은 ID 를 가진 진짜 오염)는 throw 해 fail-close 한다.
 * — 그냥 dedupe 하면 오염까지 조용히 숨고, 그냥 throw 하면 멀줦한 중복까지 500 이 된다.
 */
export function collapseIdenticalStatRows<T extends PlayerStat>(stats: T[]): T[] {
  const byId = new Map<string, T>();
  const out: T[] = [];
  const fingerprint = (row: T): string => {
    const { rank: _rank, ...rest } = row as T & { rank?: unknown };
    void _rank;
    return JSON.stringify(rest);
  };
  for (const row of stats) {
    const id = String(row.kboId || "").trim();
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, row);
      out.push(row);
      continue;
    }
    if (fingerprint(existing) !== fingerprint(row)) {
      throw new Error(`KBO stats identity conflict (static duplicate with different values): ${id}`);
    }
    // rank 만 다른 완전 동일 행 — 중복 노출 제거.
  }
  return out;
}

/**
 * full=1 최종 응답(라이브 + static 보강 merge 후)의 identity 종단 가드.
 * 빈 ID · 중복 ID 가 하나라도 남으면 서빙하지 않고 throw → 전체 static fallback
 * (삼순 #1196 2차 P0: mergeFullEntry 의 name::team 보조경로가 무시되는 것을 종단에서 막는다).
 * export 는 identity 게이트가 실제 배포 함수를 태우기 위해서다.
 */
export function assertFullEntryIdentity(stats: PlayerStat[]): void {
  const ids = stats.map((row) => canonicalKboId(String(row.kboId || "").trim()));
  const missing = ids.filter((id) => !id).length;
  if (missing > 0) throw new Error(`KBO full-entry identity missing: ${missing} rows`);
  if (new Set(ids).size !== ids.length) throw new Error("KBO full-entry identity duplicated");
}

// ⚠️ export 는 identity 게이트가 실제 배포 함수를 태우기 위해서다.
export function assertStatsComplete(stats: PlayerStat[], type: "batter" | "pitcher"): void {
  const minimum = 30;
  const teamCounts = new Map<string, number>();
  for (const row of stats) {
    const team = row.team.trim();
    if (team) teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
  }
  // ⚠️ uniqueness 판정도 identity 다 — `이름::팀` 이면 정상인 같은 팀 동명이인 2행을
  // 중복으로 오판해 partial 로 던진다. 이름 fallback 없음 — ID 결손 행은 그 자체로 partial 다
  // (삼순 #1196 1차 P0: 빈/오인 ID 가 정상 응답으로 통과하면 안 된다).
  const ids = stats.map((row) => canonicalKboId(String(row.kboId || "").trim()));
  if (ids.some((id) => !id)) {
    throw new Error(`KBO ${type} stats identity missing: ${ids.filter((id) => !id).length} rows`);
  }
  const players = new Set(ids);
  const perTeamMinimum = KBO_TEAM_MINIMUM[type];
  const allTeamsCovered = [...KBO_TEAM_NAMES].every(
    (team) => (teamCounts.get(team) || 0) >= perTeamMinimum,
  );
  if (
    stats.length < minimum ||
    players.size !== stats.length ||
    teamCounts.size !== KBO_TEAM_NAMES.size ||
    !allTeamsCovered
  ) {
    throw new Error(
      `KBO ${type} stats partial: rows=${stats.length}, unique=${players.size}, ` +
        `teams=${teamCounts.size}, minTeam=${Math.min(...teamCounts.values())}`,
    );
  }
}

async function fetchCurrentStats(
  type: "batter" | "pitcher",
): Promise<{
  stats: PlayerStat[];
  source: "live" | "naver-fallback";
  runnerSource?: RunnerSource;
  runnerUpdatedAt?: string;
  runnerMap?: Map<string, RunnerStat>;
}> {
  const deadlineAt = Date.now() + STATS_TOTAL_DEADLINE_MS;
  const kboController = new AbortController();
  const kboTimer = setTimeout(() => kboController.abort(), STATS_KBO_BUDGET_MS);
  try {
    if (type === "pitcher") {
      const stats = await fetchPitcherStats(kboController.signal);
      assertStatsComplete(stats, type);
      return { stats, source: "live" };
    }
    const live = await fetchBatterStats(kboController.signal);
    assertStatsComplete(live.stats, type);
    return {
      stats: live.stats,
      source: "live",
      runnerSource: live.runnerSource,
      runnerUpdatedAt: live.runnerUpdatedAt,
      runnerMap: live.runnerMap,
    };
  } catch (error) {
    const message = (error as Error).message;
    console.warn(
      `[stats] KBO ${type} failed, using Naver:`,
      message,
    );
    const reason = /abort|timeout|deadline/i.test(message)
      ? "timeout"
      : /HTTP/i.test(message)
        ? "http-error"
        : "schema-error";
    void import("@/lib/monitoring/api-fallback-tracker")
      .then(({ trackFallback }) =>
        trackFallback(`kbo-player-stats-${type}`, reason, {
          errorMessage: message,
        }),
      )
      .catch(() => {});
    const fallback = type === "pitcher"
      ? (pitcherStats2026 as unknown as NaverPlayerStat[])
      : (batterStats2026 as unknown as NaverPlayerStat[]);
    const stats = await fetchNaverPlayerStats(
      type,
      2026,
      deadlineAt,
      fallback,
    );
    return { stats: stats as PlayerStat[], source: "naver-fallback" };
  } finally {
    clearTimeout(kboTimer);
    kboController.abort();
  }
}

export function handleStatsGetFailure(
  error: unknown,
  season: string,
  type: string,
  now = new Date(),
  // ⚠️ 게이트 주입용(오염 fallback → 500 검증). production 호출은 항상 생략 → static 사용.
  fallbackOverride?: PlayerStat[],
): NextResponse {
  // ⚠️ 이 함수의 모든 응답은 degraded(또는 에러)다 — **엣지 캐시 금지**(main #1166 계약).
  //   fallback 이 CDN 에 고정되면 크롤이 회복돼도 stale 이 계속 서빙된다.
  // freshness 계약 실패는 "크롤 실패"가 아니다. 같은 오염 static을 fallback 200으로
  // 다시 내보내면 fail-close가 무효화된다(삼순 #1159 5차 NO-GO).
  if (error instanceof StatsFreshnessContractError) {
    return NextResponse.json({ error: error.message, stats: [] }, { status: 500, headers: NO_STORE });
  }
  // 크롤링 실패 시 static JSON fallback (빈화면 방지). 단 fallback 자체의 구성시각도
  // 동일 freshness 계약을 통과해야 하며 미래/invalid면 500 fail-close 한다.
  if (season === "2026" || season === "current") {
    const fallback = fallbackOverride ?? (type === "pitcher"
      ? (pitcherStats2026 as unknown as PlayerStat[])
      : (batterStats2026 as unknown as PlayerStat[]));
    // ⚠️ fallback 자체도 identity 계약을 통과해야 200 을 받는다(삼순 #1196 3차 P0-1:
    // 종단 가드가 throw 해도 같은 오염 static 을 200 으로 되돌려주면 fail-close 가 무효다).
    // rewrite(외국인 숫자→canonical, 4차) 후 중복 검증, 오염이면 500/no-store fail-close.
    let served: PlayerStat[];
    try {
      served = canonicalizeStatsIdentity(fallback);
      assertFullEntryIdentity(served);
    } catch (identityError) {
      return NextResponse.json(
        { error: (identityError as Error).message, stats: [] },
        { status: 500, headers: NO_STORE },
      );
    }
    const fbAt = type === "pitcher" ? statsMeta.pitchersGeneratedAt : statsMeta.battersGeneratedAt;
    const validFbAt = oldestFullEntryTimestamp([fbAt], now);
    if (!validFbAt) {
      return NextResponse.json({ error: "stats fallback has invalid freshness", stats: [] }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json({
      stats: served, type, count: served.length, season: 2026, source: "fallback", updatedAt: validFbAt,
    }, { headers: NO_STORE });
  }
  return NextResponse.json({ error: (error as Error).message, stats: [] }, { status: 500, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  const season = req.nextUrl.searchParams.get("season") || "current";
  const full = req.nextUrl.searchParams.get("full") === "1";

  // 2025 시즌 — 확정 static data (300 batters + 277 pitchers)
  // ⚠️ static 은 외국인을 숫자ID 로 든다(실측 2025 타자 1·투수 4명) → canonical rewrite 후 반환
  // (삼순 #1196 5차: 직반환 분기도 kboId·playerId 계약을 지켜야 하류가 동일인을 같은 사람으로 본다).
  if (season === "2025") {
    const raw = type === "pitcher"
      ? (pitcherStats2025 as unknown as PlayerStat[])
      : (batterStats2025 as unknown as PlayerStat[]);
    let stats: PlayerStat[];
    try {
      stats = collapseIdenticalStatRows(canonicalizeStatsIdentity(raw));
      assertFullEntryIdentity(stats);
    } catch (identityError) {
      return NextResponse.json(
        { error: (identityError as Error).message, stats: [] },
        { status: 500, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { stats, type, count: stats.length, season: 2025 },
      { headers: { "Cache-Control": "public, s-maxage=3600" } }, // 확정 static 데이터
    );
  }

  // 수비 — 라이브 fetch 불가(KBO 수비페이지 POST 차단) → 정적 크롤 JSON(매일 CI 갱신) 집계
  // ⚠️ **집계 전** 키부터 canonical 로 통일한다(삼순 #1196 5차). aggregateDefense 는 kboId 로
  // 포지션별 행을 묶으므로, raw 숫자ID와 canonical 영문ID 가 섞이면 같은 선수의 수비가
  // 두 덩어리로 쪼개진다. 집계 후 rewrite 는 이미 깨진 집계를 못 되돌린다.
  if (type === "defense") {
    let stats: PlayerStat[];
    try {
      const canonicalRows = (defenseStats2026 as unknown as DefenseRow[]).map((row) => {
        const id = canonicalKboId(String(row.kboId || "").trim());
        if (!id) throw new Error(`KBO defense identity missing: ${row.name}::${row.team}`);
        return { ...row, kboId: id };
      });
      stats = canonicalizeStatsIdentity(
        aggregateDefense(canonicalRows) as unknown as PlayerStat[],
      );
      assertFullEntryIdentity(stats);
    } catch (identityError) {
      return NextResponse.json(
        { error: (identityError as Error).message, stats: [] },
        { status: 500, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { stats, type, count: stats.length, season: 2026, source: "static", updatedAt: statsMeta.defenseGeneratedAt },
      { headers: { "Cache-Control": "public, s-maxage=3600" } }, // 일일 크롤 static
    );
  }

  // 2026 시즌 + current — 라이브 크롤링 (캐시: 경기시간대 10분 / 평시 1시간)
  const cacheKey = `stats-${type}-${season}${full ? "-full" : ""}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached.data, { headers: statsEdgeHeaders(cached.data, cached.ageMs) });

  try {
    const statsType = type === "pitcher" ? "pitcher" : "batter";
    const current = await fetchCurrentStats(statsType);
    const staticStats = statsType === "pitcher"
      ? (pitcherStats2026 as unknown as PlayerStat[])
      : (batterStats2026 as unknown as PlayerStat[]);
    let stats = full ? mergeFullEntry(current.stats, staticStats) : current.stats;
    if (current.runnerMap) {
      // full=1로 static에서 추가된 선수도 같은 전페이지 live Runner map으로 마지막에 보정한다.
      stats = applyRunnerStats(stats, current.runnerMap);
    }
    // ⚠️ full=1 종단 — 응답 ID 를 canonical 로 rewrite(외국인 숫자→영문, 삼순 #1196 4차) 한 뒤
    // 빈/중복 ID 가 남으면 서빙 금지(삼순 #1196 2차 P0).
    if (full) {
      stats = canonicalizeStatsIdentity(stats);
      assertFullEntryIdentity(stats);
    }
    const now = new Date().toISOString();
    const currentUpdatedAt = current.runnerSource === "static-fallback"
      ? current.runnerUpdatedAt
      : now;
    const staticGeneratedAt = statsType === "pitcher"
      ? statsMeta.pitchersGeneratedAt
      : statsMeta.battersGeneratedAt;
    // full=1은 live 목록에 static 비규정 엔트리를 합친 응답이다. runner가 live여도
    // static 생성시각을 숨기고 `now`만 내보내면 봇의 stale 가드가 우회된다.
    const updatedAt = full
      ? requireOldestFullEntryTimestamp([currentUpdatedAt, staticGeneratedAt])
      : currentUpdatedAt;
    const result: StatsResult = {
      stats,
      type,
      count: stats.length,
      source:
        current.source === "naver-fallback"
          ? current.source
          : current.runnerSource === "static-fallback"
            ? "live+static-runner-fallback"
            : "live",
      // 혼합 응답은 가장 오래된 구성요소 시각을 대표 freshness로 노출한다.
      updatedAt,
      ...(current.runnerSource
        ? {
            runnerSource: current.runnerSource,
            runnerUpdatedAt: current.runnerUpdatedAt,
          }
        : {}),
    };
    setCache(cacheKey, result);
    return NextResponse.json(result, { headers: statsEdgeHeaders(result, 0) });
  } catch (e: unknown) {
    // degraded fallback·에러는 엣지 캐시 금지 — 회복 즉시 live 복귀(main #1166 계약).
    //   그 헤더는 handleStatsGetFailure 안에서 붙인다(분기마다 빠뜨리지 않게).
    return handleStatsGetFailure(e, season, type);
  }
}
