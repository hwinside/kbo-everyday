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

// ── 채널 broadcast heartbeat/catch-up (삼순 5조건 ②) ──
//
// 채널 broadcast는 No-Message-Stored + apns-expiration: 0 — accepted push 1건을 단말이
// 놓치면(무선 순단·재연결) 무변화 스킵 정책상 다음 상태 변화까지 stale이 3분을 넘을 수
// 있다. 마지막 *성공* p10 broadcast 이후 CHANNEL_HEARTBEAT_INTERVAL_MS가 지나면 스킵/p5
// 틱이어도 p10 current-state로 재발송해 stale 상한을 건다.
//
// ⚠️ 이것은 **server-attempt SLO**다(온라인·LA 허용·채널 구독 단말 기준 ≤2분 간격 p10
// 재발송 *시도*). APNs는 최종 전달을 보장하지 않으므로 절대 전달 SLA는 구조적으로 불가.
// last_p10_at은 APNs 성공 시에만 전진(transient 실패 시 전진 금지) + channelMutationFence
// 일치 시에만 기록(동시 cron/재생성 채널 보호) — 배선은 live-activity-channels.ts.

export const CHANNEL_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

/**
 * 무변화 스킵/p5 판정을 heartbeat 기준으로 승격한다.
 * - 이미 p10 발송 판정이면 그대로(자연 p10이 heartbeat 역할 겸함 — 성공 시 last_p10_at 전진).
 * - last_p10_at이 null(신규 채널/마이그레이션 backfill)이거나 ≥interval 경과했으면
 *   스킵/p5여도 p10 current-state 재발송(놓친 단말 catch-up).
 * - interval 미만이면 원래 판정 유지(p5는 p5로, 스킵은 스킵).
 */
export function applyChannelHeartbeat(
  decision: ChannelPushDecision,
  lastP10AtMs: number | null,
  nowMs: number,
): ChannelPushDecision {
  if (decision.send && decision.priority === "10") return decision;
  if (lastP10AtMs === null || nowMs - lastP10AtMs >= CHANNEL_HEARTBEAT_INTERVAL_MS) {
    return { send: true, priority: "10" };
  }
  return decision;
}

/** 채널 update 최종 판정 입력 — base diff + heartbeat + 지명 catch-up 합성. */
export interface ChannelUpdateResolutionInput extends ChannelPushDecisionInput {
  /** 마지막 성공 p10 broadcast 시각(ms). null = 미기록. */
  lastP10AtMs: number | null;
  nowMs: number;
  /** fast-path 유실 catch-up 지명 경기 여부 (forceCurrentStateGameIds). */
  forceCatchup: boolean;
}

export interface ChannelUpdateResolution {
  decision: ChannelPushDecision;
  /** heartbeat 승격 발송(관제 카운터용 — forced catch-up 아님). */
  isHeartbeat: boolean;
  /** 지명 catch-up으로 p10 승격된 발송(관제 catchups 카운터용). */
  isForcedCatchup: boolean;
}

/**
 * 채널 update 최종 판정 — base diff → heartbeat → 지명 catch-up 순 합성 (순수 함수,
 * 배선은 live-activity-channels.ts).
 *
 * 지명 catch-up(삼순 R2 blocker③): fast-path가 유실 복구로 지명한 경기는 *자연 p10이
 * 아닌 한* 항상 p10으로 승격한다. 기존(R1)에는 `!heartbeatDecision.send`일 때만 승격해,
 * relay lastPlay만 달라진 base=p5 틱에서 catch-up이 p5로 나가고 pending은 이미 비워져
 * 다음 p10 재시도도 없이 2분 heartbeat까지 stale로 남았다. p5는 예산 미소모라 놓친
 * 단말을 복구하지 못하므로 catch-up 목적상 반드시 p10이어야 한다. 자연 p10(변화/
 * heartbeat)이면 그 발송이 catch-up을 겸한다(성공 시 last_p10_at 전진 — 이중 승격 불필요).
 */
