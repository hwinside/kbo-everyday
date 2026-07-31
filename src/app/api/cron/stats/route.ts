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

interface PlayerStat {
  rank: number;
  name: string;
  team: string;
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

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
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
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/**
 * KBO 표 행 계약 검증. 셀 수 부족·이름 공백·미지 팀명은 열화 응답(안내문 행, 스키마 변경)이므로
 * 조용히 0/빈값 레코드로 만들지 않고 소스 전체를 실패 처리한다.
 */
function assertKboRows(rows: string[][], minCells: number, label: string): string[][] {
  if (rows.length === 0) throw new Error(`KBO ${label} empty table`);
  for (const c of rows) {
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
  if (!Number.isFinite(n)) throw new Error("Naver non-numeric count");
  return Math.trunc(n);
}

function mapNaverBatters(rows: NaverPlayerStat[], roster: RosterPlayer[]): PlayerStat[] {
  return rows.map((r, i) => {
    const name = (r.playerName || "").trim();
    const team = (r.teamName || "").trim();
    if (!name || !KBO_TEAM_NAMES.has(team)) throw new Error("Naver batter invalid row");
    const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:batter:naver" });
    const hits = intOf(r.hitterHit);
    const doubles = intOf(r.hitterH2);
    const triples = intOf(r.hitterH3);
    const hr = intOf(r.hitterHr);
    return {
      rank: i + 1,
      name,
      team,
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
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
    };
  });
}

function mapNaverPitchers(rows: NaverPlayerStat[], roster: RosterPlayer[]): PlayerStat[] {
  return rows.map((r, i) => {
    const name = (r.playerName || "").trim();
    const team = (r.teamName || "").trim();
    if (!name || !KBO_TEAM_NAMES.has(team)) throw new Error("Naver pitcher invalid row");
    const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:pitcher:naver" });
    const ip = typeof r.pitcherInning === "string" ? r.pitcherInning.trim() : "";
    if (!ip) throw new Error("Naver pitcher missing IP");
    return {
      rank: i + 1,
      name,
      team,
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
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
    };
  });
}

// ── KBO 수집 ───────────────────────────────────────────────────────────────
async function fetchKboBatterStats(roster: RosterPlayer[]): Promise<PlayerStat[]> {
  // GAME_CN 정렬로 출장기록 있는 전체 타자 수집 (HRA_RT는 규정타석 충족자만 반환)
  const html = await fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`);
  const rows = assertKboRows(parseTable(html), 16, "hitter");
  return rows.map((c, i) => {
    const name = c[1] || "";
    const team = c[2] || "";
    const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:batter" });
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
      kboId: found?.kboId || "",
      playerId: found?.kboId || "",
    };
  });
}

function parsePitcherRow(c: string[], roster: RosterPlayer[]): PlayerStat {
  const name = c[1] || "";
  const team = c[2] || "";
  const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:pitcher" });
  return {
    rank: 0,
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
    kboId: found?.kboId || "",
    playerId: found?.kboId || "",
  };
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
    (r): r is PromiseFulfilledResult<string[][]> => r.status === "fulfilled",
  );
  if (ok.length === 0) {
    throw new Error(`KBO pitcher all sorts failed: ${(results[0] as PromiseRejectedResult)?.reason}`);
  }

  for (const { value: rows } of ok) {
    for (const c of rows) {
      const name = c[1] || "";
      const team = c[2] || "";
      const key = `${name}::${team}`;
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(c, roster));
      }
    }
  }

  const stats = [...merged.values()].sort(
    (a, b) => Number(a.era || 99) - Number(b.era || 99),
  );
  stats.forEach((p, i) => {
    p.rank = i + 1;
  });
  return stats;
}

type Source = "kbo" | "naver";
interface Collected {
  stats: PlayerStat[];
  source: Source;
}

/** KBO 우선 → 하드실패/열화 시 Naver. 둘 다 실패면 throw(=fail-close, upsert 미수행). */
async function collect(
  kind: "batter" | "pitcher",
  roster: RosterPlayer[],
  season: number,
): Promise<Collected> {
  try {
    const stats =
      kind === "batter"
        ? await fetchKboBatterStats(roster)
        : await fetchKboPitcherStats(roster);
    return { stats, source: "kbo" };
  } catch (e) {
    const msg = (e as Error).message || "";
    const reason: "timeout" | "http-error" | "schema-error" | "network-error" =
      (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError"
        ? "timeout"
        : msg.includes("HTTP")
          ? "http-error"
          : msg.includes("KBO")
            ? "schema-error"
            : "network-error";
    void trackFallback(`kbo-player-stats-${kind}`, reason, { errorMessage: msg }).catch(() => {});

    const rows = await fetchNaverPlayerStats(kind === "batter" ? "HITTER" : "PITCHER", season);
    const stats =
      kind === "batter" ? mapNaverBatters(rows, roster) : mapNaverPitchers(rows, roster);
    if (stats.length === 0) throw new Error(`Naver ${kind} empty after map`);
    return { stats, source: "naver" };
  }
}

/**
 * upsert 페이로드 분할: kbo_id 가 비어 있는 행은 kbo_id 컬럼 자체를 페이로드에서 제외한다.
 * (한 번의 upsert 안에서는 키 집합이 균일해야 하므로 두 묶음으로 나눠 보낸다.)
 * 이렇게 해야 로스터 매칭이 일시적으로 실패한 선수의 기존 kbo_id 를 ""로 덮어쓰지 않는다 —
 * kbo_id 는 player-tagger·videos-shorts 가 선수를 식별하는 유일 키다.
 */
async function upsertSplit(
  table: "player_stats_batter" | "player_stats_pitcher",
  rows: Record<string, string | number>[],
): Promise<string[]> {
  const errors: string[] = [];
  const withId = rows.filter((r) => r.kbo_id);
  const withoutId = rows
    .filter((r) => !r.kbo_id)
    .map((r) => {
      const rest = { ...r };
      delete rest.kbo_id;
      return rest;
    });
  for (const g of [withId, withoutId]) {
    if (g.length === 0) continue;
    const { error } = await supabaseAdmin.from(table).upsert(g, { onConflict: "name,team" });
    if (error) errors.push(error.message);
  }
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
    for (const m of await upsertSplit("player_stats_batter", batterRows)) {
      dbErrors.push(`batter: ${m}`);
    }
    for (const m of await upsertSplit("player_stats_pitcher", pitcherRows)) {
      dbErrors.push(`pitcher: ${m}`);
    }

    const summary =
      `타자 ${batters.length}명(${batterRes.source}), 투수 ${pitchers.length}명(${pitcherRes.source}) 수집`;

    if (dbErrors.length > 0) {
      await finishJob(logId, "error", summary, dbErrors.join("; "));
    } else if (batterRes.source === "naver" || pitcherRes.source === "naver") {
      await finishJob(logId, "warning", summary, "KBO 실패 → Naver failover");
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
