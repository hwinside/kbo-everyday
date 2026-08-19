import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { trackFallback } from "@/lib/monitoring/api-fallback-tracker";
import { TEAMS } from "@/lib/constants/teams";

const KBO_BASE = "https://www.koreabaseball.com";
const NAVER_PLAYER_STATS_BASE =
  "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons";
const CRON_SECRET = process.env.CRON_SECRET || "";

/** KBO HTML / Naver 응답 공통 팀 표기(shortName). 둘 다 "SSG"·"두산" 형태로 일치한다(실측). */
const KBO_TEAM_NAMES: ReadonlySet<string> = new Set(TEAMS.map((t) => t.shortName));

/** 단일 소스 fetch 상한. KBO 실패를 오래 물고 있으면 Naver 재시도 예산이 사라진다. */
const SOURCE_TIMEOUT_MS = 8000;
/** Naver 는 pageSize 로만 전량 조회된다(page 파라미터는 무시됨 — 실측). */
const NAVER_PAGE_SIZE = 500;
/**
 * Naver 수집량 최소 계약. scripts/war-benchmark.ts 와 동일한 실패모드 방어 —
 * 이 endpoint 는 과거 pageSize 를 무시하고 첫 100명만 내려준 전력이 있다.
 * 절단된 목록을 채택하면 상위 N명만 갱신되고 나머지 선수는 stale 로 남으므로 fail-close 한다.
 * (2026-07-31 실측: HITTER 329명 / PITCHER 276명)
 */
const NAVER_MIN_COVERAGE: Record<"HITTER" | "PITCHER", number> = {
  HITTER: 150,
  PITCHER: 120,
};
const NAVER_MIN_PER_TEAM: Record<"HITTER" | "PITCHER", number> = {
  HITTER: 15,
  PITCHER: 10,
};
// KBO 선수표는 페이지당 정확히 30행이다. 30행을 "완전"으로 채택하면 31위 이하가
// 조용히 stale 상태로 남으므로, 단일 페이지 경계는 불완전으로 보고 Naver 전량으로 전환한다.
const KBO_MIN_COVERAGE = { batter: 31, pitcher: 15 } as const;

interface PlayerStat {
  rank: number;
  name: string;
  team: string;
  playerKey: string;
  [key: string]: string | number;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: KBO_BASE,
    },
    next: { revalidate: 0 },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  // 이전에는 res.ok 를 보지 않고 res.text() 를 그대로 파싱했다. 503/302 본문에는 <tbody> 가
  // 없어 parseTable 이 [] 를 반환하고, 그 [] 가 "정상 수집 0명"으로 upsert 까지 통과했다.
  if (!res.ok) throw new Error(`KBO HTTP ${res.status}`);
  return res.text();
}

interface KboRow {
  cells: string[];
  playerId: string;
}

function parseTable(html: string): KboRow[] {
  const rows: KboRow[] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        cells.push(td.replace(/<[^>]+>/g, "").trim());
      }
    }
    if (cells.length > 0) {
      const playerId =
        tr.match(/[?&]playerId=([A-Za-z0-9]+)/i)?.[1] ??
        tr.match(/[?&]playerCode=([A-Za-z0-9]+)/i)?.[1] ??
        "";
      rows.push({ cells, playerId });
    }
  }
  return rows;
}

/**
 * KBO 표 행 계약 검증. 셀 수 부족·이름 공백·미지 팀명은 열화 응답(안내문 행, 스키마 변경)이므로
 * 조용히 0/빈값 레코드로 만들지 않고 소스 전체를 실패 처리한다.
 */
function assertKboRows(rows: KboRow[], minCells: number, label: string): KboRow[] {
  if (rows.length === 0) throw new Error(`KBO ${label} empty table`);
  for (const { cells: c } of rows) {
    if (c.length < minCells) throw new Error(`KBO ${label} row too short (${c.length})`);
    const name = (c[1] || "").trim();
    const team = (c[2] || "").trim();
    if (!name || !KBO_TEAM_NAMES.has(team)) {
      throw new Error(`KBO ${label} invalid row (name="${name}" team="${team}")`);
    }
  }
  return rows;
}

// ── Naver 시즌 선수기록 ────────────────────────────────────────────────────
interface NaverPlayerStat {
  playerId?: string;
  playerName?: string;
  teamName?: string;
  [key: string]: unknown;
}

