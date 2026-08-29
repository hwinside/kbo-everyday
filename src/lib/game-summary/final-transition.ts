// AI 경기 요약 — final 전이 감지 백필 선정 (2026-08-29 LG:롯데 콜드게임 인시던트).
//
// 배경: KBO가 7회 강우콜드 경기의 final 전이를 실플레이 중단(20:43) 후 ~1시간 40분 뒤
// (22:21)에야 내려줬다. prewarm-summaries 크론은 매시 :15라 최대 60분 공백이 생기고,
// 그 사이 유저는 종료 화면에서 요약 없음을 본다(복구는 수동 트리거였다).
//
// 처방(삼순 C안): 매분 도는 game-events-warmup 틱에서 "final 인데 요약 row 가 없는"
// 경기를 감지해 즉시 생성을 트리거한다. 수렴 확인·생성·저장의 정합성은 전부
// /api/game-summary POST 의 canonicalGate + claim lease + fingerprint save fence 가
// 담당하므로 여기서는 *후보 선정만* 한다(병렬 로직 금지 — 게이트 재구현하지 않는다).
// bounded retry = 틱마다 재평가하되 per-tick 상한으로 발사 수를 묶는다. 생성이 성공해
// row 가 생기면 다음 틱부터 자연히 제외된다(존재 판정이 곧 종료 조건).
//
// 순수 모듈(.ts, 서버/게이트 공용): 게이트가 production seam 과 같은 함수를 태우도록
// 라우트가 아닌 이 파일에 둔다(verifier_reads_artifacts lesson — .tsx/route 내 판정 금지).

import { isAllStarGameId } from "@/lib/constants/teams";

/** KBO GetGameList GAME_STATE_SC: 1=예정, 2=라이브, 3=종료, 4/5=취소류. */
export const KBO_GAME_STATE_FINAL = "3";

export interface SummaryBackfillCandidate {
  gameId: string;
  /** KBO GAME_STATE_SC 원문 (undefined/null 이면 상태 미상 → 선정 제외, fail-close). */
  gameStateSc: string | null | undefined;
}

/** per-tick 발사 상한 — KBO 하루 최대 5경기 + 더블헤더 여유. Gemini 동시 호출 폭주 방지. */
export const SUMMARY_BACKFILL_MAX_PER_TICK = 3;

/**
 * final 인데 요약 캐시 row 가 없는 경기만 골라낸다.
 * - 존재 판정은 row 유무만 본다(legacy/stale 재생성은 prewarm + 유저 POST 경로의 몫 —
 *   여기서 prompt_version 까지 보면 매분 재생성 루프가 될 수 있다).
 * - 올스타전은 요약 미제공 정책(#544)이라 영구 재시도 루프가 되므로 제외.
 * - 상태 미상(gameStateSc 없음)은 선정하지 않는다(fail-close).
 */
export function selectSummaryBackfillGames(
  candidates: SummaryBackfillCandidate[],
  existingSummaryIds: ReadonlySet<string>,
  maxPerTick: number = SUMMARY_BACKFILL_MAX_PER_TICK,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= maxPerTick) break;
    if (!c.gameId) continue;
    if (c.gameStateSc !== KBO_GAME_STATE_FINAL) continue;
    if (isAllStarGameId(c.gameId)) continue;
    if (existingSummaryIds.has(c.gameId)) continue;
    out.push(c.gameId);
  }
  return out;
}

// ===== 유계 재시도 (삼순 NO-GO ②축: row 부재 매분 영구 재시도 금지) =====
//
// per-game 시도 카운터를 durable(game_summary_backfill_state)로 보관하고, 매 틱은
// 이 순수 판정으로 attempt/backoff/exhausted 를 가른다. 스케줄:
//   1~3회차: 매 틱(즉시 — final 직후 수렴 지연/일시 플레이크 흡수)
//   4~6회차: 4분 backoff (지속 장애면 Gemini/소스가 문제 — 툴을 쓴다)
//   7~10회차: 14분 backoff → 총 ~70분 커버 후 exhausted(영구 종결 + durable give-up 기록).
// 성공(row 생성)은 존재 조회에서 자연 종료라 이 판정까지 오지 않는다.

export const SUMMARY_BACKFILL_MAX_ATTEMPTS = 10;

export function backfillBackoffMs(attempts: number): number {
  if (attempts <= 3) return 0; // 1~3회차 이후에도 다음 틱 즉시(60s 크론 간격이 자연 하한)
  if (attempts <= 6) return 4 * 60_000;
  return 14 * 60_000;
}

export type BackfillDecision = "attempt" | "backoff" | "exhausted";

export function backfillRetryDecision(
  attempts: number,
  lastAttemptAtMs: number | null,
  nowMs: number,
  maxAttempts: number = SUMMARY_BACKFILL_MAX_ATTEMPTS,
): BackfillDecision {
  if (attempts >= maxAttempts) return "exhausted";
  if (attempts > 0 && lastAttemptAtMs != null && nowMs - lastAttemptAtMs < backfillBackoffMs(attempts)) {
    return "backoff";
  }
  return "attempt";
}
