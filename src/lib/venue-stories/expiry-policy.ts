// 직관 라이브 — 만료/정리 순수 정책(단위 테스트 가능).
//
// 계약(삼순 09:44 #2 / 하린아빠 스펙): 만료 = **경기 종료 +24h**.
//  - terminal(final/cancelled) 전에는 expiry 삭제 금지.
//  - finalize cron 이 terminal 전이를 CAS(game_ended_at IS NULL 가드)로 성공시킨 뒤에만
//    expires_at = 감지시각+24h 확정.
//  - 종료 미감지 안전상한(시작+72h)은 별도 장애 정책 — 도달 = finalize 장애 신호이므로
//    cleanup 처리 배치에서 제외하고 staleCap 으로 격리+관제(5xx)한다(정상 만료 아님).

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
  | "flagged" // removed/cleanup_failed — 격리·삭제 정책 판정 대상
  | "expired_after_end" // 종료 확정 + 종료+24h 경과 — 공개 종료, 미디어 보존
  | "stale_cap" // 종료 미확정인데 안전상한(시작+72h) 도달 — 장애 격리 + 관제
  | "keep"; // terminal 전 + 상한 미도달 — 삭제 금지

// removed(신고 임계/어드민) 격리 기간 — 이 기간 경과 후에만 영구삭제(오신고 복구 여지).
export const VENUE_STORY_REMOVED_QUARANTINE_DAYS = 30;

// cleanup_failed(정리 실패로 남은 장애건)의 영구실패 TTL — storage remove 가 이 기간 넘게 반복 실패하면
// 무한 재시도 대신 행을 강제 삭제한다(cleanup_failed_at 기준). 삼순 NO-GO blocker 2.
export const VENUE_STORY_CLEANUP_FAILED_TTL_DAYS = 7;

/** cleanup 행에 실제로 취할 액션. classifyCleanupRow 결과를 소비해 결정한다. */
export type CleanupAction =
  | "archive" // 정상 만료 active → status='archived'(storage/댓글 보존, 다이어리 보관)
  | "delete" // storage 제거 후 행 삭제(성공 시). 정상만료 미검증 누수방지 / 격리 30일 경과 removed / cleanup_failed removed출신 재시도. 실패 시 cleanup_failed 로 남겨 재시도
  | "force_delete" // 영구실패 TTL(cleanup_failed_at+7일) 경과 → storage remove 성공 여부와 무관하게 행 강제 삭제(무한 재시도 중단)
  | "quarantine_keep"; // 미노출 격리 유지 — 이번엔 아무 것도 안 함(removed 30일 미만 / stale_cap / archived / cleanup_failed 출신 불명)

/**
 * cleanup 대상 행에 취할 액션 결정(순수 정책, 스펙 §2.2 승인 계약).
 *  - expired_after_end + active → archive (보관). active 외(pending 등 미검증)는 delete(누수 방지).
 *  - stale_cap → quarantine_keep (finalize 장애 = 즉시삭제 금지, 격리 유지 + 관제(5xx)). ※route 가 stale_cap 을 별도 카운트해 5xx.
 *  - flagged(cleanup_failed) → removed_at 존재 시에만 removed 출신으로 확정해 30일·TTL 후 삭제.
 *      removed_at null은 active/pending 어느 출신인지 복원할 수 없으므로 자동 archive/delete 금지, 격리+관제.
 *  - flagged(removed) → removed_at 기준 30일 경과 시에만 delete, 그 전은 quarantine_keep(오신고 복구 여지).
 *      removed_at null/미상(레거시/검증실패) → quarantine_keep(즉시삭제 금지). migration 백필 + 전이 경로가 removed_at 을 채워
 *      30일 후 삭제되게 한다. 여기선 방어적으로 '확정 30일 경과' 없이는 절대 삭제하지 않는다(fail-safe=격리).
 *  - archived → quarantine_keep (보관된 행은 cleanup 이 절대 삭제하지 않는다 — 다이어리 영구 보관 안전장치).
 */
export function resolveCleanupAction(opts: {
  cls: CleanupRowClass;
  status: string;
  removedAtMs: number | null;
  gameEndedAtMs?: number | null; // cleanup_failed 출신 판별에는 사용 금지(active/pending 구분 불가)
  cleanupFailedAtMs: number | null;
  nowMs: number;
}): CleanupAction {
  const { cls, status, removedAtMs, cleanupFailedAtMs, nowMs } = opts;
  // 보관된 행은 어떤 분류든 삭제 금지(방어). 다이어리 보관 원본을 cleanup 이 지우면 안 된다.
  if (status === "archived") return "quarantine_keep";
  if (cls === "expired_after_end") return status === "active" ? "archive" : "delete";
  if (cls === "stale_cap") return "quarantine_keep"; // 장애 → 즉시삭제 금지, 격리 + 관제(route 5xx)
  if (cls === "flagged") {
    if (status === "cleanup_failed") {
      return resolveCleanupFailedAction({ removedAtMs, cleanupFailedAtMs, nowMs });
    }
    if (status === "removed") {
      // removed_at 미상 = 격리 시계 미확정 → 즉시삭제 금지(quarantine_keep). 30일 확정 경과만 delete.
      if (removedAtMs == null || !Number.isFinite(removedAtMs)) return "quarantine_keep";
      const ageMs = nowMs - removedAtMs;
      return ageMs >= VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000 ? "delete" : "quarantine_keep";
    }
  }
  return "quarantine_keep"; // keep 등 그 외 — 아무 것도 안 함(route 에서 keep 은 이미 skip).
}

