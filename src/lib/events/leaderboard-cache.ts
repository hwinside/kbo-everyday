import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllByKeyset } from "@/lib/db/paginate";

/**
 * v_leaderboard_writing 전체 rows 서버 메모리 캐시 (TTL 60s + in-flight dedup).
 *
 * 배경(2026-07-22 장애 후속 쿼리 최적화): 이 view는 chat_messages/comments/posts
 * 전체를 매 호출 재집계해 mean ~316ms (pg_stat_statements 총 실행시간 2위).
 * /api/leaderboard/writing + /api/leaderboard/my-rank(누적 writing)가 매 요청
 * view를 직접 치던 것을 60초 캐시로 흡수해 경기 피크 시간대 DB 부하를 줄인다.
 *
 * - 전량 수집: Supabase REST max-rows(1000) 상한으로 1,001위~ 유실되지 않도록
 *   user_id keyset으로 결정적 전량 페이징 후 서버에서 정렬 (삼순 리뷰 반영,
 *   운영 1,242행 > 1,000 실측)
 * - TTL 60s: writing 라우트의 기존 CDN s-maxage=60과 동일한 신선도 계약
 * - in-flight dedup: 캐시 만료 직후 동시 요청이 view를 중복 실행하는 것 방지
 * - 서버리스 인스턴스별 캐시라 완전 공유는 아니지만, 피크 시 warm 인스턴스
 *   기준 view 실행 횟수를 인스턴스당 분당 1회로 상한
 */

export interface WritingLeaderboardRow {
  user_id: string;
  nickname: string;
  team_id: number | null;
  total_points: number;
  last_active_day: string;
}

const TTL_MS = 60_000;

let cached: { rows: WritingLeaderboardRow[]; expiresAt: number } | null = null;
let inFlight: Promise<WritingLeaderboardRow[]> | null = null;

/** 순위 정렬: 점수 내림차순 → 활동일 오름차순 → user_id (결정적 tie-break) */
export function sortLeaderboardRows(rows: WritingLeaderboardRow[]): WritingLeaderboardRow[] {
  return [...rows].sort((a, b) => {
    if (a.total_points !== b.total_points) return b.total_points - a.total_points;
    if (a.last_active_day !== b.last_active_day) return a.last_active_day < b.last_active_day ? -1 : 1;
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
  });
}

type LeaderboardClient = Pick<SupabaseClient, "from">;

/** user_id keyset으로 view 전량 수집 후 순위 정렬. 테스트에서 client 주입 가능. */
export async function queryAllLeaderboardRows(
  injectedClient?: LeaderboardClient,
): Promise<WritingLeaderboardRow[]> {
  // 테스트(fake client 주입)에서 env 없이도 동작하도록 admin 모듈은 lazy import
  const client =
    injectedClient ?? (await import("@/lib/supabase/admin")).getSupabaseAdmin();
  const rows = await fetchAllByKeyset<WritingLeaderboardRow, string>(
    async (cursor, limit) => {
      let query = client
        .from("v_leaderboard_writing")
        .select("user_id, nickname, team_id, total_points, last_active_day")
        .order("user_id", { ascending: true })
        .limit(limit);
      if (cursor !== null) query = query.gt("user_id", cursor);
      const { data, error } = await query;
      return { data: data as WritingLeaderboardRow[] | null, error };
    },
    (row) => row.user_id,
    { label: "v_leaderboard_writing" },
  );
  return sortLeaderboardRows(rows);
}

/** 정렬된 전체 리더보드 rows 반환. 호출부에서 mutate 금지(공유 배열). */
export async function getWritingLeaderboardRows(): Promise<WritingLeaderboardRow[]> {
  if (cached && Date.now() < cached.expiresAt) return cached.rows;
  if (inFlight) return inFlight;

  inFlight = queryAllLeaderboardRows()
    .then((rows) => {
      cached = { rows, expiresAt: Date.now() + TTL_MS };
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
