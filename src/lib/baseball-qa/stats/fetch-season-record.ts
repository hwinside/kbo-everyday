import type { SeasonRecordRow } from "./season-record";

export type SeasonRecordTable = "batter" | "pitcher";

/**
 * Supabase 의 거대한 generic 대신 이 조회가 실제 사용하는 최소 계약만 둔다.
 * 테스트가 recording fake 를 주입해 production query의 column/value/limit를 actual 검증한다.
 */
export interface SeasonRecordClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        limit(limit: number): PromiseLike<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * 운영 stats row 를 **player_key=kboId exact** 로 조회한다.
 *
 * player_key 는 cron upsert 충돌키(정본)이고 kbo_id 는 하류 식별키다. 조회는 정본축으로 하고,
 * `resolveSeasonRecord`가 반환 row의 player_key + kbo_id를 다시 교차검증한다.
 * limit 2는 중복행을 숨기지 않고 fail-close 하기 위한 상한이다.
 */
export async function fetchSeasonRecordRows(
  client: SeasonRecordClient,
  table: SeasonRecordTable,
  kboId: string,
): Promise<SeasonRecordRow[]> {
  return fetchSeasonRecordRowsImpl(client, table, kboId);
}

async function fetchSeasonRecordRowsImpl(
  client: SeasonRecordClient,
  table: SeasonRecordTable,
  kboId: string,
): Promise<SeasonRecordRow[]> {
  const tableName = table === "batter" ? "player_stats_batter" : "player_stats_pitcher";
  // query-guard: bounded -- player_key exact single-entity lookup with hard limit 2.
  const { data, error } = await client
    .from(tableName)
    .select("*")
    .eq("player_key", kboId)
    .limit(2);
  if (error) throw new Error(error.message);
  return (data ?? []) as SeasonRecordRow[];
}

/**
 * production `QaDeps.fetchSeasonRecord` 주입값을 만드는 seam.
 *
 * 서버가 인라인 lambda로 직접 주입하면 그 lambda 안의 분기를 테스트가 실행할 수 없어
 * "호출문 존재"만 검사하는 정규식 게이트로 전락한다. `NODE_ENV==='production'이면 []`
 * 같은 반대가설이 GREEN으로 통과해버리므로(삼순 3차 P0-3), 주입값을 이 factory로
 * 끌어내 테스트가 **실제 배포되는 함수를 그대로 실행**해 table/kboId/row 전달을 actual 검증한다.
 */
export function createSeasonRecordFetcher(
  client: SeasonRecordClient,
): (table: SeasonRecordTable, kboId: string) => Promise<SeasonRecordRow[]> {
  // query-guard: bounded -- player_key exact 일치 + limit 2.
  return (table, kboId) => fetchSeasonRecordRowsImpl(client, table, kboId);
}