/**
 * cleanup_failed 행의 출신을 removed_at 으로만 확정해 분기(스펙 §2.2, 삼순 조건부 GO).
 * status='cleanup_failed' 가 이전 상태를 덮었고 game_ended_at 만으로 active/pending 출신을 구분할 수 없다.
 *  - removed_at 존재 → removed 출신: 30일 격리 경과 전엔 격리. 경과 후에도 storage 반복 실패하면
 *    cleanup_failed_at TTL(7일) 경과 시 force_delete(강제 행 삭제), TTL 미경과는 delete 재시도(실패 시 격리 유지).
 *  - removed_at null → 출신 불명: 자동 archive/delete 금지, 격리 유지 + 관제(quarantine_keep).
 */
function resolveCleanupFailedAction(opts: {
  removedAtMs: number | null;
  cleanupFailedAtMs: number | null;
  nowMs: number;
}): CleanupAction {
  const { removedAtMs, cleanupFailedAtMs, nowMs } = opts;
  if (removedAtMs != null && Number.isFinite(removedAtMs)) {
    // removed 출신 — 30일 격리 경과 전엔 삭제 금지(오신고 복구 여지).
    if (nowMs - removedAtMs < VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000) return "quarantine_keep";
    // 30일 경과 → 삭제 대상. 반복 storage 실패 방어: cleanup_failed_at TTL 경과 시만 강제 삭제.
    if (
      cleanupFailedAtMs != null && Number.isFinite(cleanupFailedAtMs) &&
      nowMs - cleanupFailedAtMs >= VENUE_STORY_CLEANUP_FAILED_TTL_DAYS * 86400_000
    ) {
      return "force_delete";
    }
    return "delete"; // storage 재삭제 재시도(실패 시 다시 cleanup_failed = 격리 유지)
  }
  return "quarantine_keep"; // removed_at null = 출신 불명 → 자동 archive/delete 금지, 격리 + 관제
}

/**
 * cleanup 배치 조회(WHERE)에 넣을 "이번 실행에서 실제로 처리 가능한 행"인지 판정(순수).
 * route.ts 의 `.or(...)` 조회 필터의 SSOT — SQL 과 이 술어는 반드시 같은 경계를 인코딩한다.
 * 이유(삼순 blocker 1): no-op 될 행(30일 미만·미상 removed, stale_cap, archived)이
 * `id ASC → limit 500` 배치를 점유하면 뒤의 archive/삭제 대상이 영구 starvation 된다. 그래서
 * 조회 단계에서 실행 가능 행만 뽑는다.
 *  - active/pending 이며 expires_at 경과 이고 **game_ended_at 확정**(종료 확정) → 정상 만료 archive 후보.
 *      ※ game_ended_at NULL(=stale_cap, finalize 장애 안전상한 도달)은 quarantine_keep no-op 이므로 배치에서 제외
 *      (삼순 blocker 1: 저-id stale_cap 500이 limit 을 점유해 뒤 archive/removed 가 굶는 starvation). stale_cap 은 route 가 별도 count 로 관제.
 *  - cleanup_failed 는 removed_at 이 30일 경과한 removed 출신만 삭제 재시도 대상.
 *      removed_at null(출신 불명)·30일 미만은 no-op 격리라 배치에서 제외하고 route 별도 count 로 관제.
 *  - removed 는 removed_at 이 30일 경과했을 때만(그 전/미상은 격리 유지 = 조회 불필요).
 *  - archived / keep → 대상 아님.
 */
export function isCleanupActionable(opts: {
  status: string;
  expiresAtMs: number | null;
  gameEndedAtMs: number | null;
  removedAtMs: number | null;
  nowMs: number;
}): boolean {
  const { status, expiresAtMs, gameEndedAtMs, removedAtMs, nowMs } = opts;
  if (
    (status === "active" || status === "pending") &&
    expiresAtMs != null &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= nowMs &&
    gameEndedAtMs != null &&
    Number.isFinite(gameEndedAtMs) // stale_cap(game_ended_at 미확정) 배제 — no-op 이므로 배치 점유 금지
  ) {
    return true; // 정상 만료(archive) 후보
  }
  if (status === "cleanup_failed") {
    if (removedAtMs == null || !Number.isFinite(removedAtMs)) return false;
    return nowMs - removedAtMs >= VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000;
  }
  if (status === "removed") {
    // 30일 확정 경과만 삭제 대상 → 조회. 미상/30일 미만은 no-op 이라 조회에서 제외(starvation 방지).
    if (removedAtMs == null || !Number.isFinite(removedAtMs)) return false;
    return nowMs - removedAtMs >= VENUE_STORY_REMOVED_QUARANTINE_DAYS * 86400_000;
  }
  return false; // archived / 그 외 — 배치 조회 대상 아님
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
  return "stale_cap"; // 종료 미확정 — 시작+72h 안전상한 도달(finalize 장애) → 격리 + 관제
}
