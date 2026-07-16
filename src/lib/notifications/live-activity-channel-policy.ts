// Broadcast 채널 전환 — 정책 순수 함수 (스펙 v4). 유닛 스모크에서 직접 검증한다.

export type ApnsEnvironment = "production" | "sandbox";

/** priority 판정용 상태 스냅샷 — ContentState에서 추출. */
export interface ChannelPushDecisionInput {
  /** 점수/이닝/주자/상태 등 "즉시 반영" 축 (변화 = priority 10) */
  scoreState: string;
  /** 볼카운트/타자/lastPlay 포함 전체 축 (scoreState 무변화 + 이것만 변화 = priority 5) */
  fullStateHash: string;
  lastScoreState: string | null;
  lastStateHash: string | null;
}

export type ChannelPushDecision =
  | { send: true; priority: "10" | "5" }
  | { send: false };

/**
 * 채널 update 발송 판정: 점수/이닝/주자 변화 = 10(즉시), 그 외 변화 = 5(예산 미소모),
 * 완전 무변화 = 스킵. 직전 상태 미존재(첫 틱)는 10.
 */
export function decideChannelPush(input: ChannelPushDecisionInput): ChannelPushDecision {
  if (input.lastScoreState === null || input.scoreState !== input.lastScoreState) {
    return { send: true, priority: "10" };
  }
  if (input.lastStateHash === null || input.fullStateHash !== input.lastStateHash) {
    return { send: true, priority: "5" };
  }
  return { send: false };
}

/** ContentState → score축 문자열 (점수/이닝/초말/주자/status만). */
export function scoreStateOf(cs: Record<string, unknown>): string {
  return [
    cs.awayScore, cs.homeScore, cs.inning, cs.isTopInning,
    cs.onFirst, cs.onSecond, cs.onThird, cs.status,
  ].join("|");
}

/** ContentState → 전체축 문자열 (score축 + 볼카운트/투타/lastPlay). */
export function fullStateHashOf(cs: Record<string, unknown>): string {
  return [
    scoreStateOf(cs),
    cs.balls, cs.strikes, cs.outs, cs.pitcherName, cs.batterName, cs.lastPlay ?? "",
  ].join("|");
}

/**
 * p2s payload에 input-push-channel을 포함할 수 있는 토큰인지 (게이트, 토큰 단위).
 * 둘 다 클라 명시 보고값 — 미보고(null)는 레거시 (iOS17 이하에 channel payload를 보내면
 * start 자체가 실패하므로 보수적으로).
 */
export function p2sChannelEligible(token: {
  os_major: number | null;
  app_build: number | null;
}): boolean {
  return (token.os_major ?? 0) >= 18 && (token.app_build ?? 0) >= 16;
}

/**
 * p2s 발송 attempt 순서 — env는 게이트가 아니라 per-attempt 규칙 (v4 blocker①).
 * known이면 그 env 쌍만, null이면 prod 쌍 → (BadDeviceToken 시) sandbox 쌍.
 * 각 attempt에서 해당 env의 active 채널이 없으면 그 attempt는 채널 없이(기존 payload) 발송.
 * 불변식: 발송 host env == 포함 channelId env (교차 쌍 금지 — 쌍은 호출부가 이 순서로 구성).
 */
export function p2sEnvAttempts(knownEnv: ApnsEnvironment | null): ApnsEnvironment[] {
  return knownEnv === null ? ["production", "sandbox"] : [knownEnv];
}

/**
 * 종료 end broadcast backoff — attempt_count(이미 보낸 횟수) 기준 다음 재시도까지의 분.
 * 즉시(0회차) → 1m → 5m → 15m → 30m → 이후 1h 간격, 8h 창 내 총 ~13회 (v3 blocker③).
 * null = 더 이상 재시도 없음(8h 창 관리·DELETE는 호출부).
 */
const END_BACKOFF_MINUTES = [1, 5, 15, 30];

export function endRetryDelayMinutes(attemptCount: number): number {
  if (attemptCount <= 0) return 0; // 첫 발송은 즉시
  return END_BACKOFF_MINUTES[attemptCount - 1] ?? 60;
}

/** 종료 후 end 재시도·채널 유지 창 (이후 DELETE). per-토큰 end 저장창(8h)과 동급. */
export const CHANNEL_END_RETENTION_MS = 8 * 60 * 60 * 1000;

/**
 * register-start upsert 시 env 귀속 패치 (삼순 #659 blocker③).
 * `apns_environment`는 *토큰* 귀속 — 토큰이 교체되면(재설치/디버그↔프로드 전환) 기존 env가
 * 새 토큰에 승계되면 안 된다(예: sandbox 잔존 → 새 prod 토큰을 sandbox로만 발송 →
 * BadDeviceToken → 유효 토큰 삭제). 동일 토큰 재등록은 env 유지, 교체면 null로 리셋.
 */
export function startTokenEnvPatch(
  existingToken: string | null,
  newToken: string,
): { apns_environment: null } | Record<string, never> {
  return existingToken === newToken ? {} : { apns_environment: null };
}
