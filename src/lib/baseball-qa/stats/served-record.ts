import { calcBatterSaberFromStats } from "@/lib/utils/sabermetrics-calc";
import { canonicalKboId } from "@/lib/utils/resolve-player";
import { FULL_ENTRY_BATTER_IDS } from "@/lib/stats/full-entry-roster";
import type { SeasonRecordRow } from "./season-record";

/**
 * 도루·출루율·장타율·OPS 의 **정본 소스** — 앱이 실제로 서빙하는 `/api/stats` 그 자체.
 *
 * ⚠️ 왜 static JSON 이 아닌가 (삼순 #1100 3차 P0-3 실측).
 *
 * 직전 구현은 `stats-2026-batters.json` 을 읽었고, 나는 그걸 "앱이 쓰는 정본"이라고 썼다.
 * **틀렸다.** `/api/stats` 는 static row 를 그대로 주지 않는다 — live 크롤 결과를 만든 뒤
 * 전페이지 Runner map 을 마지막에 덮어씌운다(`applyRunnerStats`, `route.ts`).
 *
 * Production 실측 2026-08-04 22:18 KST, `kboId=50167` 이주형:
 *   static JSON                          → `sb = 4`
 *   `/api/stats?type=batter&full=1`      → `sb = 0` (`source=live`, `runnerSource=live`)
 *
 * 즉 static 을 읽으면 **봇이 4, 앱 화면이 0** 을 말한다. 이 기능의 유일한 계약("봇은 앱과
 * 같은 숫자를 말한다")이 정면으로 깨진다. DB 에는 sb 컬럼 자체가 없어 기존 교차검증으로는
 * 검출 자체가 불가능했다.
 *
 * 그래서 정본을 **앱과 같은 최종 경계**로 옮긴다. 같은 URL, 같은 live+fallback 합성 결과다.
 */

/** 공개 도메인 self-fetch — `VERCEL_URL` 은 배포 보호에 막힌다(widget/player-card 와 동일 패턴). */
const PUBLIC_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan";
const SERVED_STATS_PATH = "/api/stats?type=batter&full=1";
/** 답변 지연보다 빠른 실패가 낫다. 실패는 fail-close(안 답함)로 끝난다. */
const SERVED_STATS_TIMEOUT_MS = 3_000;

interface ServedStatsResponse {
  stats?: Array<Record<string, unknown>>;
  type?: unknown;
  count?: unknown;
  updatedAt?: string;
  source?: string;
  runnerSource?: string;
}

/**
 * `full=1` 완전성의 정본 — mergeFullEntry 에 실제로 투입되는 2026 선수 ID 전집합.
 * 단순 행수 하한(예: 100)은 리더를 뺀 임의 100행도 통과시킨다. 이 집합 전부가 payload 에
 * 있어야 "리그 전체 current snapshot" 으로 인정한다(삼순 #1159 2차 NO-GO).
 *
 * ⚠️ **명단만** `full-entry-roster` 에서 가져온다. 이 모듈은 값의 정본을 `/api/stats` 로
 * 못박은 자리라 static JSON 을 직접 읽지 않는다(삼순 #1100 3차 P0-3, 이주형 sb 4 vs 0).
 */
export const SERVED_BATTER_FULL_ENTRY_IDS = FULL_ENTRY_BATTER_IDS;

/** `/api/stats?type=batter&full=1` envelope + known full-entry ID coverage 계약. */
export function validateServedBatterPayload(payload: ServedStatsResponse): Array<Record<string, unknown>> | null {
  if (payload.type !== "batter" || !Number.isInteger(payload.count)) return null;
  const rows = Array.isArray(payload.stats) ? payload.stats : null;
  if (!rows || payload.count !== rows.length) return null;
  const ids = new Set<string>();
  for (const row of rows) {
    const id = typeof row.kboId === "string" || typeof row.kboId === "number"
      ? canonicalKboId(row.kboId)
      : "";
    if (!id || ids.has(id)) return null;
    ids.add(id);
  }
  if (!SERVED_BATTER_FULL_ENTRY_IDS.every((id) => ids.has(id))) return null;
  return rows;
}

