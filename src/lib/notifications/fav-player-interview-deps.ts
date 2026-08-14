import { unclaimEvent } from "@/lib/notifications/game-score";
import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import type {
  ClaimResult,
  InterviewDeps,
  PendingInterview,
} from "@/lib/notifications/fav-player-interview";

/** 한 run에서 처리할 미발송 인터뷰 상한 — KBO 하루 최대 10경기 × 인터뷰 수 여유. */
const PENDING_LIMIT = 40;

/**
 * event_id 선점 — 중복과 DB 오류를 **구분**해 반환한다.
 *
 * 공용 claimEvent(game-score.ts)는 둘 다 false로 뭉갠다. 득점 알림에서는 다음 이벤트가
 * 곧 오므로 감수되지만, 인터뷰는 경기당 1~2건뿐이라 DB 오류 한 번을 "이미 보냈음"으로
 * 오독하면 그 인터뷰가 영구 유실된다(삼순 NO-GO). 그래서 별도 구현을 둔다.
 */
async function claimInterviewEvent(eventId: string, gameId: string): Promise<ClaimResult> {
  const { data, error } = await supabase
    .from("notified_score_events")
    .upsert(
      { event_id: eventId, game_id: gameId },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select("event_id");
  if (error) return "error";
  return (data ?? []).length > 0 ? "claimed" : "duplicate";
}

/**
 * 수훈 인터뷰 알림의 실 인프라 배선 (DB·FCM).
 * 판정/오케스트레이션은 fav-player-interview.ts에 있고 여기는 어댑터만 —
 * 그래야 QA smoke가 env 없이 실제 발송 경로를 태울 수 있다.
 */
export function createInterviewDeps(): InterviewDeps {
  return {
    fetchPendingInterviews: async (): Promise<PendingInterview[]> => {
      // query-guard: bounded -- 미발송(notified_at is null) 인터뷰만 PENDING_LIMIT 상한으로 조회.
      // published_at 정렬 명시 — 무정렬 limit은 실행마다 다른 부분집합을 준다(M90 lesson).
      const { data, error } = await supabase
        .from("postgame_interviews")
        .select("id, game_id, video_id, title, player_names")
        .is("notified_at", null)
        .eq("confidence", "high")
        .order("published_at", { ascending: true })
        .limit(PENDING_LIMIT);
      if (error) throw new Error(`pending interviews query failed: ${error.message}`);
      const rows = data ?? [];
      if (rows.length === 0) return [];

      // winner_team_id는 jobs에 있다 — 동명이인 분리에 필요.
      const gameIds = [...new Set(rows.map((r) => r.game_id as string))];
      // query-guard: bounded -- 위 PENDING_LIMIT 행에서 파생된 exact game_id IN 조회.
      const { data: jobs, error: jobErr } = await supabase
        .from("postgame_interview_jobs")
        .select("game_id, winner_team_id")
        .in("game_id", gameIds);
      if (jobErr) throw new Error(`interview jobs query failed: ${jobErr.message}`);
      const winnerByGame = new Map(
        (jobs ?? []).map((j) => [j.game_id as string, j.winner_team_id as number]),
      );

      return rows.map((r) => ({
        id: r.id as string,
        gameId: r.game_id as string,
        videoId: r.video_id as string,
        title: r.title as string,
        playerNames: (r.player_names as string[]) ?? [],
        winnerTeamId: winnerByGame.get(r.game_id as string) ?? null,
      }));
    },

    // unique key가 (game_id, video_id)라 video_id 단독 update는 다른 경기의 같은
    // 영상 행까지 건드린다. PK(id)로 정확히 그 행만 표시한다(삼순 NO-GO ③).
    markNotified: async (rowIds: string[]): Promise<void> => {
      const { error } = await supabase
        .from("postgame_interviews")
        .update({ notified_at: new Date().toISOString() })
        .in("id", rowIds)
        .is("notified_at", null);
      if (error) throw new Error(`mark notified failed: ${error.message}`);
    },

    claimEvent: claimInterviewEvent,
    unclaimEvent,
    fetchFavoritePlayerFanIds: (kboId) => fetchFavoritePlayerFanIds(kboId),
    // prefKey 전달 = 토글 off 유저 필터링(sendFcmToUsers 내부 notification_prefs 조회).
    sendPush: async (userIds, payload, prefKey) => {
      const result = await sendFcmToUsers(userIds, payload, prefKey);
      return { ok: result.ok };
    },
  };
}