async function fetchNaverPlayerStats(
  playerType: "HITTER" | "PITCHER",
  season: number,
): Promise<NaverPlayerStat[]> {
  const url = `${NAVER_PLAYER_STATS_BASE}/${season}/players?playerType=${playerType}&pageSize=${NAVER_PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
    cache: "no-store",
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Naver HTTP ${res.status}`);
  const json = (await res.json()) as {
    success?: boolean;
    result?: { seasonPlayerStats?: NaverPlayerStat[] };
  };
  const rows = json?.result?.seasonPlayerStats;
  if (json?.success !== true || !Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Naver ${playerType} schema invalid`);
  }
  // fail-close 1: pageSize 에 꿉 차게 돌아오면 목록이 잘렸을 가능성(더 큰 pageSize 필요).
  if (rows.length >= NAVER_PAGE_SIZE) {
    throw new Error(`Naver ${playerType} 수집량(${rows.length})이 pageSize 근접 — 절단 의심`);
  }
  // fail-close 2: 최소 coverage 미달 → '첫 100명만 반환' 버그 재발 의심.
  if (rows.length < NAVER_MIN_COVERAGE[playerType]) {
    throw new Error(
      `Naver ${playerType} 수집량(${rows.length}) < 최소 coverage(${NAVER_MIN_COVERAGE[playerType]})`,
    );
  }
  const ids = rows.map((row) => String(row.playerId ?? "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== rows.length) {
    throw new Error(`Naver ${playerType} playerId coverage invalid`);
  }
  const perTeam = new Map<string, number>();
  for (const row of rows) {
    const team = String(row.teamName ?? "").trim();
    if (!KBO_TEAM_NAMES.has(team)) throw new Error(`Naver ${playerType} invalid team`);
    perTeam.set(team, (perTeam.get(team) ?? 0) + 1);
  }
  if (
    perTeam.size !== TEAMS.length ||
    [...KBO_TEAM_NAMES].some(
      (team) => (perTeam.get(team) ?? 0) < NAVER_MIN_PER_TEAM[playerType],
    )
  ) {
    throw new Error(`Naver ${playerType} per-team coverage invalid`);
  }
  return rows;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

/** 소수 → KBO 표기 문자열. avg/wpct 는 앞 0 제거(".327"), era/whip 은 유지("2.64"). */
function rate(v: unknown, digits: number, trimLeadingZero: boolean): string {
  const n = num(v);
  if (!Number.isFinite(n)) throw new Error("Naver non-numeric rate");
  const s = n.toFixed(digits);
  return trimLeadingZero ? s.replace(/^0(?=\.)/, "") : s;
}

function intOf(v: unknown): number {
  const n = num(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error("Naver invalid count");
  }
  return Math.trunc(n);
}

function strictInt(v: string, label: string): number {
  if (!/^\d+$/.test(v.trim())) throw new Error(`KBO ${label} invalid integer`);
  return Number(v);
}

function strictRate(v: string, label: string): string {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n) || n < 0) {
    throw new Error(`KBO ${label} invalid rate`);
  }
  return v;
}

function identityFor(
  rawPlayerId: unknown,
  name: string,
  team: string,
  roster: RosterPlayer[],
): { playerKey: string; kboId: string } {
  const raw = String(rawPlayerId ?? "").trim();
  const found = resolvePlayer(
    { playerId: raw || undefined, name, team },
    roster,
  );
  const canonical = found?.kboId || raw;
  return {
    playerKey: canonical || `legacy:${team}:${name}`,
    kboId: canonical,
  };
}

function mapNaverBatters(rows: NaverPlayerStat[], roster: RosterPlayer[]): PlayerStat[] {
  return rows.map((r, i) => {
    const name = (r.playerName || "").trim();
    const team = (r.teamName || "").trim();
    if (!name || !KBO_TEAM_NAMES.has(team)) throw new Error("Naver batter invalid row");
    const identity = identityFor(r.playerId, name, team, roster);
    const hits = intOf(r.hitterHit);
    const doubles = intOf(r.hitterH2);
    const triples = intOf(r.hitterH3);
    const hr = intOf(r.hitterHr);
    return {
      rank: i + 1,
      name,
      team,
      playerKey: identity.playerKey,
      avg: rate(r.hitterHra, 3, true),
      games: intOf(r.hitterGameCount),
      ab: intOf(r.hitterAb),
      runs: intOf(r.hitterRun),
      hits,
      doubles,
      triples,
      hr,
      // 루타(TB)는 Naver 가 직접 주지 않지만 단타+2×2루타+3×3루타+4×홈런 정의로 정확히 복원된다
      // (KBO 표 30/30 행 완전 일치 실측). pa·sac·sf 는 복원 불가 → upsert 에서 제외해 기존값 보존.
      tb: hits + doubles + 2 * triples + 3 * hr,
      rbi: intOf(r.hitterRbi),
      kboId: identity.kboId,
      playerId: identity.kboId,
    };
  });
}

function mapNaverPitchers(rows: NaverPlayerStat[], roster: RosterPlayer[]): PlayerStat[] {
  return rows.map((r, i) => {
    const name = (r.playerName || "").trim();
    const team = (r.teamName || "").trim();
    if (!name || !KBO_TEAM_NAMES.has(team)) throw new Error("Naver pitcher invalid row");
    const identity = identityFor(r.playerId, name, team, roster);
    const ip = typeof r.pitcherInning === "string" ? r.pitcherInning.trim() : "";
    if (!/^\d+(?: [12]\/3)?$/.test(ip)) throw new Error("Naver pitcher invalid IP");
    return {
      rank: i + 1,
      name,
      team,
      playerKey: identity.playerKey,
      era: rate(r.pitcherEra, 2, false),
      games: intOf(r.pitcherGameCount),
      wins: intOf(r.pitcherWin),
      losses: intOf(r.pitcherLose),
      saves: intOf(r.pitcherSave),
      holds: intOf(r.pitcherHold),
      wpct: rate(r.pitcherWra, 3, false),
      ip,
      h: intOf(r.pitcherHit),
      hr: intOf(r.pitcherHr),
      bb: intOf(r.pitcherBb),
      hbp: intOf(r.pitcherHp),
      so: intOf(r.pitcherKk),
      r: intOf(r.pitcherR),
      er: intOf(r.pitcherEr),
      whip: rate(r.pitcherWhip, 2, false),
      kboId: identity.kboId,
      playerId: identity.kboId,
    };
  });
}

// ── KBO 수집 ───────────────────────────────────────────────────────────────
async function fetchKboBatterStats(roster: RosterPlayer[]): Promise<PlayerStat[]> {
  // GAME_CN 정렬로 출장기록 있는 전체 타자 수집 (HRA_RT는 규정타석 충족자만 반환)
  const html = await fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`);
  const rows = assertKboRows(parseTable(html), 16, "hitter");
  if (rows.length < KBO_MIN_COVERAGE.batter) throw new Error("KBO hitter coverage invalid");
  const stats = rows.map(({ cells: c, playerId }, i) => {
    const name = c[1] || "";
    const team = c[2] || "";
    const identity = identityFor(playerId, name, team, roster);
    return {
      rank: i + 1,
      name,
      team,
      playerKey: identity.playerKey,
      avg: strictRate(c[3], "hitter avg"),
      games: strictInt(c[4], "hitter games"),
      pa: strictInt(c[5], "hitter pa"),
      ab: strictInt(c[6], "hitter ab"),
      runs: strictInt(c[7], "hitter runs"),
      hits: strictInt(c[8], "hitter hits"),
      doubles: strictInt(c[9], "hitter doubles"),
      triples: strictInt(c[10], "hitter triples"),
      hr: strictInt(c[11], "hitter hr"),
      tb: strictInt(c[12], "hitter tb"),
      rbi: strictInt(c[13], "hitter rbi"),
      sac: strictInt(c[14], "hitter sac"),
      sf: strictInt(c[15], "hitter sf"),
      kboId: identity.kboId,
      playerId: identity.kboId,
    };
  });
  assertTeamCoverage(stats, "KBO hitter", 1);
  return stats;
}

