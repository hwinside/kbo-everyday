// AI 경기 요약 — final 전이 백필 오케스트레이션 (2026-08-29 인시던트, 삼순 재리뷰 3건 반영).
//
// warmup 크론 틱마다 호출된다. 의존성(존재 조회·시도 상태·CAS claim·POST·관측)을 주입받는
// 순수 오케스트레이션이라 게이트가 mock deps 로 *행동*(fail-close/유계/CAS 경합/starvation
// 부재/give-up 1회+awaited 경보)을 직접 검증한다 — 이 함수 자체가 production seam 이다.
//
// 유계·동시실행 계약 (삼순 재리뷰 NO-GO 반영):
//  - per-tick 발사 상한(SUMMARY_BACKFILL_MAX_PER_TICK)은 *실제 발사(attempt)* 에만 적용.
//    backoff/gave-up/CAS 패배는 상한을 소비하지 않는다 → 앞 경기가 막혀도 뒤 final 경기가
//    지연·starvation 되지 않는다.
//  - 시도 증가는 read→blind upsert 가 아니라 **CAS**(expectedAttempts exact-match update,
//    첫 시도는 insert-only)로 원자화 — 겹친 분 크론이 카운터를 되감지 못해 상한 10회가
//    실제로 보장된다. CAS 패배 = 다른 run 이 이미 시도 중 → 이번 틱 skip(중복 발사 방지).
//  - 시도 기록(CAS 승리)이 POST 보다 선행 — 크래시에도 상한을 새지 않는다.
//  - exhausted: markGaveUp 도 CAS(false→true) — 승자만 reportGiveUp. 단 mark 가 *에러*면
//    경보 누락보다 중복이 낫다(fail-open for alerting) → report 는 실행한다.
//    reportGiveUp 은 **awaited** — 러너 promise 가 after() 로 수명 보장되므로 경보 1회가
//    응답 종료에 잘리지 않는다.
//  - 존재/상태 조회 실패 = "모른다" → 발사 0(fail-close), 다음 틱 재평가.

import {
  selectSummaryBackfillGames,
  backfillRetryDecision,
  SUMMARY_BACKFILL_MAX_PER_TICK,
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
  /**
   * 시도 카운터 원자 증가(CAS): expectedAttempts===0 이면 insert-only(중복=패배),
   * 아니면 attempts=expectedAttempts && gave_up=false 조건부 update(불일치=패배).
   * ok=false 는 DB 오류(fail-close), won=false 는 경합 패배(정상 skip).
   */
  claimAttempt(gameId: string, expectedAttempts: number): Promise<{ ok: boolean; won: boolean }>;
  /** 영구 종결 CAS(gave_up false→true). won=승자(내가 종결시킴), error=DB 오류. */
  markGaveUp(gameId: string): Promise<{ won: boolean; error: boolean }>;
  /** /api/game-summary POST 발사. */
  postSummary(gameId: string): Promise<{ status: number; result: string }>;
  /** 상한 소진 durable 관측(경보축, threshold 1). 러너가 await 한다. */
  reportGiveUp(gameId: string, attempts: number): Promise<void>;
  nowMs(): number;
}

export interface BackfillRunResult {
  launched: { gameId: string; status: number; result: string }[];
  gaveUp: string[];
  backedOff: string[];
  casLost: string[];
  failClosed: boolean;
}

export async function runSummaryBackfill(
  candidates: SummaryBackfillCandidate[],
  deps: BackfillDeps,
): Promise<BackfillRunResult> {
  const result: BackfillRunResult = { launched: [], gaveUp: [], backedOff: [], casLost: [], failClosed: false };
  const finalIds = candidates.filter((c) => c.gameId && c.gameStateSc === "3").map((c) => c.gameId);
  if (finalIds.length === 0) return result;

  const existingRes = await deps.listExistingSummaries(finalIds);
  if (!existingRes.ok) {
    result.failClosed = true;
    return result;
  }
  // 선정 단계는 cap 없이 전 대상 평가 — cap 을 여기서 걸면 앞 경기의 backoff/gave-up 이
  // 뒤 final 경기를 starvation 시킨다(삼순 재리뷰 ①). 발사 상한은 아래 attempt 시점에만.
  const targets = selectSummaryBackfillGames(candidates, existingRes.existing, Number.MAX_SAFE_INTEGER);
  if (targets.length === 0) return result;

  const statesRes = await deps.readAttemptStates(targets);
  if (!statesRes.ok) {
    result.failClosed = true;
    return result;
  }

  for (const gameId of targets) {
    const state = statesRes.states.get(gameId) ?? { attempts: 0, lastAttemptAtMs: null, gaveUp: false };
    if (state.gaveUp) continue; // 이미 종결(승자가 경보까지 완료) — cap 미소비.
    const decision = backfillRetryDecision(state.attempts, state.lastAttemptAtMs, deps.nowMs());
    if (decision === "exhausted") {
      const mark = await deps.markGaveUp(gameId);
      // CAS 승자만 report — 단 DB 오류면 경보 누락보다 중복이 낫다(fail-open for alerting).
      if (mark.won || mark.error) {
        await deps.reportGiveUp(gameId, state.attempts);
      }
      result.gaveUp.push(gameId);
      continue; // cap 미소비.
    }
    if (decision === "backoff") {
      result.backedOff.push(gameId);
      continue; // cap 미소비.
    }
    // attempt — 발사 상한은 실제 발사에만 적용(starvation 방지).
    if (result.launched.length >= SUMMARY_BACKFILL_MAX_PER_TICK) continue;
    const claim = await deps.claimAttempt(gameId, state.attempts);
    if (!claim.ok) {
      result.failClosed = true; // DB 오류 — 이 경기는 발사 안 함, 다음 틱 재평가.
      continue;
    }
    if (!claim.won) {
      result.casLost.push(gameId); // 겹친 run 이 선점 — 중복 발사 방지, cap 미소비.
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
