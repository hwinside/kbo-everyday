import { NextRequest, NextResponse } from "next/server";
import playersRoster from "@/lib/constants/players-roster.json";
import batterStats2025 from "@/lib/constants/stats-2025-batters.json";
import pitcherStats2025 from "@/lib/constants/stats-2025-pitchers.json";
import batterStats2026 from "@/lib/constants/stats-2026-batters.json";
import pitcherStats2026 from "@/lib/constants/stats-2026-pitchers.json";
import defenseStats2026 from "@/lib/constants/stats-2026-defense.json";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import type { RosterPlayer } from "@/types/api";
import { canonicalKboId, resolvePlayer } from "@/lib/utils/resolve-player";
import { aggregateDefense, type DefenseRow } from "@/lib/utils/defense-aggregate";
import { mergeFullEntry } from "@/lib/stats/full-entry";
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

/**
 * Runner 행의 **KBO playerId** 를 순서대로 뽑는다.
 *
 * ⚠️ 왜 필요한가 (삼순 #1100 4차 P0-3):
 * `parseTable` 은 태그를 지워 텍스트만 남기므로 이름·팀만 남는다. 그래서
 * Runner 병합 키가 `이름::팀` 이었고, **같은 팀 동명이인**이 서로의 도루 값을
 * 덮어쉗다. 로스터 실측 7그룹 존재(이주형/키움, 이승현/삼성 등),
 * production `/api/stats` 응답에서도 이주형 2행이 같은 키로 묶이는 것을 확인했다.
 * 하류 kboId 필터는 **이미 오염된 값**을 복구하지 못하므로 병합 시점에 identity 로 묶는다.
 *
 * KBO Runner 행은 선수명 셀에 `HitterDetail/Basic.aspx?playerId=50500` 앱커를 담고 있다.
 */
export function parseRowPlayerIds(html: string): Array<string | null> {
  const ids: Array<string | null> = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return ids;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return ids;
  for (const tr of trMatches) {
    if (!/<td[^>]*>/i.test(tr)) continue;
    ids.push(tr.match(/playerId=(\d+)/i)?.[1] ?? null);
  }
  return ids;
}

/** 하위호환 별칭 — Runner 전용으로 쓰이던 이름. 동작은 동일하다. */
export const parseRunnerPlayerIds = parseRowPlayerIds;

/**
 * 표를 파싱하면서 **행 끝에 KBO playerId 를 붙인다**.
 *
 * ⚠️ 왜 Basic1/Basic2 에도 필요한가 (삼순 #1100 7차 P0-2):
 * Runner 병합만 kboId 로 고쳐도, 그 **앞단**인 Basic1 union·Basic2 lookup 이 여전히
 * `이름::팀` + first-match 라 같은 팀 동명이인의 source row 자체가 서로를 가린다.
 * 하류에서 kboId 를 붙여봐야 이미 다른 선수 값이다.
 */
export function parseTableWithIds(html: string): string[][] {
  const rows = parseTable(html);
  const ids = parseRowPlayerIds(html);
  return rows.map((row, i) => [...row, ids[i] ?? ""]);
}

/** `parseTableWithIds` 가 붙인 playerId 를 읽는다(항상 마지막 셀). */
export function rowPlayerId(row: string[]): string {
  return canonicalKboId((row[row.length - 1] || "").trim());
}

/**
 * KBO 표 행의 **병합 키**. playerId exact 우선, 없는 행만 이름::팀 하위호환.
 *
 * ⚠️ production 과 게이트가 **같은 함수**를 타야 한다(삼순 #1100 7차 P0-2).
 * 게이트가 같은 규칙을 재구현하면 production 을 `이름::팀` 으로 되돌려도
 * GREEN 이다 — 실제로 내가 한 번 그렇게 만들어 mutation 2종을 놓쳤다.
 */
export function statsRowKey(row: string[]): string {
  return rowPlayerId(row) || `${(row[1] || "").trim()}::${(row[2] || "").trim()}`;
}

/**
 * Basic1 union — 각 정렬 상위 30 합집합을 **identity 로** 묶는다.
 * production 경로와 게이트가 공유하는 유일한 구현이다.
 */