function parsePitcherRow(row: KboRow, roster: RosterPlayer[]): PlayerStat {
  const c = row.cells;
  const name = c[1] || "";
  const team = c[2] || "";
  const identity = identityFor(row.playerId, name, team, roster);
  if (!/^\d+(?: [12]\/3)?$/.test(c[10])) throw new Error("KBO pitcher invalid IP");
  return {
    rank: 0,
    name,
    team,
    playerKey: identity.playerKey,
    era: strictRate(c[3], "pitcher era"),
    games: strictInt(c[4], "pitcher games"),
    wins: strictInt(c[5], "pitcher wins"),
    losses: strictInt(c[6], "pitcher losses"),
    saves: strictInt(c[7], "pitcher saves"),
    holds: strictInt(c[8], "pitcher holds"),
    wpct: strictRate(c[9], "pitcher wpct"),
    ip: c[10],
    h: strictInt(c[11], "pitcher h"),
    hr: strictInt(c[12], "pitcher hr"),
    bb: strictInt(c[13], "pitcher bb"),
    hbp: strictInt(c[14], "pitcher hbp"),
    so: strictInt(c[15], "pitcher so"),
    r: strictInt(c[16], "pitcher r"),
    er: strictInt(c[17], "pitcher er"),
    whip: strictRate(c[18], "pitcher whip"),
    kboId: identity.kboId,
    playerId: identity.kboId,
  };
}

