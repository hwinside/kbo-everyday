// iOS 홈 위젯 무음 갱신 — 순수 판정 (1.0.9 build 17). supabase 비의존 → 스모크에서 직접 검증.
import type { KboRawGame } from "@/types/api";

export function safeInt(v: unknown): number {
  const n = parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseTeamCodes(gameId: string): { away: string; home: string } | null {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

/**
 * 위젯 무음 push dedupe 키 — *점수만* (삼순 #674 blocker①).
 * 이닝/아웃/주자를 키에 넣으면 경기당 수십~100회로 예산 초과 → 승인 스코프
 * "최초 live 1회 + 점수 변화 시"만 발송한다(경기당 ~10-25회). 이닝/아웃/주자
 * 정보는 발송되는 payload에는 담기되(표시용), 발송 트리거는 되지 않는다.
 */
export function iosWidgetScoreState(g: KboRawGame): string {
  return `${safeInt(g.T_SCORE_CN)}|${safeInt(g.B_SCORE_CN)}`;
}

/** transient 실패 재시도 상한 — 같은 점수 상태에 대해 최대 2회 재시도 후 포기(전진 유지). */
export const WIDGET_PUSH_MAX_RETRIES = 2;
/** claim-insert(row 없던 경기)의 revert 목적지 — 다음 틱 claim-update 경로로 재시도(attempts 보존). */
export const WIDGET_RETRY_SENTINEL = "";

/**
 * 커서 claim 판정 (삼순 #674 blocker④ — cron 중첩 atomic fence의 1단계).
 * 실제 claim은 CAS(update ... eq(last_score_state, prev) / insert ignoreDuplicates)로
 * 수행해 동시 cron 인스턴스 중 하나만 발송한다.
 */
export function decideWidgetPushClaim(
  prevState: string | null,
  nextState: string,
): "skip" | "claim-update" | "claim-insert" {
  if (prevState === null) return "claim-insert"; // 최초 live — 1회 발송
  if (prevState === nextState) return "skip"; // 점수 무변화
  // 되감김 가드(#1311 삼순 B② 3축 적용): 점수가 뒤로 가는 스냅샷은 발송 skip.
  // Naver→KBO(stale) fallback 틱이 위젯 점수를 8→5로 되감는 걸 막는다. 점수는 단조.
  if (isWidgetScoreRetreat(prevState, nextState)) return "skip";
  return "claim-update";
}

/**
 * iosWidgetScoreState("away|home") 포맷에서 점수 후퇴 여부 — 점수는 단조라 감소면 되감김.
 * 위젯 발송 트리거 자체가 *점수-only* 설계(#674)라 가드도 점수만 본다 — 이닝만 후퇴하고
 * 점수 동일한 스냅샷은 애초에 발송 트리거가 안 되므로(broadcast 축과 기준 불일치는 의도적). */
export function isWidgetScoreRetreat(prevState: string, nextState: string): boolean {
  const p = prevState.split("|");
  const n = nextState.split("|");
  if (p.length < 2 || n.length < 2) return false;
  const pa = Number(p[0]);
  const ph = Number(p[1]);
  const na = Number(n[0]);
  const nh = Number(n[1]);
  if ([pa, ph, na, nh].some((v) => !Number.isFinite(v))) return false;
  return na < pa || nh < ph;
}

/** invalid-token 정리분을 제외한 transient 실패 수 — 이게 0이어야 커서 전진 확정. */
export function widgetTransientFailures(r: { ok: boolean; failed: number; cleaned: number }): number {
  if (!r.ok) return 1; // 인프라 실패 = 전량 transient
  return Math.max(0, r.failed - r.cleaned);
}

/**
 * transient 실패 시 커서 revert 여부 (삼순 #674 blocker④ — bounded retry).
 * attempts < max → revert해 다음 틱 같은 점수 재발송. 상한 도달 → 전진 유지(포기,
 * 다음 점수 변화가 자연 복구). revert도 CAS(eq(last_score_state, next))로 중첩 안전.
 */
export function shouldRevertWidgetCursor(
  attempts: number,
  maxRetries: number = WIDGET_PUSH_MAX_RETRIES,
): boolean {
  return attempts < maxRetries;
}

/**
 * 지연/역순 배달 fence — Swift `WidgetSnapshotStore.markLiveScore` 게이트의 TS 미러
 * (삼순 #674 blocker③ 계약 고정용 — iOS 타깃엔 유닛 인프라가 없어 동일 로직을 여기
 * 스모크로 잠근다. Swift 쪽과 항상 동치 유지할 것).
 * - 스냅샷이 이미 final → 적용 안 함 (final → old 순서 방어)
 * - 저장된 eventMs보다 오래된(≤) 이벤트 → 적용 안 함 (new → old 회귀 방어)
 */
export function shouldApplyWidgetLiveEvent(
  storedEventMs: number | null,
  incomingEventMs: number,
  snapshotIsFinal: boolean,
): boolean {
  if (snapshotIsFinal) return false;
  if (storedEventMs !== null && incomingEventMs <= storedEventMs) return false;
  return true;
}

/**
 * same-game 스냅샷 write 시 fence 승계 판정 — Swift `WidgetSnapshotStore.write` 미러
 * (삼순 #674 재리뷰 blocker① 계약 고정용, 양쪽 동치 유지).
 * 같은 경기의 다른 writer(JS 브리지/LA 라이프사이클)는 fence 키 없는 dict로 전체
 * 교체하므로 보존하지 않으면 삭제되고, 그 뒤 늦은 배달이 stored=nil로 통과해 점수가
 * 되돌아간다(`new push → same-game write → old push` 회귀). 규칙:
 * - writer가 fence를 명시 전진(markLiveScore, 새 dict에 키 있음) → 승계 안 함(자기 값)
 * - 같은 경기 + 키 없는 write → 기존 fence 승계(보존)
 * - 다른 경기(새 경기 스냅샷) → 승계 안 함(fence 리셋이 정상)
 */
export function shouldPreserveWidgetFence(
  prevGameId: string | null,
  nextGameId: string,
  nextWriteHasEventMs: boolean,
): boolean {
  if (nextWriteHasEventMs) return false;
  return prevGameId !== null && prevGameId === nextGameId;
}
