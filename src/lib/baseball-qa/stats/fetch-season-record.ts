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