function assertTeamCoverage(stats: PlayerStat[], label: string, minPerTeam: number): void {
  const perTeam = new Map<string, number>();
  for (const row of stats) perTeam.set(row.team, (perTeam.get(row.team) ?? 0) + 1);
  if (
    perTeam.size !== TEAMS.length ||
    [...KBO_TEAM_NAMES].some((team) => (perTeam.get(team) ?? 0) < minPerTeam)
  ) {
    throw new Error(`${label} team coverage invalid`);
  }
}

async function fetchKboPitcherStats(roster: RosterPlayer[]): Promise<PlayerStat[]> {
  const sortKeys = ["ERA_RT", "SV_CN", "HOLD_CN", "W_CN", "KK_CN", "GAME_CN", "INN2_CN", "HIT_CN", "BB_CN", "R_CN"];
  const merged = new Map<string, PlayerStat>();

  // 이전에는 Promise.all 이라 sort 1개만 실패해도 전체가 throw 됐다. 정렬키는 같은 모집단을
  // 다른 순서로 보여줄 뿐이므로 일부 실패는 감내하고, 전부 실패일 때만 소스 실패로 올린다.
  const results = await Promise.allSettled(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url);
      return assertKboRows(parseTable(html), 19, "pitcher");
    }),
  );
  const ok = results.filter(
    (r): r is PromiseFulfilledResult<KboRow[]> => r.status === "fulfilled",
  );
  if (ok.length !== sortKeys.length) {
    throw new Error(`KBO pitcher all sorts failed: ${(results[0] as PromiseRejectedResult)?.reason}`);
  }

  for (const { value: rows } of ok) {
    for (const row of rows) {
      const c = row.cells;
      const name = c[1] || "";
      const team = c[2] || "";
      const identity = identityFor(row.playerId, name, team, roster);
      const key = identity.playerKey;
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(row, roster));
      }
    }
  }

  const stats = [...merged.values()].sort(
    (a, b) => Number(a.era || 99) - Number(b.era || 99),
  );
  stats.forEach((p, i) => {
    p.rank = i + 1;
  });
  if (stats.length < KBO_MIN_COVERAGE.pitcher) {
    throw new Error("KBO pitcher coverage invalid");
  }
  assertTeamCoverage(stats, "KBO pitcher", 1);
  return stats;
}

type Source = "kbo" | "naver";
interface Collected {
  stats: PlayerStat[];
  source: Source;
}

/**
 * 종류별 공식 1차 소스.
 * 타자: KBO 공홈 타자 표는 페이지당 30행 단일 페이지만 내려와 coverage 계약(31행, 위
 * KBO_MIN_COVERAGE.batter)을 구조상 통과할 수 없다 — 2026-08-19 실측: 8/5부터 14일 연속
 * 매일 Naver failover(타자 330~332명 온전 수집). 따라서 타자는 Naver가 공식 1차다.
 * 상태 판정도 이 공식 1차 기준으로 한다(1차 성공=success, 폴백 수집=warning).
 */
const PRIMARY_SOURCE: Record<"batter" | "pitcher", Source> = {
  batter: "naver",
  pitcher: "kbo",
};

