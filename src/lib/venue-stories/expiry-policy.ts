// 직관 라이브 — 만료/정리 순수 정책(단위 테스트 가능).
//
// 계약(삼순 09:44 #2 / 하린아빠 스펙): 만료 = **경기 종료 +24h**.
//  - terminal(final/cancelled) 전에는 expiry 삭제 금지.
//  - finalize cron 이 terminal 전이를 CAS(game_ended_at IS NULL 가드)로 성공시킨 뒤에만
//    expires_at = 감지시각+24h 확정.
//  - 종료 미감지 안전상한(시작+72h)은 별도 장애 정책 — 도달 = finalize 장애 신호이므로
//    cleanup 이 staleCap 으로 관제(5xx)하면서 누수 방지 삭제만 수행한다(정상 만료 아님).

import {
  VENUE_STORY_EXPIRY_HOURS_AFTER_END,
  VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START,
} from "./types";

/** 경기 status 가 terminal(만료 확정 가능)인가 — finalize cron 전용 판정. */
export function isTerminalGameStatus(status: string | null | undefined): boolean {
  return status === "final" || status === "cancelled";
}

/** terminal 감지 시각 기준 확정 만료(ISO). */
export function finalizedExpiryIso(detectedAtMs: number): string {
  return new Date(detectedAtMs + VENUE_STORY_EXPIRY_HOURS_AFTER_END * 3600_000).toISOString();
}

/** 업로드 시 넣는 종료 미감지 안전상한(ISO) — 정상 만료 조건이 아니라 장애 상한. */
export function safetyCapExpiryIso(startMs: number): string {
  return new Date(startMs + VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START * 3600_000).toISOString();
}

export type CleanupRowClass =
  | "flagged" // removed/cleanup_failed — 즉시 정리 대상
  | "expired_after_end" // 종료 확정 + 종료+24h 경과 — 공개 종료, 미디어 보존
  | "stale_cap" // 종료 미확정인데 안전상한(시작+72h) 도달 — 장애 정책 삭제 + 관제
  | "keep"; // terminal 전 + 상한 미도달 — 삭제 금지

/** 정상 만료는 공개만 종료하고, 물리삭제는 운영/장애 정리 대상에만 허용한다. */
export function shouldPhysicallyDeleteCleanupRow(cls: CleanupRowClass): boolean {
  return cls === "flagged" || cls === "stale_cap";
}

/**
 * cleanup 대상 행 분류. terminal(game_ended_at 확정) 전에는 expiry 삭제를 금지하고,
 * 안전상한 도달만 stale_cap(장애 정책)으로 구분해 관제와 함께 처리한다.
 */
export function classifyCleanupRow(opts: {
  status: string;
  gameEndedAt: string | null;
  expiresAtMs: number | null;
  nowMs: number;
}): CleanupRowClass {
  const { status, gameEndedAt, expiresAtMs, nowMs } = opts;
  if (status === "removed" || status === "cleanup_failed") return "flagged";
  if (expiresAtMs == null || !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) return "keep";
  // 여기부터 expires_at <= now
  if (gameEndedAt != null) return "expired_after_end"; // 종료 확정 후 +24h 경과 — 정상 만료
  return "stale_cap"; // 종료 미확정 — 시작+72h 안전상한 도달(finalize 장애) → 관제 + 누수 방지 삭제
}
