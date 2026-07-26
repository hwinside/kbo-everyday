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

// removed(신고 임계/어드민) 격리 기간 — 이 기간 경과 후에만 영구삭제(오신고 복구 여지).
export const VENUE_STORY_REMOVED_QUARANTINE_DAYS = 30;

/** cleanup 행에 실제로 취할 액션. classifyCleanupRow 결과를 소비해 결정한다. */
export type CleanupAction =
  | "archive" // 정상 만료 → 삭제 대신 status='archived'(storage/댓글 보존, 다이어리 보관)
  | "delete" // storage+행 삭제(장애 누수 방지 / 격리 만료 removed / 검증실패 등)
  | "quarantine_keep"; // 미노출 격리 유지 — 이번엔 아무 것도 안 함(removed 30일 미만 등)

/**
 * cleanup 대상 행에 취할 액션 결정(순수 정책, 스펙 §2).
 *  - expired_after_end + active → archive (보관). active 외(pending 등 미검증)는 delete(누수 방지, 기존 동작).
 *  - stale_cap → delete (finalize 장애 누수 방지 + 관제, S1 기존 동작 유지).
 *  - flagged(cleanup_failed) → delete (storage 삭제 재시도, 기존 동작).
 *      TODO(S 후속): 장애건 소유불명·영구실패 판정 후 TTL 삭제 고도화.
 *  - flagged(removed) → removed_at 기준 30일 경과 시 delete, 아니면 quarantine_keep.
 *      removed_at null(레거시/검증실패 removed) 은 격리 대상 아님 → delete(기존 즉시 정리 유지).
 *  - archived → quarantine_keep (보관된 행은 cleanup 이 절대 삭제하지 않는다 — 다이어리 영구 보관 안전장치).
 */
export function resolveCleanupAction(opts: {
  cls: CleanupRowClass;
  status: string;
  removedAtMs: number | null;
  nowMs: number;
}): CleanupAction {
  const { cls, status, removedAtMs, nowMs } = opts;
  // 보관된 행은 어떤 분류든 삭제 금지(방어). 다이어리 보관 원본을 cleanup 이 지우면 안 된다.
  if (status === "archived") return "quarantine_keep";
  if (cls === "expired_after_end") return status === "active" ? "archive" : "delete";
  if (cls === "stale_cap") return "delete";
  if (cls === "flagged") {
    if (status === "cleanup_failed") return "delete"; // storage 삭제 재시도(기존 동작)
    if (status === "removed") {
      // removed_at 미상 = 격리 대상 아님(레거시/검증실패) → 기존처럼 즉시 삭제.
      if (removedAtMs == null || !Number.isFinite(removedAtMs)) return "delete";
      const ageMs = nowMs - removedAtMs;
      return ageMs >= VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000 ? "delete" : "quarantine_keep";
    }
  }
  return "quarantine_keep"; // keep 등 그 외 — 아무 것도 안 함(route 에서 keep 은 이미 skip).
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