/**
 * kind+source별 검증된 정적 전량 baseline 급감 가드.
 * 정적 하한(NAVER_MIN_COVERAGE·팀당 최소)만으로는 "균등하게 잘린 부분응답"(예: 332명 중
 * 팀당 16명씩 160명)이 개별 행 검증을 전부 통과해 나머지 선수를 경보 없이 stale로
 * 남긴다(2026-08-19 삼순 P0 1차). DB 행 count는 소스 구분이 없어 투수 KBO 96명↔Naver
 * 281명이 섞이고(복구된 KBO가 영구 거부되는 고착), 7일 공백·count=null에서 조용히
 * 무력화된다(삼순 P0 2차). 그래서 런타임 조회 없이 kind+source별 실측 전량을 정적으로
 * 결속한다 — 상태가 없으니 고착·공백·조회오류 축이 원천 제거된다.
 *
 * 값은 2026-08-19 실측 전량(타자 Naver 332·투수 Naver 281·투수 KBO 병합 96).
 * 시즌 내 선수 수는 단조증가라 정적 floor는 시간이 갈수록 안전해진다.
 * ⚠️ 시즌 경계(개막 초기)에는 실제 전량이 이 값 아래로 내려가므로 개막 시 재설정 필요
 * (그 전까지는 fail-close가 맞다 — 절단 응답을 조용히 받느니 수집 중단이 낫다).
 * KBO 타자는 실전 30행 단일 페이지라 전량 전달이 원리적으로 불가 → 타자 전량 332를
 * 그대로 결속해 타자는 사실상 Naver 단독(절단 KBO 폴백 채택 불가)이다.
 */
const SOURCE_FULL_BASELINE: Record<"batter" | "pitcher", Record<Source, number>> = {
  batter: { naver: 332, kbo: 332 },
  pitcher: { naver: 281, kbo: 96 },
};
const BASELINE_MIN_RATIO = 0.9;

function assertNoCoverageCollapse(
  kind: "batter" | "pitcher",
  source: Source,
  fetchedCount: number,
): void {
  const baseline = SOURCE_FULL_BASELINE[kind][source];
  const floor = Math.ceil(baseline * BASELINE_MIN_RATIO);
  if (fetchedCount < floor) {
    const label = source === "kbo" ? "KBO" : "Naver";
    throw new Error(
      `${label} ${kind} coverage collapse: fetched ${fetchedCount} < ${floor} (90% of full baseline ${baseline})`,
    );
  }
}

function classifyFallbackReason(e: Error): "timeout" | "http-error" | "schema-error" | "network-error" {
  const msg = e.message || "";
  return e.name === "TimeoutError" || e.name === "AbortError"
    ? "timeout"
    : msg.includes("HTTP")
      ? "http-error"
      : msg.includes("KBO") || msg.includes("Naver")
        ? "schema-error"
        : "network-error";
}

/** 공식 1차 우선 → 하드실패/열화 시 폴백 소스. 둘 다 실패면 throw(=fail-close, upsert 미수행). */
async function collect(
  kind: "batter" | "pitcher",
  roster: RosterPlayer[],
  season: number,
): Promise<Collected> {
  const fromKbo = async (): Promise<Collected> => {
    const stats =
      kind === "batter"
        ? await fetchKboBatterStats(roster)
        : await fetchKboPitcherStats(roster);
    assertNoCoverageCollapse(kind, "kbo", stats.length);
    return { stats, source: "kbo" };
  };
  const fromNaver = async (): Promise<Collected> => {
    const rows = await fetchNaverPlayerStats(kind === "batter" ? "HITTER" : "PITCHER", season);
    const stats =
      kind === "batter" ? mapNaverBatters(rows, roster) : mapNaverPitchers(rows, roster);
    if (stats.length === 0) throw new Error(`Naver ${kind} empty after map`);
    assertNoCoverageCollapse(kind, "naver", stats.length);
    return { stats, source: "naver" };
  };

  const primary = PRIMARY_SOURCE[kind];
  const [tryFirst, trySecond] = primary === "kbo" ? [fromKbo, fromNaver] : [fromNaver, fromKbo];
  try {
    return await tryFirst();
  } catch (e) {
    const msg = (e as Error).message || "";
    // apiName은 "실패한 1차 소스" 기준. 기존 kbo-player-stats-* 계약은 투수(kbo 1차)에서 유지된다.
    void trackFallback(`${primary}-player-stats-${kind}`, classifyFallbackReason(e as Error), {
      errorMessage: msg,
    }).catch(() => {});
    return await trySecond();
  }
}

/**
 * upsert 페이로드 분할: kbo_id 가 비어 있는 행은 kbo_id 컬럼 자체를 페이로드에서 제외한다.
 * (한 번의 upsert 안에서는 키 집합이 균일해야 하므로 두 묶음으로 나눠 보낸다.)
 * 이렇게 해야 로스터 매칭이 일시적으로 실패한 선수의 기존 kbo_id 를 ""로 덮어쓰지 않는다 —
 * kbo_id 는 player-tagger·videos-shorts 가 선수를 식별하는 유일 키다.
 */
