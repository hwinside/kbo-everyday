// AI 경기 요약 — final 전이 백필 오케스트레이션 (2026-08-29 인시던트, 삼순 NO-GO ②③축 반영).
//
// warmup 크론 틱마다 호출된다. 의존성(존재 조회·시도 상태·POST·관측)을 주입받는 순수
// 오케스트레이션이라 게이트가 mock deps 로 *행동*(fail-close/유계 재시도/give-up 1회)을
// 직접 검증한다 — regex 호출 횟수 검사가 아니라 이 함수 자체가 production seam 이다.
//
// 유계 계약:
//  - per-tick 발사 상한: selectSummaryBackfillGames(cap 3).
//  - per-game 시도 상한: SUMMARY_BACKFILL_MAX_ATTEMPTS(10) + backoff — backfillRetryDecision.
//  - 시도 카운트는 POST *이전*에 durable 기록(recordAttempt) — 크래시해도 시도로 계산돼
//    상한을 새지 않는다(at-most-bounded).
//  - exhausted 최초 1회만 markGaveUp + reportGiveUp(durable, 경보축) — 이후 틱은 무시.
//  - 존재/상태 조회 실패 = "모른다" → 발사 0(fail-close), 다음 틱 재평가.

import {
  selectSummaryBackfillGames,
  backfillRetryDecision,
  type SummaryBackfillCandidate,
} from "@/lib/game-summary/final-transition";

export interface BackfillAttemptState {
  attempts: number;
  lastAttemptAtMs: number | null;
  gaveUp: boolean;
}

export interface BackfillDeps {
  /** game_summaries 존재 조회. ok=false 면 fail-close(발사 0). */
  listExistingSummaries(gameIds: string[]): Promise<{ ok: boolean; existing: Set<string> }>;
  /** game_summary_backfill_state 조회. ok=false 면 fail-close(발사 0). 행 없으면 map 에 부재. */
  readAttemptStates(gameIds: string[]): Promise<{ ok: boolean; states: Map<string, BackfillAttemptState> }>;
  /** 시도 기록(upsert attempts+1, last_attempt_at=now). POST 이전에 호출된다. */
  recordAttempt(gameId: string, nextAttempts: number): Promise<{ ok: boolean }>;
  /** 상한 도달 영구 종결 플래그. */
  markGaveUp(gameId: string): Promise<void>;
  /** /api/game-summary POST 발사. */
  postSummary(gameId: string): Promise<{ status: number; result: string }>;
  /** 상한 소진 durable 관측(경보축) — 인시던트가 자동복구에 실패했음을 알린다. */
  reportGiveUp(gameId: string, attempts: number): void;
  nowMs(): number;
}

export interface BackfillRunResult {
  launched: { gameId: string; status: number; result: string }[];
  gaveUp: string[];
  backedOff: string[];
  failClosed: boolean;
}

export async function runSummaryBackfill(
  candidates: SummaryBackfillCandidate[],
  deps: BackfillDeps,
): Promise<BackfillRunResult> {
  const result: BackfillRunResult = { launched: [], gaveUp: [], backedOff: [], failClosed: false };
  const finalIds = candidates.filter((c) => c.gameId && c.gameStateSc === "3").map((c) => c.gameId);
  if (finalIds.length === 0) return result;

  const existingRes = await deps.listExistingSummaries(finalIds);
  if (!existingRes.ok) {
    result.failClosed = true;
    return result;
  }
  const targets = selectSummaryBackfillGames(candidates, existingRes.existing);
  if (targets.length === 0) return result;

  const statesRes = await deps.readAttemptStates(targets);
  if (!statesRes.ok) {
    result.failClosed = true;
    return result;
  }

  for (const gameId of targets) {
    const state = statesRes.states.get(gameId) ?? { attempts: 0, lastAttemptAtMs: null, gaveUp: false };
    if (state.gaveUp) continue; // 이미 종결 — 관측도 1회로 끝났다.
    const decision = backfillRetryDecision(state.attempts, state.lastAttemptAtMs, deps.nowMs());
    if (decision === "exhausted") {
      await deps.markGaveUp(gameId);
      deps.reportGiveUp(gameId, state.attempts);
      result.gaveUp.push(gameId);
      continue;
    }
    if (decision === "backoff") {
      result.backedOff.push(gameId);
      continue;
    }
    // attempt — 카운트를 POST 보다 먼저 durable 기록(크래시에도 상한 유지). 기록 실패면 발사 안 함.
    const recorded = await deps.recordAttempt(gameId, state.attempts + 1);
    if (!recorded.ok) {
      result.failClosed = true;
      continue;
    }
    try {
      const r = await deps.postSummary(gameId);
      result.launched.push({ gameId, ...r });
    } catch (e) {
      result.launched.push({ gameId, status: 0, result: `fetch-error:${(e as Error).message}` });
    }
  }
  return result;
}