export function resolveChannelUpdateDecision(
  i: ChannelUpdateResolutionInput,
): ChannelUpdateResolution {
  const base = decideChannelPush(i);
  const heartbeat = applyChannelHeartbeat(base, i.lastP10AtMs, i.nowMs);
  const naturalP10 = heartbeat.send && heartbeat.priority === "10";
  const isForcedCatchup = i.forceCatchup && !naturalP10;
  const decision: ChannelPushDecision = isForcedCatchup
    ? { send: true, priority: "10" }
    : heartbeat;
  const isHeartbeat = naturalP10 && !(base.send && base.priority === "10");
  return { decision, isHeartbeat, isForcedCatchup };
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
 *
 * bootstrap gap (#664 재리뷰 blocker): cursor(lastWriteAtMs)가 null인 동안 채널 행 기반
 * decision이 skip이면 발송 0 → 성공 틱이 없어 cursor가 영영 안 생기고, 그 사이 등록된
 * 늦은 토큰은 catch-up 판정 자체가 불가(비교 기준 부재)라 다음 상태 변화까지 계속 굶는다.
 * → lastWriteAtMs=null은 "bootstrap 미완료"로 보고 skip/p5여도 p10 1회 발송한다.
 * 성공 시 발송 루프가 cursor를 생성(sentUpdateGames upsert)해 다음 틱부터 자연 해제 —
 * 과다 발송은 경기당 bootstrap 틱 1회로 유계(cursor 생성 전 = 기존 매분 p10과 동일 동작).
 */
export function decideLegacyTokenUpdate(input: LegacyTokenUpdateInput): LegacyTokenUpdateDecision {
  const isCatchUp =
    input.lastWriteAtMs === null
      // bootstrap 미완료 — 비교 기준(cursor)이 없어 늦은 토큰을 구분할 수 없다. 전 토큰
      // p10 1회로 현재 프레임 보장 + 성공 틱이 cursor를 만들어 다음 틱부터 정상 판정.
      ? true
      : input.tokenUpdatedAtMs !== null && input.tokenUpdatedAtMs >= input.lastWriteAtMs;
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

/** 경기 단위 폴백 커서(live_activity_game_push_state.updated_at) 전진 판정 입력. */
export type UpdateAttemptOutcome = "sent" | "invalidToken" | "retryableFailure";

/**
 * 폴백 커서 전진 여부 (#665 재리뷰 NO-GO — mixed-result 영구 누락).
 *
 * 같은 경기에서 토큰 A가 APNs 일시 오류(429/5xx 등, invalidToken=false)로 실패하고
 * 토큰 B가 성공하면, 커서가 전진해 다음 틱 A의 tokenUpdatedAtMs < lastWriteAtMs가 되어
 * decideLegacyTokenUpdate가 isCatchUp=false로 판정 — A는 재시도 없이 skip이 굳어져
 * "경기 예정" 프레임에 영구 고착된다. retryable 실패가 하나라도 있으면 커서를 보류해
 * 다음 틱도 그 경기의 전 토큰을 catch-up(p10) 대상으로 남긴다(과다 발송은 그 경기 한정,
 * retryable 실패가 해소될 때까지만).
 *
 * invalidToken은 이번 틱에 즉시 정리(live-activity.ts) 대상이라 무시해도 안전 — 다음
 * 틱엔 그 토큰 행 자체가 없다.
 */
export function shouldAdvanceFallbackCursor(outcomes: UpdateAttemptOutcome[]): boolean {
  return !outcomes.includes("retryableFailure");
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

// ── 어드민 대시보드 집계 (갱신 수신/불가) ─────────────────────────────
// 채널 구독은 broadcast로 갱신을 받으므로 update 토큰과 합쳐 '갱신 수신'으로 세야
// 하지만, 채널 재생성/정리 후 남은 stale ACK 행을 그대로 세면 이미 갱신을 못 받는
// 카드를 '수신'으로 오인한다(삼순 NO-GO). 따라서 *현재 active 채널의
// (environment, channel_id)와 정확히 일치*하는 구독만 인정한다 — 실제 발송·wake
// 경로가 채널을 매칭하는 방식과 동일.

export interface ActiveChannelRef {
  game_id: string;
  environment: string;
  channel_id: string;
}

export interface SubscriptionRef {
  game_id: string;
  environment: string;
  channel_id: string;
  user_id: string | null;
  device_key: string;
}

/** active 채널 (game_id|environment|channel_id) 키 집합. */
export function activeChannelKeySet(channels: ActiveChannelRef[]): Set<string> {
  const s = new Set<string>();
  for (const c of channels) s.add(`${c.game_id}|${c.environment}|${c.channel_id}`);
  return s;
}

/**
 * 유효 채널 구독만 통과 — active 채널의 (game_id, environment, channel_id) 정확
 * 일치 행만 인정. stale ACK(채널 재생성으로 옛 channel_id를 든 행, 또는 채널이
 * 이미 정리돼 active가 없는 경기의 행)는 제외.
 */
export function isLiveChannelSubscription(
  sub: SubscriptionRef,
  activeKeys: Set<string>,
): boolean {
  return activeKeys.has(`${sub.game_id}|${sub.environment}|${sub.channel_id}`);
}
