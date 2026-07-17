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

/** 레거시 per-토큰 update 발송 판정 입력 (#664 catch-up). */
export interface LegacyTokenUpdateInput {
  /** 경기 단위 skip/priority 판정(decideChannelPush 결과). null = 판정 재료 없음. */
  decision: ChannelPushDecision | null;
  /** 토큰 등록/갱신 시각(ms). null = updated_at 미기록(레거시 행). */
  tokenUpdatedAtMs: number | null;
  /** 직전 상태 기록 시각(ms) — 상태 행 updated_at. null = 상태 행 없음. */
  lastWriteAtMs: number | null;
}

export type LegacyTokenUpdateDecision =
  | { send: true; priority?: "10" | "5" }
  | { send: false };

/**
 * 레거시 per-토큰 update 발송 판정 — 늦은 토큰 catch-up 포함 (#664).
 *
 * 경기 단위 무변화 스킵(#662)은 "모든 토큰이 직전 발송을 받았다"를 전제하는데, 직전 상태
 * 기록(lastWriteAtMs) *이후* 등록/갱신된 토큰은 그 발송을 못 받았을 수 있다(늦은 update
 * 토큰 등록 → 카드가 예정 프레임에 고착, 2026-07-17 재현). 그런 토큰은 스킵/p5 틱이어도
 * p10 1회 발송해 현재 프레임으로 끌어올린다.
 *
 * 반복 p10 방지: 발송 성공 틱이 상태 행 updated_at을 *틱 시작 시각*으로 갱신하므로,
 * 다음 틱엔 tokenUpdatedAtMs < lastWriteAtMs가 되어 자연 해제된다. 상태 행 기록을
 * 틱 시작 시각(토큰 fetch 이전)으로 쓰는 이유 = 틱 처리 중(토큰 fetch~upsert 사이)
 * 등록된 토큰이 기록 시각보다 과거가 되어 catch-up을 영영 놓치는 race 방지 — 그래서
 * 판정은 >= (경계 포함): 같은 ms 등록도 catch-up으로 본다(여분 p10 최대 1회, 무해).
 */
export function decideLegacyTokenUpdate(input: LegacyTokenUpdateInput): LegacyTokenUpdateDecision {
  const isCatchUp =
    input.lastWriteAtMs !== null &&
    input.tokenUpdatedAtMs !== null &&
    input.tokenUpdatedAtMs >= input.lastWriteAtMs;
  // 판정 재료 없음(채널/폴백 행 모두 부재) = 기존 매분 발송 동작 그대로(priority 미지정 = 10).
  if (input.decision === null) return { send: true };
  if (!input.decision.send) {
    return isCatchUp ? { send: true, priority: "10" } : { send: false };
  }
  return { send: true, priority: isCatchUp ? "10" : input.decision.priority };
}

/** 재설치/토큰 교체 감지 start 재발급 판정 입력 (2026-07-17 재설치 카드 미발급 사고). */
export interface StartReissueInput {
  /**
   * 토큰 *세대* 시각(ms) = token_changed_at — 토큰 값이 실제로 바뀐 시각만.
   * ⚠️ updated_at(등록 heartbeat — 같은 토큰도 포그라운드마다 갱신, #664 catch-up 용도)을
   * 쓰면 정상 재등록을 재설치로 오인해 중복 카드가 나간다(삼순 NO-GO 2026-07-17).
   * null = 세대 미기록(레거시 행) → 보수적(기존 동작).
   */
  tokenGenerationMs: number | null;
  /** 이 경기 기존 발급 기록(started_users) 생성 시각. null = 없음. */
  claimCreatedAtMs: number | null;
  /**
   * 현재 토큰의 device_key(sha256)와 *정확히 일치*하는 유효 채널 구독 존재 여부.
   * 시각 비교가 아니라 세대 identity 정합 — 이전 설치 구독(다른 device_key)은 차단 안 함.
   */
  hasCurrentTokenSubscription: boolean;
  /** 경기 예정 시작 시각(ms). null = 파싱 불가. */
  gameStartMs: number | null;
  nowMs: number;
  startWindowMs: number;
}

export type StartReissueDecision =
  | { eligible: false }
  | { eligible: true; invalidateStaleClaim: boolean };