async function upsertRows(
  table: "player_stats_batter" | "player_stats_pitcher",
  rows: Record<string, string | number>[],
): Promise<string[]> {
  const errors: string[] = [];
  const { error } = await supabaseAdmin
    .from(table)
    .upsert(rows, { onConflict: "player_key" });
  if (error) errors.push(error.message);
  return errors;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("stats-update");
  const roster = playersRoster as RosterPlayer[];
  const season = new Date().getFullYear();

  try {
    const [batterRes, pitcherRes] = await Promise.all([
      collect("batter", roster, season),
      collect("pitcher", roster, season),
    ]);
    const batters = batterRes.stats;
    const pitchers = pitcherRes.stats;
    const now = new Date().toISOString();

    const batterRows = batters.map((b) => {
      const base: Record<string, string | number> = {
        name: b.name,
        team: b.team,
        player_key: b.playerKey,
        kbo_id: b.kboId,
        rank: b.rank,
        avg: b.avg,
        games: b.games,
        ab: b.ab,
        runs: b.runs,
        hits: b.hits,
        doubles: b.doubles,
        triples: b.triples,
        hr: b.hr,
        tb: b.tb,
        rbi: b.rbi,
        updated_at: now,
      };
      // Naver 는 pa/sac/sf 를 제공하지 않는다. 0 으로 채워 덮어쓰면 KBO 로 모아둔 기존 값이
      // 파괴되므로, Naver 경로에서는 해당 컬럼을 페이로드에서 아예 제외해 기존 행 값을 보존한다.
      if (batterRes.source === "kbo") {
        base.pa = b.pa;
        base.sac = b.sac;
        base.sf = b.sf;
      }
      return base;
    });

    const pitcherRows = pitchers.map((p) => ({
      name: p.name,
      team: p.team,
      player_key: p.playerKey,
      kbo_id: p.kboId,
      rank: p.rank,
      era: p.era,
      games: p.games,
      wins: p.wins,
      losses: p.losses,
      saves: p.saves,
      holds: p.holds,
      wpct: p.wpct,
      ip: p.ip,
      h: p.h,
      hr: p.hr,
      bb: p.bb,
      hbp: p.hbp,
      so: p.so,
      r: p.r,
      er: p.er,
      whip: p.whip,
      updated_at: now,
    })) as Record<string, string | number>[];

    const dbErrors: string[] = [];
    for (const m of await upsertRows("player_stats_batter", batterRows)) {
      dbErrors.push(`batter: ${m}`);
    }
    for (const m of await upsertRows("player_stats_pitcher", pitcherRows)) {
      dbErrors.push(`pitcher: ${m}`);
    }

    const summary =
      `타자 ${batters.length}명(${batterRes.source}), 투수 ${pitchers.length}명(${pitcherRes.source}) 수집`;

    if (dbErrors.length > 0) {
      await finishJob(logId, "error", summary, dbErrors.join("; "));
      return NextResponse.json(
        {
          ok: false,
          error: "player stats upsert failed",
          dbErrors,
        },
        { status: 500 },
      );
    } else if (
      batterRes.source !== PRIMARY_SOURCE.batter ||
      pitcherRes.source !== PRIMARY_SOURCE.pitcher
    ) {
      // 공식 1차 소스가 아닌 폴백으로 수집된 종류만 경보(warning). 1차 성공은 success.
      const fellBack = (
        [
          ["타자", batterRes.source, PRIMARY_SOURCE.batter],
          ["투수", pitcherRes.source, PRIMARY_SOURCE.pitcher],
        ] as const
      )
        .filter(([, actual, primary]) => actual !== primary)
        .map(([label, actual, primary]) => `${label} 1차(${primary}) 실패 → ${actual} 폴백`)
        .join("; ");
      await finishJob(logId, "warning", summary, fellBack);
    } else {
      await finishJob(logId, "success", summary);
    }

    return NextResponse.json({
      ok: true,
      timestamp: now,
      batters: batters.length,
      pitchers: pitchers.length,
      sources: { batter: batterRes.source, pitcher: pitcherRes.source },
      dbErrors: dbErrors.length > 0 ? dbErrors : undefined,
    });
  } catch (e) {
    // dual-fail(KBO·Naver 모두 실패) → upsert 자체를 수행하지 않는다. 기존 선수 스탯은 그대로 유지.
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
