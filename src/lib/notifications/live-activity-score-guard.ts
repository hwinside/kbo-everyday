import { after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { trackApiDegradation } from "@/lib/monitoring/api-fallback-tracker";
import type { KboRawGame } from "@/types/api";
import { isScoreStateRetreat } from "./live-activity-channel-policy";
import { hasLiveScoreAgreement, liveScoreObservation } from "./live-activity-score-evidence";

export interface ScoreGuardObservation {
  allowCorrection: boolean;
  blockedCount: number;
  blockedMs: number;
  candidateCount?: number;
  outOfOrder?: boolean;
  error?: string;
}

function alert(gameId: string, detail: string): void {
  // Existing durable outbox handles cooldown, delivery ACK, and retries. Never hold APNs
  // behind the Telegram network call. next/after preserves work beyond the response.
  try {
    after(() => trackApiDegradation(`la-score-guard-${gameId}`, "score-guard",
      { scope: gameId, errorMessage: detail },
      { windowMinutes: 5, threshold: 1, cooldownMinutes: 5, leaseSeconds: 30 }));
  } catch (error) {
    // Missing request context / after registration failure must never abort APNs.
    console.error(`[la-score-guard] alert scheduling failed game=${gameId}`, (error as Error).message);
  }
}

export async function observeLiveActivityScoreGuard(
  game: KboRawGame, lastScoreState: string | null, scoreState: string,
): Promise<ScoreGuardObservation> {
  if (!lastScoreState) return { allowCorrection: false, blockedCount: 0, blockedMs: 0 };
  const observation = liveScoreObservation(game);
  const regressed = isScoreStateRetreat(lastScoreState, scoreState);
  const eligible = observation.freshRelay && !isScoreStateRetreat(lastScoreState, scoreState, true);
  const corroborated = eligible && hasLiveScoreAgreement(game);
  try {
    const { data, error } = await supabase.rpc("observe_live_activity_score_guard", {
      p_game_id: game.G_ID, p_baseline: lastScoreState,
      // Runner changes / inning advance must not reset the same score correction.
      p_candidate: scoreState.split("|").slice(0, 2).join("|"),
      p_observed_at: new Date(observation.observedAtMs).toISOString(),
      p_regressed: regressed, p_eligible: eligible, p_corroborated: corroborated,
    }).abortSignal(AbortSignal.timeout(1500));
    if (error || !data) throw new Error(error?.message ?? "missing guard state");
    const result = data as ScoreGuardObservation;
    result.allowCorrection = result.allowCorrection && liveScoreObservation(game).freshRelay;
    if (regressed) {
      console.log(`[la-score-guard] game=${game.G_ID} count=${result.blockedCount} ms=${result.blockedMs} corrected=${result.allowCorrection}`);
      if (!result.allowCorrection && (result.blockedCount >= 3 || result.blockedMs >= 30_000)) {
        alert(game.G_ID, `Live Activity 점수 정정 차단: ${lastScoreState} → ${scoreState}; 연속 ${result.blockedCount}회/${result.blockedMs}ms. 원본·채널 확인 필요.`);
      }
    }
    return result;
  } catch (error) {
    console.error(`[la-score-guard] state unavailable game=${game.G_ID}`, (error as Error).message);
    alert(game.G_ID, "Live Activity 점수 가드 상태 저장 실패. 연속 차단 관측/시간 해제 불가; 직접 원본 합의 정정만 허용.");
    return { allowCorrection: corroborated, blockedCount: 0, blockedMs: 0, error: "guard_state_unavailable" };
  }
}