/**
 * p2s start 발송 대상 판정 — 재설치(토큰 교체) 유저 재발급 포함.
 *
 * 배경(2026-07-17): 경기 중 재설치 시 기존 카드는 사라지는데, 서버엔 ①기존 발급
 * 기록(started_users)이 남아 재발송 차단 ②경기 +90분 가드가 게임 단위로 skip.
 * 규칙:
 * - 늦은 윈도우(시작+startWindowMs 경과): *경기 시작 이후 세대가 바뀐(=새로 등록된) 토큰만*
 *   대상 (복구된 cron의 뒷북 대량 발송 방지는 유지 — 재설치/신규 등록만 예외).
 * - 현재 토큰 device_key와 일치하는 구독 ACK 존재 = 이 설치가 구독 중 → 제외.
 *   다른 device_key 구독(이전 설치 잔재, 카드 소멸)은 차단하지 않음.
 * - 발급 기록이 토큰 세대 이후면 = 이 세대가 이미 받음 → 제외. 세대 이전 기록은
 *   stale → invalidate(삭제) 후 재선점·재발송. 같은 토큰 포그라운드 재등록은 세대가
 *   그대로라 claim이 stale로 안 보임(중복 카드 없음).
 * - tokenGenerationMs null(레거시 행)은 보수적: claim 있으면 제외, 늦은 윈도우 제외.
 * - 한계(서버 관측 범위): 재설치인데 iOS가 *동일한* p2s 토큰을 재발급하면 서버는
 *   정상 재등록과 구분 불가(install-generation 클라 신호 없이는 불가능, PR 명기).
 * 반복 방지: 재발송 성공 시 새 claim(created_at=now > tokenGenerationMs)이 생김 → 다음 틱 제외.
 */
export function decideStartReissue(i: StartReissueInput): StartReissueDecision {
  const lateWindow =
    i.gameStartMs !== null && i.nowMs - i.gameStartMs > i.startWindowMs;
  if (lateWindow) {
    if (
      i.tokenGenerationMs === null ||
      i.gameStartMs === null ||
      i.tokenGenerationMs < i.gameStartMs
    ) {
      return { eligible: false };
    }
  }
  if (i.hasCurrentTokenSubscription) return { eligible: false };
  if (i.claimCreatedAtMs !== null) {
    if (i.tokenGenerationMs === null || i.claimCreatedAtMs >= i.tokenGenerationMs) {
      return { eligible: false };
    }
    return { eligible: true, invalidateStaleClaim: true };
  }
  return { eligible: true, invalidateStaleClaim: false };
}

/**
 * register-start upsert 시 토큰 세대 기록 패치 — 토큰 값이 실제로 바뀔 때만
 * token_changed_at 갱신(신규 행 포함: existing null → 세대 시작). 동일 토큰
 * 재등록(포그라운드 heartbeat)은 세대 보존 — startTokenEnvPatch와 같은 계약.
 */
export function startTokenChangePatch(
  existingToken: string | null,
  newToken: string,
  nowIso: string,
): { token_changed_at: string } | Record<string, never> {
  return existingToken === newToken ? {} : { token_changed_at: nowIso };
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

// ── 동시성 fence (삼순 #659 재리뷰 blocker①②) ────────────────────────────────
// APNs I/O는 느리다 — 요청이 나가 있는 동안 DB 행이 교체될 수 있다(채널 재생성 /
// p2s 토큰 rotation). 결과를 DB에 반영할 때는 "내가 읽었던 그 세대"에만 쓰도록
// PK 외에 세대 식별자(channel_id / push_to_start_token)를 조건에 포함한다.
// affected 0행 = 그 사이 교체됨(stale worker) → no-op이 정답.

/** 채널 mutation fence — PK + 내가 작업한 channel_id 세대에만 반영. */
export function channelMutationFence(row: {
  game_id: string;
  environment: string;
  channel_id: string;
}): { game_id: string; environment: string; channel_id: string } {
  return {
    game_id: row.game_id,
    environment: row.environment,
    channel_id: row.channel_id,
  };
}

/** p2s 발송 결과 반영 fence — user + 내가 발송한 그 토큰일 때만 env 기록/삭제. */
export function startTokenResultFence(
  userId: string,
  sentToken: string,
): { user_id: string; push_to_start_token: string } {
  return { user_id: userId, push_to_start_token: sentToken };
}
