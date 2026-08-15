import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import type {
  InterviewDeps,
  PendingInterview,
  SentMarkerState,
} from "@/lib/notifications/fav-player-interview";

/** lease 유지 시간 — cron 주기(5분)와 함수 maxDuration(60s)을 함께 커버. */
const LEASE_MS = 10 * 60 * 1000;

/**
 * 수훈 인터뷰 알림의 실 인프라 배선 (DB·FCM).
 * 판정/오케스트레이션은 fav-player-interview.ts에 있고 여기는 어댑터만 —
 * 그래야 QA smoke가 env 없이 실제 발송 경로를 태울 수 있다.
 */
export function createInterviewDeps(): InterviewDeps {
  return {
    /**
     * pending(또는 lease 만료된 processing) 행을 원자적 UPDATE로 processing 전이.
     * Postgres row lock + READ COMMITTED 재평가 덕에 두 run이 같은 행을 동시에
     * 잡을 수 없다: 늦은 쪽 UPDATE는 lock 대기 후 WHERE를 다시 평가하는데, 그때
     * notify_state=processing + 미래 lease_until이라 어느 분기에도 안 걸린다.
     */
    leasePendingInterviews: async (): Promise<PendingInterview[]> => {
      // query-guard: bounded -- RPC 내부 ORDER BY + LIMIT 40 + FOR UPDATE SKIP LOCKED.
      const { data, error } = await supabase.rpc(
        "claim_postgame_interview_notifications",
        { p_limit: 40, p_lease_seconds: Math.floor(LEASE_MS / 1000) },
      );
      if (error) throw new Error(`lease pending interviews failed: ${error.message}`);
      const rows = (data ?? []) as Array<{
        id: string; game_id: string; video_id: string; title: string; player_names: string[] | null;
      }>;
      if (rows.length === 0) return [];

      // winner_team_id는 jobs에 있다 — 동명이인 분리에 필요.
      const gameIds = [...new Set(rows.map((r) => r.game_id as string))];
      // query-guard: bounded -- 위 lease된 행에서 파생된 exact game_id IN 조회.
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
    // 영상 행까지 건드린다. PK(id)로 정확히 그 행만 전이한다.
    markSent: async (rowIds: string[]): Promise<void> => {
      const { error } = await supabase
        .from("postgame_interviews")
        .update({ notify_state: "sent", notify_lease_until: null })
        .in("id", rowIds);
      if (error) throw new Error(`mark sent failed: ${error.message}`);
    },

    releaseLease: async (rowIds: string[]): Promise<void> => {
      const { error } = await supabase
        .from("postgame_interviews")
        .update({ notify_state: "pending", notify_lease_until: null })
        .in("id", rowIds)
        .neq("notify_state", "sent");
      if (error) throw new Error(`release lease failed: ${error.message}`);
    },

    /**
     * sent 마커 — notified_score_events 재사용, event_id = interview#{videoId}.
     * 조회 오류를 absent로 오독하면 이중발송이라 3분기로 반환한다.
     */
    hasSentMarker: async (gameId: string, videoId: string): Promise<SentMarkerState> => {
      const { data, error } = await supabase
        .from("notified_score_events")
        .select("event_id")
        .eq("event_id", `interview#${gameId}#${videoId}`)
        .maybeSingle();
      if (error) return "error";
      return data ? "present" : "absent";
    },

    insertSentMarker: async (gameId: string, videoId: string): Promise<boolean> => {
      const { error } = await supabase
        .from("notified_score_events")
        .upsert(
          { event_id: `interview#${gameId}#${videoId}`, game_id: gameId },
          { onConflict: "event_id", ignoreDuplicates: true },
        );
      return !error;
    },

    fetchFavoritePlayerFanIds: (kboId) => fetchFavoritePlayerFanIds(kboId),
    // prefKey 전달 = 토글 off 유저 필터링(sendFcmToUsers 내부 notification_prefs 조회).
    //
    // retryableFailed 를 반드시 함께 올린다 — fcm-batch 는 토큰별 transient 실패
    // (server-unavailable/quota/deadline 미시도)를 retryableFailed 로만 세고 ok=true 를
    // 유지한다. ok 만 보면 core 가 marker+sent 로 종결해 그 토큰들이 영구 유실된다.
    // B안(유실보다 희소 중복) 계약상 이 경우는 release → 다음 run 재시도가 맞다.
    sendPush: async (userIds, payload, prefKey) => {
      const result = await sendFcmToUsers(userIds, payload, prefKey);
      return { ok: result.ok, retryableFailed: result.retryableFailed ?? 0 };
    },
  };
}
