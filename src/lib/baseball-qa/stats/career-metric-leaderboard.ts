/**
 * KBO 통산 **다지표 리더보드** — 2025년 말 기준선 + 2026 시즌 증분.
 *
 * #1159(`career-leaderboard.ts`, 안타 전용)의 계약을 지표·순위구간 축으로 일반화한 것이다.
 * 값 계산 규칙은 그대로다:
 *   현재 통산 = (통산표 − 같은 세션의 2026) + 앱이 서빙하는 최신 2026
 * 두 항을 같은 시각에 뽑았기 때문에 당일 기록이 이중 합산되지 않는다.
 *
 * ⚠️ **여기는 "능력"만 만든다.** `TOP10`·`1~5위` 같은 **표현 해석은 이 모듈의 일이 아니다.**
 *   순위 구간은 이미 파싱된 `{from,to}` 정수로 받는다. 표현→구조 변환은 LLM 정규화 슬라이스가
 *   맡는다(룰 누적 방지 — 열린 자연어를 정규식으로 쫓지 않는다).
 */
import { createHash } from "node:crypto";
import { canonicalKboId } from "@/lib/utils/resolve-player";
import { STATS_STALE_MS, type SeasonRecordRow } from "./season-record";
import { CAREER_LEADERBOARD_TEMPORAL_WORDS } from "./career-leaderboard";
import {
  CAREER_METRICS_BY_TABLE,
  careerMetricId,
  type CareerMetricSpec,
  type CareerTable,
} from "./career-metric-catalog";

const SOURCE_URL = {
  batter: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx",
  pitcher: "https://www.koreabaseball.com/Record/Player/PitcherBasic/BasicTotal.aspx",
} as const;

/** 2025말 immutable 기준선 manifest. 절단본이 자기 rowCount/hash를 다시 써도 통과하지 못한다. */
const BASELINE_MANIFEST = {
  rowCount: { batter: 2659, pitcher: 1764 },
  sha256: "2def69114d6aec44fdcadfea99b27a0923f561838ca2179b9adfd2fbc13bed99",
} as const;

/** 최대 반환 순위 — 통산표 1페이지(30행) 안이면 크롤 부하 없이 답한다. */
export const CAREER_RANK_MAX = 10;

export interface CareerMetricQuery {
  readonly table: CareerTable;
  /** 카탈로그 키. */
  readonly metric: string;
  /** 1-based 시작 순위. */
  readonly from: number;
  /** 1-based 끝 순위(포함). */
  readonly to: number;
}

export interface CareerMetricLeaderRow {
  readonly rank: number;
  readonly kboId: string;
  readonly name: string;
  readonly team: string;
  readonly total: number;
  readonly baseline: number;
  readonly current: number;
}

export interface CareerMetricAnswer {
  readonly table: CareerTable;
  readonly metric: string;
  readonly label: string;
  readonly unit: string;
  readonly rows: readonly CareerMetricLeaderRow[];
  readonly from: number;
  readonly to: number;
  readonly asOf: string;
  readonly baselineThroughSeason: number;
  readonly sourceUrl: string;
}

interface BaselineEntry {
  kboId: string;
  name: string;
  team: string;
  values: Record<string, number>;
}
interface BaselineSnapshot {
  schemaVersion: number;
  throughSeason: number;
  source: {
    hitterUrl: string;
    pitcherUrl: string;
    seasonValue: string;
    currentSeason: number;
    capturedAt: string;
  };
  metrics: Record<CareerTable, string[]>;
  rowCount: Record<CareerTable, number>;
  batter: BaselineEntry[];
  pitcher: BaselineEntry[];
  sha256: string;
}