/**
 * 앱이 서빙하는 타자 기록에서 **kboId exact** 로 행을 찾는다.
 *
 * ⚠️ 이름 조회 금지 — 동명이인이 섞인다(DB 경로와 동일 계약, 삼순 조건 ①).
 * 반환 형태를 `SeasonRecordRow`(snake_case + updated_at)로 맞춰 기존 검증기
 * (`resolveSeasonRecord`: identity 교차검증 / stale / 값 형식)를 **그대로 재사용**한다.
 *
 * 실패·비정상 응답은 예외로 던진다. 호출부가 "조회 실패"로 처리해 답변하지 않는다 —
 * 여기서 static 으로 폴백하면 위에 적은 4 vs 0 불일치가 그대로 되살아난다.
 */
export interface ServedBatterSnapshot {
  rows: SeasonRecordRow[];
  updatedAt: string;
}

/** 앱의 최종 타자 스냅샷을 한 번만 읽는다. 선수별·리그 통산 조회가 같은 정본을 공유한다. */
export async function fetchServedBatterSnapshot(): Promise<ServedBatterSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVED_STATS_TIMEOUT_MS);
  let payload: ServedStatsResponse;
  try {
    const res = await fetch(`${PUBLIC_BASE}${SERVED_STATS_PATH}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`served stats HTTP ${res.status}`);
    payload = (await res.json()) as ServedStatsResponse;
  } finally {
    clearTimeout(timer);
  }

  const rows = validateServedBatterPayload(payload);
  if (!rows) throw new Error("served stats payload violates batter/full completeness contract");
  const servedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : "";
  if (!servedAt || !Number.isFinite(Date.parse(servedAt))) {
    throw new Error("served stats payload has no usable updatedAt");
  }
  return {
    updatedAt: servedAt,
    rows: rows.map((row) => ({
      ...row,
      war: calcBatterSaberFromStats(row)?.WAR ?? null,
      wrc_plus: calcBatterSaberFromStats(row)?.wRC_plus ?? null,
      player_key: canonicalKboId(row.kboId as string | number | null),
      kbo_id: canonicalKboId(row.kboId as string | number | null),
      name: String(row.name ?? ""),
      team: (row.team as string | null) ?? null,
      updated_at: servedAt,
    })) as SeasonRecordRow[],
  };
}

/**
 * 통산 리더보드용 당해 시즌 스냅샷 — **타자/투수 공용**.
 *
 * `fetchServedBatterSnapshot` 과 같은 정본(`/api/stats?full=1`)을 쓰되, 투수 축을 함께 연다.
 * ⚠️ 타자에만 있던 `full-entry 전집합` 완전성 계약은 그대로 유지한다(부분 스냅샷이면 증분이
 *   0 으로 깔려 통산이 과소 계산된다). 투수는 그 명단 정본이 아직 없어 **행수 하한 + kboId
 *   유일성**으로만 검증하고, 그 사실을 여기 명시해 둔다 — 나중에 명단이 생기면 같은 계약으로 올린다.
 */
export async function fetchServedCareerSnapshot(
  table: "batter" | "pitcher",
): Promise<{ rows: SeasonRecordRow[]; updatedAt: string }> {
  if (table === "batter") return fetchServedBatterSnapshot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVED_STATS_TIMEOUT_MS);
  let payload: ServedStatsResponse;
  try {
    const res = await fetch(`${PUBLIC_BASE}/api/stats?type=pitcher&full=1`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`served pitcher stats HTTP ${res.status}`);
    payload = (await res.json()) as ServedStatsResponse;
  } finally {
    clearTimeout(timer);
  }
  if (payload.type !== "pitcher" || !Number.isInteger(payload.count)) {
    throw new Error("served pitcher payload violates envelope contract");
  }
  const rows = Array.isArray(payload.stats) ? payload.stats : null;
  if (!rows || payload.count !== rows.length) {
    throw new Error("served pitcher payload count mismatch");
  }
  // 리그 전체가 아니면 증분이 0 으로 깔려 통산이 과소 계산된다 — 부분 스냅샷은 거절한다.
  if (rows.length < 200) throw new Error(`served pitcher coverage too small: ${rows.length}`);
  const servedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : "";
  if (!servedAt || !Number.isFinite(Date.parse(servedAt))) {
    throw new Error("served pitcher payload has no usable updatedAt");
  }
  const seen = new Set<string>();
  const mapped: SeasonRecordRow[] = [];
  for (const row of rows) {
    const id = canonicalKboId(row.kboId as string | number | null);
    // kboId 가 없는 행은 통산 기준선과 이을 수 없다 — 조용히 0 증분으로 두면 과소 계산이다.
    if (!id) continue;
    if (seen.has(id)) throw new Error(`served pitcher duplicate kboId: ${id}`);
    seen.add(id);
    mapped.push({
      ...row,
      player_key: id,
      kbo_id: id,
      name: String(row.name ?? ""),
      team: (row.team as string | null) ?? null,
      updated_at: servedAt,
    } as SeasonRecordRow);
  }
  return { rows: mapped, updatedAt: servedAt };
}

export async function fetchServedBatterRows(kboId: string): Promise<SeasonRecordRow[]> {
  const snapshot = await fetchServedBatterSnapshot();
  // 2행 이상이면 그대로 넘겨 `resolveSeasonRecord` 가 inconsistent 로 fail-close 한다.
  return snapshot.rows.filter((row) => String(row.kbo_id ?? "") === kboId);
}

/**
 * production 주입값을 만드는 seam.
 *
 * 서버가 인라인 lambda 로 넣으면 게이트가 "호출문 존재"만 검사하는 정규식으로 전락한다
 * (`createSeasonRecordFetcher` 와 같은 이유·같은 모양 — 삼순 3차 P0-3, 8차 P0-2).
 */
export function createServedRecordFetcher(): (kboId: string) => Promise<SeasonRecordRow[]> {
  return (kboId) => fetchServedBatterRows(kboId);
}

/**
 * DB row 와 서빙 row 가 **같은 선수·같은 현실**을 말하는지 확인한다.
 *
 * 두 소스를 섞어 쓰는 이상, 한쪽만 갱신된 상태에서 답하면 봇이 앱과 다른 숫자를 말한다.
 * 겹치는 지표가 하나라도 어긋나면 그 시점의 데이터를 신뢰할 수 없으므로 **답하지 않는다**.
 *
 * ⚠️ 한계를 명시해 둔다: sb·cs·obp·slg·ops 는 DB 에 컬럼 자체가 없어 **이 교차검증으로
 * 검출되지 않는다**. 그래서 값의 정확성은 교차검증이 아니라 "앱과 같은 경계에서 읽는다"는
 * 소스 선택으로 보장한다(삼순 3차 P0-3). 여기서 보는 것은 identity 와 겹치는 지표의 정합이다.
 *
 * 비교 대상은 두 소스에 **모두 있는** 정수 지표만이다. `avg` 같은 문자열 rate 는 표기
 * (`.300` vs `0.300`)가 소스마다 달라 값 동일성 판정에 부적합하다.
 */
const CROSS_CHECK_METRICS = ["games", "ab", "runs", "hits", "doubles", "triples", "hr", "tb", "rbi"] as const;

export type CrossCheckResult =
  | { kind: "ok" }
  /** DB 에 대응 행이 없음 — 교차검증 불가. 확인 못 한 상태로 답하지 않는다. */
  | { kind: "no_db_row" }
  | { kind: "mismatch"; metric: string; db: unknown; served: unknown };

export function crossCheckServedAgainstDb(
  servedRow: SeasonRecordRow | undefined,
  dbRows: SeasonRecordRow[],
): CrossCheckResult {
  if (!servedRow) return { kind: "no_db_row" };
  if (dbRows.length !== 1) return { kind: "no_db_row" };
  const dbRow = dbRows[0];
  if (dbRow.player_key !== servedRow.player_key || dbRow.kbo_id !== servedRow.kbo_id) {
    return { kind: "mismatch", metric: "identity", db: dbRow.kbo_id, served: servedRow.kbo_id };
  }
  if (dbRow.name !== servedRow.name || (dbRow.team ?? null) !== (servedRow.team ?? null)) {
    return { kind: "mismatch", metric: "name/team", db: `${dbRow.name}/${dbRow.team}`, served: `${servedRow.name}/${servedRow.team}` };
  }
  for (const metric of CROSS_CHECK_METRICS) {
    const dbValue = dbRow[metric];
    const servedValue = servedRow[metric];
    if (dbValue === undefined || servedValue === undefined) continue;
    if (Number(dbValue) !== Number(servedValue)) {
      return { kind: "mismatch", metric, db: dbValue, served: servedValue };
    }
  }
  return { kind: "ok" };
}
