import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * v_leaderboard_writing 전체 rows 서버 메모리 캐시 (TTL 60s + in-flight dedup).
 *
 * 배경(2026-07-22 장애 후속 쿼리 최적화): 이 view는 chat_messages/comments/posts
 * 전체를 매 호출 재집계해 mean ~316ms (pg_stat_statements 총 실행시간 2위).
 * /api/leaderboard/writing + /api/leaderboard/my-rank(누적 writing)가 매 요청
 * view를 직접 치던 것을 60초 캐시로 흡수해 경기 피크 시간대 DB 부하를 줄인다.
 *
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

async function queryView(): Promise<WritingLeaderboardRow[]> {
  // query-guard: bounded -- 리더보드 view는 이벤트 참여 유저 수 상한(현재 ~1.2k행)이고 순위 계산에 전체 rows가 필요, 60s 캐시로 호출 흡수
  const { data, error } = await getSupabaseAdmin()
    .from("v_leaderboard_writing")
    .select("user_id, nickname, team_id, total_points, last_active_day")
    // view 내 ORDER BY에 의존하지 않고 명시적 정렬 (기존 라우트 계약 유지)
    .order("total_points", { ascending: false })
    .order("last_active_day", { ascending: true });
  if (error) throw new Error(`v_leaderboard_writing query failed: ${error.message}`);
  return (data ?? []) as WritingLeaderboardRow[];
}

/** 정렬된 전체 리더보드 rows 반환. 호출부에서 mutate 금지(공유 배열). */
export async function getWritingLeaderboardRows(): Promise<WritingLeaderboardRow[]> {
  if (cached && Date.now() < cached.expiresAt) return cached.rows;
  if (inFlight) return inFlight;

  inFlight = queryView()
    .then((rows) => {
      cached = { rows, expiresAt: Date.now() + TTL_MS };
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