export function findCareerMetricSpec(table: CareerTable, metric: string): CareerMetricSpec | null {
  return CAREER_METRICS_BY_TABLE[table].find((spec) => spec.key === metric) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 질문 해석 — **문법은 #1159 의 두 형태 그대로**, 지표 어휘만 카탈로그에서 주입한다.
//
// ⚠️ 이것이 "룰을 늘리지 않는다"의 실제 의미다. 지표가 15개든 30개든 **정규식 개수는
//   그대로 2개**이고, 늘어나는 건 `career-metric-catalog.ts` 의 데이터 행뿐이다.
//   순위 구간 표현(`TOP10`·`1~5위`)은 여기서 파싱하지 않는다 — 열린 자연어라
//   LLM 정규화가 `{from,to}` 를 만들어 넘긴다(3️⃣ 슬라이스).
// ─────────────────────────────────────────────────────────────────────────────

function compact(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[?!？！.,。]+$/g, "")
    .replace(/\s+/g, "");
}

/** 정규식 특수문자를 가진 alias(`2루타`·`wrc+`)를 안전하게 넣는다. */
function escapeAlias(alias: string): string {
  return alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AliasEntry {
  readonly table: CareerTable;
  readonly spec: CareerMetricSpec;
  readonly alias: string;
}

/**
 * 지표 × alias 전개.
 *
 * ⚠️ **길이 정렬을 하지 않는다.** 처음엔 "`삼진` 이 `탈삼진` 을 가로챈다"고 보고 정렬을 넣었는데,
 *   mutation 으로 지워보니 결과가 그대로였다 — 아래 정규식이 **전체 문자열 앵커**(`^…$`)라
 *   `통산탈삼진1위…` 는 `삼진` alias 패턴과 애초에 매치되지 않는다. 즉 그 정렬은 죽은 코드였다.
 *   추측으로 넣은 방어를 실측으로 걷어낸다(요청하지 않은 복잡도를 남기지 않는다).
 */
function aliasEntries(): AliasEntry[] {
  const out: AliasEntry[] = [];
  for (const table of ["batter", "pitcher"] as const) {
    for (const spec of CAREER_METRICS_BY_TABLE[table]) {
      for (const alias of spec.aliases) out.push({ table, spec, alias });
    }
  }
  return out;
}

export interface CareerMetricIntent {
  readonly table: CareerTable;
  readonly metric: string;
  readonly label: string;
}

/**
 * `통산 <지표> 1위 누구야?` / `통산 최다<지표> 누구야?` 만 받는다(#1159 와 동일 폐쇄 문법).
 *
 * 부분 문자열 매칭을 하지 않는 이유(#1159 4차 NO-GO): `안타 1위는 누구고 2위는?` 의 앞 절만
 * 먹거나 `홈런 1위는? 안타도 궁금해` 에서 다른 절의 지표를 오결속한다. 끝 문장부호만 떼고
 * **전체 문자열이 통째로 일치**할 때만 지원한다.
 *
 * 지표가 하나로 안 좁혀지면(`삼진` = 타자 삼진 / 투수 탈삼진) null 을 준다 — 추측하지 않는다.
 */
export function resolveCareerMetricIntent(question: string): CareerMetricIntent | null {
  const normalized = compact(question);
  const temporal = `(?:${CAREER_LEADERBOARD_TEMPORAL_WORDS.join("|")})`;
  const who = "(?:누구(?:야|인가|인가요|예요)?|누가|누군(?:데|가요)?|알려(?:줘|주세요)?)";

  const matched: AliasEntry[] = [];
  for (const entry of aliasEntries()) {
    const alias = escapeAlias(entry.alias);
    const explicitFirst = new RegExp(`^${temporal}${alias}(?:기록)?1위(?:는|가|를)?${who}$`);
    const singularLeader = new RegExp(
      `^${temporal}(?:최다${alias}|${alias}최다|${alias}선두)(?:기록)?(?:는|가|를)?` +
      `(?:${who}|누가(?:갖고있어|보유하고있어))$`,
    );
    if (explicitFirst.test(normalized) || singularLeader.test(normalized)) matched.push(entry);
  }
  if (matched.length === 0) return null;

  // 같은 지표를 여러 alias 로 맞춘 건 하나로 본다. 서로 다른 지표면 확정 불가 → 답하지 않는다.
  const ids = new Set(matched.map((m) => careerMetricId(m.table, m.spec.key)));
  if (ids.size !== 1) return null;
  const { table, spec } = matched[0];
  return { table, metric: spec.key, label: spec.label };
}

/**
 * 스냅샷 무결성. 값 하나라도 형태가 틀리면 **답하지 않는다** — 부분 신뢰가 제일 위험하다
 * (틀린 행 하나가 1위로 올라오면 그게 그대로 단정 문장이 된다).
 */
function validSnapshot(value: unknown, query: CareerMetricQuery): value is BaselineSnapshot {
  const s = value as Partial<BaselineSnapshot>;
  if (s?.schemaVersion !== 1 || s.throughSeason !== 2025) return false;
  if (
    s.source?.hitterUrl !== SOURCE_URL.batter ||
    s.source?.pitcherUrl !== SOURCE_URL.pitcher ||
    s.source?.seasonValue !== "9999" ||
    s.source?.currentSeason !== 2026 ||
    !Number.isFinite(Date.parse(s.source?.capturedAt ?? ""))
  ) return false;
  const metrics = s.metrics?.[query.table];
  if (!Array.isArray(metrics) || !metrics.includes(query.metric)) return false;
  if (!Array.isArray(s.batter) || !Array.isArray(s.pitcher)) return false;
  if (
    s.rowCount?.batter !== BASELINE_MANIFEST.rowCount.batter ||
    s.rowCount?.pitcher !== BASELINE_MANIFEST.rowCount.pitcher ||
    s.batter.length !== BASELINE_MANIFEST.rowCount.batter ||
    s.pitcher.length !== BASELINE_MANIFEST.rowCount.pitcher
  ) return false;
  const rows = s[query.table];
  if (!Array.isArray(rows)) return false;
  if (s.sha256 !== BASELINE_MANIFEST.sha256) return false;
  const { sha256, ...unsigned } = s as BaselineSnapshot;
  if (createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== sha256) return false;
  const ids = new Set<string>();
  for (const row of rows) {
    if (!/^\d+$/.test(String(row?.kboId ?? "")) || !row.name || typeof row.team !== "string") return false;
    const v = row.values?.[query.metric];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return false;
    if (ids.has(row.kboId)) return false;
    ids.add(row.kboId);
  }
  return true;
}

/**
 * 순위표를 만든다. 반환 null 은 전부 "확인 못 했다" = 답하지 않는다는 뜻이다.
 *
 * @param currentRows 앱이 서빙하는 2026 시즌 행(`/api/stats?full=1`).
 */
export function resolveCareerMetricLeaderboard(
  snapshot: unknown,
  currentRows: SeasonRecordRow[],
  updatedAt: string,
  query: CareerMetricQuery,
  now = new Date(),
): CareerMetricAnswer | null {
  const spec = findCareerMetricSpec(query.table, query.metric);
  if (!spec) return null;
  if (!Number.isInteger(query.from) || !Number.isInteger(query.to)) return null;
  if (query.from < 1 || query.to < query.from || query.to > CAREER_RANK_MAX) return null;
  if (!validSnapshot(snapshot, query)) return null;

  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  // 낡은 스냅샷(24h 초과)·미래 시각은 답하지 않는다 — #1159 와 동일 계약.
  if (now.getTime() - updatedMs > STATS_STALE_MS || updatedMs > now.getTime() + 5 * 60_000) return null;

  const currentById = new Map<string, SeasonRecordRow>();
  for (const row of currentRows) {
    const id = String(row.kbo_id ?? row.player_key ?? "");
    if (!id || currentById.has(id)) return null;
    const raw = row[spec.currentField];
    // 서빙 컬럼 원타입 계약 — 문자열 "12" 는 Number() 로 통과하지만 스키마 변형의 증거다.
    if (raw === undefined || raw === null || typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return null;
    }
    currentById.set(id, row);
  }
  if (currentById.size === 0) return null;

  const merged: CareerMetricLeaderRow[] = [];
  for (const base of snapshot[query.table]) {
    const canonicalId = canonicalKboId(base.kboId);
    const current = currentById.get(canonicalId);
    // identity 불일치는 행이 어긋났다는 뜻이다 — 다른 선수의 기록을 더할 수 없다.
    if (current && current.name !== base.name) return null;
    const delta = current == null ? 0 : (current[spec.currentField] as number);
    const baseline = base.values[query.metric];
    merged.push({
      rank: 0,
      kboId: canonicalId,
      name: base.name,
      team: (current?.team as string | null | undefined) || base.team,
      total: baseline + delta,
      baseline,
      current: delta,
    });
  }

  // 동률은 같은 순위를 공유한다(경쟁 순위). `1위 2명` 다음은 3위다.
  merged.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ko"));
  const ranked: CareerMetricLeaderRow[] = [];
  let rank = 0;
  let prevTotal: number | null = null;
  merged.forEach((row, index) => {
    if (prevTotal === null || row.total !== prevTotal) {
      rank = index + 1;
      prevTotal = row.total;
    }
    ranked.push({ ...row, rank });
  });

  const rows = ranked.filter((row) => row.rank >= query.from && row.rank <= query.to);
  if (rows.length === 0) return null;
  return {
    table: query.table,
    metric: query.metric,
    label: spec.label,
    unit: spec.unit,
    rows,
    from: query.from,
    to: query.to,
    asOf: updatedAt,
    baselineThroughSeason: snapshot.throughSeason,
    sourceUrl: SOURCE_URL[query.table],
  };
}

function formatDate(asOf: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(asOf)).replace(/\.\s*/g, "-").replace(/-$/, "");
}

