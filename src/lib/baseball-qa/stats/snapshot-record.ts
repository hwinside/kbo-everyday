import batterSnapshot from "@/lib/constants/stats-2026-batters.json";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import type { SeasonRecordRow } from "./season-record";

/**
 * 도루·출루율·장타율·OPS 의 **정본 소스**.
 *
 * ⚠️ 왜 DB 테이블이 아니라 여기인가 (하린아빠 2026-08-04 20:42 "도루 OPS가 왜 없어? /
 * 우리가 다 제공하고 있는 데이터인데").
 *
 * `player_stats_batter` 테이블에는 sb·cs·obp·slg·ops **컬럼 자체가 없다**(cron upsert
 * 페이로드에 없음). 그런데 앱은 이 값들을 이미 화면에 보여주고 있다 —
 * 선수 상세(`도루`·`OPS`), 팀 기록, 타이틀 탭이 전부 `/api/stats` 를 쓰고,
 * `/api/stats` 의 정본이 바로 이 `stats-2026-batters.json` 이다.
 * (Production 실측 2026-08-04: `source=naver-fallback`, 황성빈 35도루·김도영 OPS 1.022 —
 *  이 파일 값과 정확히 일치.)
 *
 * 내가 DB 테이블 하나만 보고 "데이터가 없다"고 단정한 것이 틀렸다.
 *
 * **봇이 앱과 다른 숫자를 말하는 것이 가장 나쁜 결과**이므로, 화면이 쓰는 소스를 그대로 쓴다.
 */

interface SnapshotBatterRow {
  name: string;
  team: string;
  kboId: string;
  [metric: string]: unknown;
}

const SNAPSHOT_ROWS = batterSnapshot as unknown as SnapshotBatterRow[];

/** 스냅샷 생성 시각 — DB row 의 `updated_at` 과 같은 자리에서 stale 판정에 쓴다. */
export const SNAPSHOT_GENERATED_AT: string =
  (statsMeta as { battersGeneratedAt?: string }).battersGeneratedAt ?? "";

/**
 * kboId exact 로 스냅샷 행을 찾는다. **이름 조회 금지** — 동명이인이 섞인다(DB 경로와 동일 계약).
 *
 * 반환 형태를 `SeasonRecordRow`(snake_case + updated_at)로 맞춰 기존 검증기
 * (`resolveSeasonRecord`: identity 교차검증 / stale / 값 형식)를 **그대로 재사용**한다.
 * 검증 로직을 따로 만들면 그쪽만 느슨해진다.
 */
export function fetchSnapshotBatterRows(kboId: string): SeasonRecordRow[] {
  const matched = SNAPSHOT_ROWS.filter((row) => row.kboId === kboId);
  // 2행 이상이면 그대로 넘겨 `resolveSeasonRecord` 가 inconsistent 로 fail-close 한다.
  return matched.map((row) => ({
    ...row,
    player_key: row.kboId,
    kbo_id: row.kboId,
    name: row.name,
    team: row.team ?? null,
    updated_at: SNAPSHOT_GENERATED_AT,
  })) as SeasonRecordRow[];
}

/**
 * production 주입값을 만드는 seam.
 *
 * 서버가 인라인 lambda 로 넣으면 게이트가 "호출문 존재"만 검사하는 정규식으로 전락한다
 * (`createSeasonRecordFetcher` 와 같은 이유·같은 모양 — 삼순 3차 P0-3, 8차 P0-2).
 */
export function createSnapshotRecordFetcher(): (kboId: string) => Promise<SeasonRecordRow[]> {
  return async (kboId) => fetchSnapshotBatterRows(kboId);
}

/**
 * DB row 와 스냅샷 row 가 **같은 선수·같은 현실**을 말하는지 확인한다.
 *
 * 두 소스를 섞어 쓰는 이상, 한쪽만 갱신된 상태에서 답하면 봇이 앱과 다른 숫자를 말한다.
 * 겹치는 지표가 하나라도 어긋나면 그 시점의 데이터를 신뢰할 수 없으므로 **답하지 않는다**.
 *
 * 비교 대상은 두 소스에 **모두 있는** 정수 지표만이다. `avg` 같은 문자열 rate 는 표기
 * (`.300` vs `0.300`)가 소스마다 달라 값 동일성 판정에 부적합하다.
 */
const CROSS_CHECK_METRICS = ["games", "ab", "runs", "hits", "doubles", "triples", "hr", "tb", "rbi"] as const;

export type CrossCheckResult =
  | { kind: "ok" }
  /** DB 에 대응 행이 없음 — 교차검증 불가. 확인 못 한 상태로 답하지 않는다. */
  | { kind: "no_db_row" }
  | { kind: "mismatch"; metric: string; db: unknown; snapshot: unknown };

export function crossCheckSnapshotAgainstDb(
  snapshotRow: SeasonRecordRow | undefined,
  dbRows: SeasonRecordRow[],
): CrossCheckResult {
  if (!snapshotRow) return { kind: "no_db_row" };
  if (dbRows.length !== 1) return { kind: "no_db_row" };
  const dbRow = dbRows[0];
  if (dbRow.player_key !== snapshotRow.player_key || dbRow.kbo_id !== snapshotRow.kbo_id) {
    return { kind: "mismatch", metric: "identity", db: dbRow.kbo_id, snapshot: snapshotRow.kbo_id };
  }
  if (dbRow.name !== snapshotRow.name || (dbRow.team ?? null) !== (snapshotRow.team ?? null)) {
    return { kind: "mismatch", metric: "name/team", db: `${dbRow.name}/${dbRow.team}`, snapshot: `${snapshotRow.name}/${snapshotRow.team}` };
  }
  for (const metric of CROSS_CHECK_METRICS) {
    const dbValue = dbRow[metric];
    const snapValue = snapshotRow[metric];
    if (dbValue === undefined || snapValue === undefined) continue;
    if (Number(dbValue) !== Number(snapValue)) {
      return { kind: "mismatch", metric, db: dbValue, snapshot: snapValue };
    }
  }
  return { kind: "ok" };
}