export function mergeBasicRows(tables: string[][][]): string[][] {
  const merged = new Map<string, string[]>();
  for (const table of tables) {
    for (const row of table) {
      const key = statsRowKey(row);
      if (key !== "::" && !merged.has(key)) merged.set(key, row);
    }
  }
  return [...merged.values()];
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const tbody = tbodyMatch[1];
  const trMatches = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        const text = td.replace(/<[^>]+>/g, "").trim();
        cells.push(text);
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
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
): Promise<string[][]> {
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
    const rows: string[][] = [];
    const seenPages = new Set<number>();
    while (true) {
      const page = runnerCurrentPage(html);
      if (seenPages.has(page)) throw new Error(`Runner pager loop at page ${page}`);
      if (page !== seenPages.size + 1) {
        throw new Error(`Runner pager skipped: expected ${seenPages.size + 1}, got ${page}`);
      }
      seenPages.add(page);
      const pageRows = parseTable(html);
      const pageIds = parseRunnerPlayerIds(html);
      // playerId 를 행 끝에 붙여 호출부가 identity 로 묶을 수 있게 한다(삼순 4차 P0-3).
      // 기존 인덱스(0~9)는 그대로라 읽는 쪽 계약은 깨지지 않는다.
      rows.push(...pageRows.map((row, index) => [...row, pageIds[index] ?? ""]));

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
  const roster = playersRoster as RosterPlayer[];

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
  // ⚠️ `parseTableWithIds` — 행 끝에 KBO playerId 를 붙여 source-row identity 를 살린다
  // (삼순 #1100 7차 P0-2). 종전에는 Basic1 union·Basic2 lookup 이 `이름::팀` first-match 라
  // 같은 팀 동명이인의 원본 행 자체가 서로를 가렸다 — 하류 Runner 병합만 kboId 로 고쳐도
  // 이미 다른 선수 값이라 복구되지 않는다.
  const basic1Tables = basic1Htmls.map(parseTableWithIds);
  const basic2Tables = basic2Htmls.map(parseTableWithIds);
  if (
    basic1Tables.some(
      (table) =>
        table.length < KBO_TABLE_MIN_ROWS ||
        // ⚠️ `parseTableWithIds` 가 playerId 셀 1개를 더 붙이므로 임계도 +1 이다.
        table.some((row) => row.length < 17 || !row[1]?.trim() || !row[2]?.trim()),
    ) ||
    basic2Tables.some(
      (table) =>
        table.length < KBO_TABLE_MIN_ROWS ||
        table.some((row) => row.length < 13 || !row[1]?.trim() || !row[2]?.trim()),
    )
  ) {
    throw new Error("KBO batter stats table incomplete");
  }

  // Basic1 union: name::team 최초 우선으로 병합 (각 정렬 상위 30 합집합)
  const rows = mergeBasicRows(basic1Tables);

  // Basic2 union (OBP/OPS/SLG 등)
  const basic2Rows = basic2Tables.flat();
  // 규정타석 충족 선수 셋 — 비율스탯 리더보드(규정타석만 노출) union
  // (단일 HRA_RT는 타율 31위↓ 규정타석 선수를 놓쳐 OPS/OBP/SLG 랭킹 누락 유발)
  const qualifiedKeys = new Set<string>();
  for (const sort of rateSorts) {
    const idx = basic1Sorts.indexOf(sort);
    for (const c of basic1Tables[idx]) {
      qualifiedKeys.add(statsRowKey(c));
    }
  }

  // Basic2 lookup: name+team → { bb, ibb, hbp, so, gdp, slg, obp, ops }
  const basic2Map = new Map<string, { bb: number; ibb: number; hbp: number; so: number; gdp: number; slg: string; obp: string; ops: string }>();
  for (const c of basic2Rows) {
    const key = statsRowKey(c);
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
  const missingBasic2 = rows.map(statsRowKey).filter((key) => !basic2Map.has(key));
  if (missingBasic2.length > 0) {
    throw new Error(
      `KBO batter Basic2 join incomplete: missing=${missingBasic2.length}`,
    );
  }

  // Runner 전 페이지 live 수집이 완전히 성공했을 때만 사용한다. 일부 페이지만 성공한 결과와
  // static을 선수별로 섞지 않고, WebForms 수집이 실패한 요청에 한해 static 전체를 최종 fallback.
  //
  // ⚠️ 키는 **kboId exact** 다(삼순 4차 P0-3). `이름::팀` 으로 묶으면 같은 팀 동명이인
  // (로스터 실측 7그룹)이 서로의 도루 값을 덮어쓴다. 하류에서 kboId 로 걸러도
  // 이미 오염된 값이라 복구되지 않는다. Runner 행의 playerId 가 없는 경우에만
  // 이름::팀 으로 돌아간다(하위호환).
  const runnerMap = new Map<string, RunnerStat>();
  if (runnerResult.live) {
    for (const c of runnerResult.rows) {
      // ⚠️ 외국인은 KBO 숫자ID vs 로스터 영문ID 로 갈라진다 — canonical 로 맞춰야 키가 맞는다.
      const key = canonicalKboId((c[10] || "").trim());
      // playerId 없는 Runner 행은 이름으로 추정 병합하지 않는다 — 동명이인 오염보다 기존값 보존.
      if (!key) continue;
      runnerMap.set(key, {
        sb: parseInt(c[5]) || 0,
        cs: parseInt(c[6]) || 0,
      });
    }
  }
  // HTTP 200이어도 pager가 조기 종료될 수 있다. 최종 full 후보(live union + static 전체)를
  // Runner map이 모두 덮지 못하면 부분 live 전체를 폐기하고 static fallback으로 전환한다.
  const requiredRunnerKeys = new Set([
    ...rows.map((c) => {
      const name = (c[1] || "").trim();
      const team = (c[2] || "").trim();
      const found = resolvePlayer({ name, team }, roster, { context: "api/stats:runner-key" });
      return canonicalKboId(found?.kboId ?? "");
    }),
    ...(batterStats2026 as unknown as PlayerStat[]).map((player) =>
      canonicalKboId(String(player.kboId || "").trim()),
    ),
  ]);
  const runnerLiveAccepted =
    runnerResult.live &&
    [...requiredRunnerKeys].every((key) => key !== "::" && runnerMap.has(key));
  if (!runnerLiveAccepted) {
    runnerMap.clear();
    for (const p of batterStats2026 as unknown as PlayerStat[]) {
      const key = canonicalKboId(String(p.kboId || "").trim());
      if (key) runnerMap.set(key, { sb: Number(p.sb) || 0, cs: Number(p.cs) || 0 });
    }
  }

  const stats = rows.map((c, i) => {
    const name = (c[1] || "").trim();
    const team = (c[2] || "").trim();
    // KBO 원본 playerId 가 있으면 그걸로 잡는다 — 이름 조회는 동명이인 first-match 다.
    const lookupKey = statsRowKey(c);
    const found = resolvePlayer({ name, team }, roster, { context: "api/stats:batter" });
    const b2 = basic2Map.get(lookupKey);
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
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
      qualifiedRate: qualifiedKeys.has(`${name}::${team}`) ? 1 : 0,
    };
  });
  return {
    stats,
    runnerMap,
    runnerSource: runnerLiveAccepted ? "live" : "static-fallback",
    runnerUpdatedAt: runnerLiveAccepted ? new Date().toISOString() : statsMeta.battersGeneratedAt,
  };
}

export function applyRunnerStats<T extends PlayerStat>(
  stats: T[],
  runnerMap: Map<string, RunnerStat>,
): T[] {
  return stats.map((player) => {
    // kboId exact 우선 — 같은 팀 동명이인이 서로의 도루를 덮어쓰지 않도록(삼순 4차 P0-3).
    const kboId = canonicalKboId(String((player as PlayerStat).kboId || "").trim());
    const runner = kboId ? runnerMap.get(kboId) : undefined;
    return {
      ...player,
      sb: runner?.sb ?? (Number(player.sb) || 0),
      cs: runner?.cs ?? (Number(player.cs) || 0),
    };
  });
}

function parsePitcherRow(c: string[], roster: RosterPlayer[]): PlayerStat {
  const name = c[1] || "";
  const team = c[2] || "";
  const found = resolvePlayer({ name, team }, roster, { context: "api/stats:pitcher" });
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
  const roster = playersRoster as RosterPlayer[];
  const merged = new Map<string, PlayerStat>(); // key: name+team
  const qualifiedKeys = new Set<string>(); // ERA_RT 페이지에 나오는 규정이닝 충족 선수

  const results = await Promise.all(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url, signal);
      const rows = parseTable(html);
      // ERA_RT는 규정이닝 충족자만 내려와 현재 정상 응답도 19행이다.
      // 나머지 누적 정렬은 정상 페이지의 30행 계약을 그대로 요구한다.
      const minimumRows = sort === "ERA_RT" ? 15 : KBO_TABLE_MIN_ROWS;
      if (
        rows.length < minimumRows ||
        rows.some((row) => row.length < 19 || !row[1]?.trim() || !row[2]?.trim())
      ) {
        throw new Error(`KBO pitcher stats ${sort} table incomplete`);
      }
      return { sort, rows };
    })
  );

  for (const { sort, rows } of results) {
    for (const c of rows) {
      const name = c[1] || "";
      const team = c[2] || "";
      const key = `${name}::${team}`;
      if (sort === "ERA_RT") {
        qualifiedKeys.add(key);
      }
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(c, roster));
      }
    }
  }

  // ERA 기준 정렬 후 순위 부여 + 규정이닝 플래그
  const stats = [...merged.values()]
    .sort((a, b) => Number(a.era || 99) - Number(b.era || 99));
  stats.forEach((p, i) => {
    p.rank = i + 1;
    p.qualifiedRate = qualifiedKeys.has(`${p.name}::${p.team}`) ? 1 : 0;
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

function getCached(key: string) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < getCacheTtl()) return entry.data;
  return null;
}
function setCache(key: string, data: StatsResult) {
  cache[key] = { data, ts: Date.now() };
}