export function composeCareerMetricAnswer(result: CareerMetricAnswer): string {
  const date = formatDate(result.asOf);
  const source = `\n📄 출처: KBO 공식 기록실(${result.baselineThroughSeason}년 말 통산) + 크보팬 2026 시즌 기록`;
  const num = (n: number) => n.toLocaleString("ko-KR");

  // 단일 순위(1위 등) — 내역까지 붙여 근거를 보인다.
  if (result.from === result.to) {
    const names = result.rows.map((row) => `${row.name}(${row.team})`).join("·");
    const head = result.rows[0];
    const breakdown = result.rows.length === 1
      ? ` (${result.baselineThroughSeason}년 말 ${num(head.baseline)} + 2026시즌 ${num(head.current)})`
      : "";
    return `${date} 기준 KBO 통산 ${result.label} ${result.from}위는 ${names}, ${num(head.total)}${result.unit}입니다.${breakdown}${source}`;
  }
  // 구간(Top N) — 줄바꿈 목록.
  const lines = result.rows.map((row) => `${row.rank}. ${row.name}(${row.team}) ${num(row.total)}${result.unit}`);
  return `${date} 기준 KBO 통산 ${result.label} ${result.from}~${result.to}위입니다.\n${lines.join("\n")}${source}`;
}

/**
 * production 배선 — 기준선 JSON + 앱이 서빙하는 당해 시즌 스냅샷.
 *
 * 타자/투수는 서로 다른 엔드포인트를 쓰므로 필요한 쪽만 조회한다(불필요한 fetch 금지).
 */
export function createCareerMetricLeaderboardFetcher(
  loadSnapshot: () => unknown,
  fetchServed: (table: CareerTable) => Promise<{ rows: SeasonRecordRow[]; updatedAt: string }>,
) {
  return async (query: CareerMetricQuery, now: Date = new Date()): Promise<CareerMetricAnswer | null> => {
    const served = await fetchServed(query.table);
    return resolveCareerMetricLeaderboard(loadSnapshot(), served.rows, served.updatedAt, query, now);
  };
}
