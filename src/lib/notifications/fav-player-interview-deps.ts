import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";
import { sendFcmToTokens, sendFcmToUsers } from "@/lib/notifications/fcm";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import type {
  InterviewDeps,
  PendingInterview,
  SentMarkerState,
} from "@/lib/notifications/fav-player-interview";

/** lease 유지 시간 — cron 주기(5분)와 함수 maxDuration(60s)을 함께 커버. */
const LEASE_MS = 10 * 60 * 1000;

/**
 * 노출 확인은 **유저가 실제로 읽는 공개 경로**를 그대로 탄다.
 * DB를 다시 조회하면 "저장됐다"만 재확인할 뿐이라 2026-08-15 사고(저장돼 있었음에도
 * 엣지 stale 응답으로 빈 목록이 나간 것)를 전혀 잡지 못한다.
 * VERCEL_URL 은 배포 보호에 막힐 수 있어 공개 도메인을 쓴다(widget 경로와 동일 관례).
 */
const PUBLIC_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan";
const VISIBILITY_TIMEOUT_MS = 5000;

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

      // durable retry 원장 — postgame_interviews는 공개 SELECT라 raw FCM 토큰을 둘 수
      // 없다(삼순 P0). service_role 전용 별도 테이블에서 lease된 행만 조회한다.
      // query-guard: bounded -- lease된 최대 40행에서 파생된 exact id IN 조회.
      const { data: retryRows, error: retryErr } = await supabase
        .from("postgame_interview_retry_tokens")
        .select("row_id, tokens, attempts, visibility_deferrals")
        .in("row_id", rows.map((r) => r.id));
      if (retryErr) throw new Error(`retry ledger query failed: ${retryErr.message}`);
      const retryByRow = new Map(
        (retryRows ?? []).map((r) => [r.row_id as string, {
          tokens: Array.isArray(r.tokens)
            ? (r.tokens as unknown[]).filter(
                (t): t is string => typeof t === "string" && t.length > 0,
              )
            : [],
          attempts: typeof r.attempts === "number" ? r.attempts : 1,
          // 노출 보류는 FCM attempts와 별도 카운터(삼순 P0-2).
          visibilityDeferrals:
            typeof r.visibility_deferrals === "number" ? r.visibility_deferrals : 0,
        }]),
      );

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
        retryTokens: retryByRow.get(r.id as string)?.tokens ?? [],
        attempts: retryByRow.get(r.id as string)?.attempts ?? 0,
        visibilityDeferrals: retryByRow.get(r.id as string)?.visibilityDeferrals ?? 0,
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
      // 원장 정리 — sent 행은 다시 lease되지 않아 잔존해도 무해하지만(행 삭제 시
      // cascade), raw 토큰을 필요 이상 보관하지 않는다.
      const { error: purgeErr } = await supabase
        .from("postgame_interview_retry_tokens")
        .delete()
        .in("row_id", rowIds);
      if (purgeErr) throw new Error(`retry ledger purge failed: ${purgeErr.message}`);
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

    /**
     * 유저가 알림을 타고 들어갔을 때 보는 그 응답을 그대로 받아 확인한다.
     * 캐시를 우회하지 않는다 — 우회하면 "서버엔 있다"를 확인하는 것이지
     * 유저가 본다는 근거가 안 된다(이번 사고의 핵심).
     * ⚠️ 엣지 POP은 리전별이라 이 확인이 전세계 동일성을 보장하진 않는다.
     * 캐시 정책(collecting 중 stale 금지)이 1차 방어고, 이건 그 위의 종단 확인이다.
     */
    isVisibleOnGamePage: async (gameId, videoId): Promise<SentMarkerState> => {
      try {
        const response = await fetch(
          `${PUBLIC_BASE}/api/game-interviews?gameId=${encodeURIComponent(gameId)}`,
          { signal: AbortSignal.timeout(VISIBILITY_TIMEOUT_MS) },
        );
        if (!response.ok) return "error";
        const json = await response.json() as { items?: Array<{ videoId?: string }> };
        if (!Array.isArray(json.items)) return "error";
        return json.items.some((item) => item.videoId === videoId) ? "present" : "absent";
      } catch {
        return "error";
      }
    },
    // prefKey 전달 = 토글 off 유저 필터링(sendFcmToUsers 내부 notification_prefs 조회).
    // settled = ok 또는 outcomes 존재. 전원 토글 OFF·등록 토큰 0은 sendFcmToUsers가
    // ok:true + outcomes 없이 돌아오는 **정상 종결**이라 ok를 반드시 함께 본다
    // (outcomes 유무만 보면 이 경로가 영구 pending — 삼순 NO-GO 3차 P0).
    // 인프라 선행 실패(env 미설정·prefs 조회 실패·deadline)는 ok:false + outcomes 없음
    // → settled:false → release. 부분 성공(ok:false여도 outcomes 있음)은 transient만
    // durable settle한다(삼순 P1).
    sendPush: async (userIds, payload, prefKey) => {
      const result = await sendFcmToUsers(userIds, payload, prefKey);
      return {
        settled: result.ok || Array.isArray(result.outcomes),
        retryableTokens: (result.outcomes ?? [])
          .filter((o) => o.status === "transient")
          .map((o) => o.token),
      };
    },
    // durable retry — 실패 확정 토큰에만 재발송(유저/prefs 재조회 없음).
    sendToTokens: async (tokens, payload) => {
      const result = await sendFcmToTokens(tokens, payload);
      return {
        settled: result.ok || Array.isArray(result.outcomes),
        retryableTokens: (result.outcomes ?? [])
          .filter((o) => o.status === "transient")
          .map((o) => o.token),
      };
    },
    // transient 토큰 durable 저장(service_role 전용 원장) + 행 pending 복귀.
    // 원장 upsert 성공 후 행 전이 순서 — 행 전이가 실패하면 throw → 호출부 release,
    // lease 만료 후 재획득 때 원장 토큰이 그대로 있어 토큰 경로로 재시도된다.
    /**
     * 노출 보류 — 행을 pending으로 되돌리고 보류 카운터만 올린다.
     * `attempts`는 건드리지 않는다(삼순 P0-2: FCM 재시도 예산과 분리).
     * 원장 행이 없으면 tokens=[] 로 생성하되 기존 tokens는 절대 덮어쓰지 않는다
     * — 덮어쓰면 직전 run의 transient 토큰이 사라져 기기가 영구 유실된다.
     */
    recordVisibilityDeferral: async (rowId, deferrals) => {
      const { data: existing, error: readErr } = await supabase
        .from("postgame_interview_retry_tokens")
        .select("row_id")
        .eq("row_id", rowId)
        .maybeSingle();
      if (readErr) throw new Error(`visibility deferral read failed: ${readErr.message}`);

      if (existing) {
        // tokens/attempts 미변경 — 보류 카운터만 갱신.
        const { error } = await supabase
          .from("postgame_interview_retry_tokens")
          .update({ visibility_deferrals: deferrals, updated_at: new Date().toISOString() })
          .eq("row_id", rowId);
        if (error) throw new Error(`visibility deferral update failed: ${error.message}`);
      } else {
        const { error } = await supabase
          .from("postgame_interview_retry_tokens")
          .insert({
            row_id: rowId, tokens: [], attempts: 0,
            visibility_deferrals: deferrals, updated_at: new Date().toISOString(),
          });
        if (error) throw new Error(`visibility deferral insert failed: ${error.message}`);
      }

      const { error: relErr } = await supabase
        .from("postgame_interviews")
        .update({ notify_state: "pending", notify_lease_until: null })
        .eq("id", rowId);
      if (relErr) throw new Error(`visibility deferral release failed: ${relErr.message}`);
    },

    storeRetryTokens: async (rowId, tokens, attempts) => {
      const { error: ledgerErr } = await supabase
        .from("postgame_interview_retry_tokens")
        .upsert(
          { row_id: rowId, tokens, attempts, updated_at: new Date().toISOString() },
          { onConflict: "row_id" },
        );
      if (ledgerErr) throw new Error(`retry ledger upsert failed: ${ledgerErr.message}`);
      const { error } = await supabase
        .from("postgame_interviews")
        .update({ notify_state: "pending", notify_lease_until: null })
        .eq("id", rowId)
        .neq("notify_state", "sent");
      if (error) throw new Error(`store retry tokens failed: ${error.message}`);
    },
  };
}