function assertStatsComplete(stats: PlayerStat[], type: "batter" | "pitcher"): void {
  const minimum = 30;
  const teamCounts = new Map<string, number>();
  for (const row of stats) {
    const team = row.team.trim();
    if (team) teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
  }
  const players = new Set(
    stats.map((row) => `${row.name.trim()}::${row.team.trim()}`).filter((key) => key !== "::"),
  );
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

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") || "batter";
  const season = req.nextUrl.searchParams.get("season") || "current";
  const full = req.nextUrl.searchParams.get("full") === "1";

  // 2025 시즌 — 확정 static data (300 batters + 277 pitchers)
  if (season === "2025") {
    const stats = type === "pitcher"
      ? (pitcherStats2025 as unknown as PlayerStat[])
      : (batterStats2025 as unknown as PlayerStat[]);
    return NextResponse.json({ stats, type, count: stats.length, season: 2025 });
  }

  // 수비 — 라이브 fetch 불가(KBO 수비페이지 POST 차단) → 정적 크롤 JSON(매일 CI 갱신) 집계
  if (type === "defense") {
    const stats = aggregateDefense(defenseStats2026 as unknown as DefenseRow[]) as unknown as PlayerStat[];
    return NextResponse.json({ stats, type, count: stats.length, season: 2026, source: "static", updatedAt: statsMeta.defenseGeneratedAt });
  }

  // 2026 시즌 + current — 라이브 크롤링 (캐시: 경기시간대 10분 / 평시 1시간)
  const cacheKey = `stats-${type}-${season}${full ? "-full" : ""}`;
  const cached = getCached(cacheKey);
  if (cached) return NextResponse.json(cached);

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
    const now = new Date().toISOString();
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
      updatedAt:
        current.runnerSource === "static-fallback"
          ? current.runnerUpdatedAt
          : now,
      ...(current.runnerSource
        ? {
            runnerSource: current.runnerSource,
            runnerUpdatedAt: current.runnerUpdatedAt,
          }
        : {}),
    };
    setCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    // 크롤링 실패 시 static JSON fallback (빈화면 방지)
    if (season === "2026" || season === "current") {
      const fallback = type === "pitcher"
        ? (pitcherStats2026 as unknown as PlayerStat[])
        : (batterStats2026 as unknown as PlayerStat[]);
      const fbAt = type === "pitcher" ? statsMeta.pitchersGeneratedAt : statsMeta.battersGeneratedAt;
      return NextResponse.json({ stats: fallback, type, count: fallback.length, season: 2026, source: "fallback", updatedAt: fbAt });
    }
    return NextResponse.json({ error: (e as Error).message, stats: [] }, { status: 500 });
  }
}
