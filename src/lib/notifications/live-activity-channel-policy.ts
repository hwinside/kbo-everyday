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

const STATUS_PROGRESS: Record<string, number> = { scheduled: 1, live: 2, final: 3 };

/**
 * 직전 발송(lastScoreState) 대비 현재 스냅샷이 "뒤로 감기"인가 (#1311 삼순 B②).
 * Naver-primary fallback 으로 소스가 잠깐 KBO(stale)로 바뀌면 점수/이닝이 후퇴할 수
 * 있는데, broadcast/catch-up 이 그 옛 값을 덮어 카드가 8→5로 되감기는 P0 을 막는다.
 * 경기 진행은 단조(점수·이닝·상태는 증가만) — 후퇴는 소스 불일치의 신호. 주자·볼카운트는
 * 정상적으로 양방향 변하므로 판정에서 제외한다(scoreStateOf 측 0·1·2·3·7만 사용).
 */
export function isScoreStateRetreat(
  lastScoreState: string | null,
  scoreState: string,
): boolean {
  if (lastScoreState === null) return false;
  const prev = lastScoreState.split("|");
  const next = scoreState.split("|");
  if (prev.length < 8 || next.length < 8) return false;
  const pAway = Number(prev[0]);
  const pHome = Number(prev[1]);
  const pInn = Number(prev[2]);
  const nAway = Number(next[0]);
  const nHome = Number(next[1]);
  const nInn = Number(next[2]);
  if ([pAway, pHome, pInn, nAway, nHome, nInn].some((v) => !Number.isFinite(v))) {
    return false; // 파싱 불가 → 오탐 방지(후퇴 아님으로)
  }
  const pStatus = STATUS_PROGRESS[prev[7]] ?? 0;
  const nStatus = STATUS_PROGRESS[next[7]] ?? 0;
  // 알려진 상태(scheduled/live/final)끼리만 판정 — 취소/기타는 개입 안 함.
  if (pStatus === 0 || nStatus === 0) return false;
  // 점수 후퇴는 이닝과 무관하게 무조건 되감김이다(야구 점수는 단조) — #1311 삼순 B①.
  // 이닝교대 lag 로 KBO fallback 이 half-inning 만 먼저 넘어가면(7말→8초) nRank>pRank 가
  // 되어 rank 동일 구간 검사로는 점수 후퇴(8→5)를 놓친다. rank 이전에 선검사한다.
  if (nAway < pAway || nHome < pHome) return true;
  if (nStatus < pStatus) return true; // final→live, live→scheduled = 후퇴
  if (nStatus > pStatus) return false; // live→final 등 전진
  // 이닝 순위(회*2 + 말이면 1). 초=0, 말=1. 점수가 같을 때의 이닝 후퇴만 남음.
  const pRank = pInn * 2 + (prev[3] === "true" ? 0 : 1);
  const nRank = nInn * 2 + (next[3] === "true" ? 0 : 1);
  if (nRank < pRank) return true; // 이닝 후퇴
  return false; // 이닝 전진·동일 + 점수 비후퇴 → 후퇴 아님
}

/** 채널 update 최종 판정 입력 — base diff + heartbeat + 지명 catch-up 합성. */
export interface ChannelUpdateResolutionInput extends ChannelPushDecisionInput {
  /** 마지막 성공 p10 broadcast 시각(ms). null = 미기록. */
  lastP10AtMs: number | null;
  nowMs: number;
  /** fast-path 유실 catch-up 지명 경기 여부 (forceCurrentStateGameIds). */
  forceCatchup: boolean;
  /**
   * 마지막 *성공* 발송 시각(ms, p10/p5 불문) — p5 코얼레싱 기준. null = 미기록(구 행
   * backfill 전) → 코얼레싱 미적용(기존 동작 유지, fail-open이 아니라 diet 미적용일 뿐).
   */
  lastSendAtMs: number | null;
  /**
   * 마지막 성공 발송 콘텐츠 보존 여부(row.last_content_state 존재) — retreat 중
   * heartbeat 를 "마지막 성공값 재발송"으로 살릴 수 있는지. false 면 기존대로 skip.
   */
  hasLastContent: boolean;
}

/** 스킵 사유 — 관제/원장 로깅용 (삼순 2026-08-27 게이트 ⓐ). */
export type ChannelSkipReason = "retreat" | "p5_coalesced" | "no_change";

export interface ChannelUpdateResolution {
  decision: ChannelPushDecision;
  /** heartbeat 승격 발송(관제 카운터용 — forced catch-up 아님). */
  isHeartbeat: boolean;
  /** 지명 catch-up으로 p10 승격된 발송(관제 catchups 카운터용). */
  isForcedCatchup: boolean;
  /** send=false 일 때의 사유. send=true 면 undefined. */
  skipReason?: ChannelSkipReason;
  /**
   * true = 현재 스냅샷 대신 *마지막 성공 발송 콘텐츠*(row.last_content_state)를 p10
   * 재발송하라(retreat 중 heartbeat 복구 — 삼순 2026-08-27 조건①). 후퇴 스냅샷을 보내는
   * 게 아니라 이미 성공한 더 높은 값을 재전송하므로 되감김이 아니다. 유실 단말 복구용.
   */
  resendLastContent: boolean;
}

/**
 * p5(볼카운트/타자/lastPlay-only 변화) 코얼레싱 간격 — 마지막 성공 발송 후 이 간격이
 * 지나기 전의 p5 는 스킵한다(발사율 다이어트, 삼순 2026-08-27 조건②).
 * 트레이드오프(명시): 볼카운트-only 변화의 카드 반영 지연 상한이 기존 ~20s(서브틱)에서
 * 최대 60s+서브틱 = ~80s 로 늘어난다. 점수/이닝/주자/상태(p10)·heartbeat·지명 catch-up
 * 은 코얼레싱 대상이 아니라 즉시성 그대로다.
 */
export const P5_COALESCE_MS = 60 * 1000;

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
  // 되감기 가드(#1311 삼순 Blocker②): 직전 발송보다 점수/이닝/상태가 뒤로 가는
  // 스냅샷은 broadcast·지명 catch-up 모두 스킵한다. Naver-primary 소스가 한 틱 실패해
  // KBO(stale)로 fallback 되면 카드가 8→5로 되감을 수 있는데(forced catch-up 은 hash-skip
  // 을 우회해 옥 값을 강제로 덮음), 경기 진행은 단조라 후퇴 = 소스 불일치 신호다.
  // ⚠️ P1 트레이드오프(삼순 명시): 후퇴 지속 중에는 2분 heartbeat 도 같이 스킵된다.
  // 이는 의도된 것 — 후퇴 스냅샷을 heartbeat 로 보내면 그게 곧 되감기다. 카드는 마지막
  // 성공발송(더 높은 값)에 머물고, Naver 회복·실제 전진(점수 ↑) 시 갱신된다. 유실 단말은
  // 다음 실제 변화에서 복구(이미 높은 값을 1회 성공발송한 뒤 후퇴 구간에 진입한 것).
  if (isScoreStateRetreat(i.lastScoreState, i.scoreState)) {
    // retreat 중 heartbeat 복구(삼순 2026-08-27 조건①): 후퇴 지속이 heartbeat 간격을
    // 넘기면 *마지막 성공 발송 콘텐츠*를 p10 재발송해 "카드 수 분 정지"의 안전망을 건다.
    // 후퇴 스냅샷 전송이 아니므로 되감김 없음. 보존 콘텐츠가 없으면(구 행) 기존대로 skip.
    const heartbeatDue =
      i.lastP10AtMs === null || i.nowMs - i.lastP10AtMs >= CHANNEL_HEARTBEAT_INTERVAL_MS;
    if (heartbeatDue && i.hasLastContent) {
      return {
        decision: { send: true, priority: "10" },
        isHeartbeat: true,
        isForcedCatchup: false,
        resendLastContent: true,
      };
    }
    return {
      decision: { send: false },
      isHeartbeat: false,
      isForcedCatchup: false,
      skipReason: "retreat",
      resendLastContent: false,
    };
  }
  const base = decideChannelPush(i);
  const heartbeat = applyChannelHeartbeat(base, i.lastP10AtMs, i.nowMs);
  const naturalP10 = heartbeat.send && heartbeat.priority === "10";
  const isForcedCatchup = i.forceCatchup && !naturalP10;
  let decision: ChannelPushDecision = isForcedCatchup
    ? { send: true, priority: "10" }
    : heartbeat;
  let skipReason: ChannelSkipReason | undefined;
  // p5 코얼레싱(삼순 2026-08-27 조건②): heartbeat 승격도 catch-up 승격도 아닌 순수 p5
  // (볼카운트/타자/lastPlay-only 변화)는 마지막 성공 발송 후 P5_COALESCE_MS 이내면 스킵.
  // last_send_at 미기록(구 행)은 코얼레싱 미적용 — diet 는 opt-in 관측 후 좁힌다.
  if (
    decision.send &&
    decision.priority === "5" &&
    i.lastSendAtMs !== null &&
    i.nowMs - i.lastSendAtMs < P5_COALESCE_MS
  ) {
    decision = { send: false };
    skipReason = "p5_coalesced";
  }
  if (!decision.send && skipReason === undefined) skipReason = "no_change";
  const isHeartbeat = naturalP10 && !(base.send && base.priority === "10");
  return { decision, isHeartbeat, isForcedCatchup, skipReason, resendLastContent: false };
}

/** 레거시 per-토큰 update 발송 판정 입력 (#664 catch-up). */
export interface LegacyTokenUpdateInput {
  /** 경기 단위 skip/priority 판정(decideChannelPush 결과). null = 판정 재료 없음. */
  decision: ChannelPushDecision | null;
  /** 되감김 스냅샷 여부(#1311 삼순 B②) — true 면 catch-up 보다 우선해 무조건 skip. */
  isRetreat?: boolean;
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
  // 되감김은 catch-up(늦은 토큰/bootstrap)보다 우선한다 — 후퇴 스냅샷은 어떤 경로로도 발송하지
  // 않는다(#1311 삼순 B①: broadcast forceCatchup 우회와 동일 클래스, 여기선 catch-up 이 못 뚫게).
  if (input.isRetreat === true) return { send: false };
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
 * 불변식: 발송 host env == 포함 channelId env (교차 쌍 금지 — 쌍은 호출부가 이 순서로 구성).
 * channel-capable 토큰의 채널 부재 처리(레거시 발송 금지·유보)는 p2sSendPlan이 담당한다
 * (PR #808 R3 — 종전 "채널 없으면 그 attempt는 채널 없이 발송" 규칙 폐기).
 */
export function p2sEnvAttempts(knownEnv: ApnsEnvironment | null): ApnsEnvironment[] {
  return knownEnv === null ? ["production", "sandbox"] : [knownEnv];
}

/**
 * p2s 발송 계획 (PR #808 R3, 삼순 blocker① — 서버 자동 시작 경로의 레거시 fallback 차단).
 *
 * channel-capable(iOS18+/build16+) 토큰은 *active 채널이 준비된 env로만* 발송한다:
 * - 준비된 env가 하나도 없으면 `defer` — 선점(claim)도 발송도 하지 않고 다음 틱이
 *   재시도한다. 7/23 사고 입구(채널이 늦게 생긴 날, 자동 p2s가 채널 payload 없이 레거시
 *   카드를 낳아 예산 스로틀에 갇힘)의 서버측 차단. 앱 내 start()의 deferStart와 대칭.
 * - 준비된 env가 일부면 그 env로만 attempt(`truncated` 표시). env 미상(null) 토큰이
 *   prod-only 채널에서 BadDeviceToken을 받으면 "sandbox 토큰인데 sandbox 채널이 아직
 *   없다"일 수 있으므로, truncated의 마지막 BadDeviceToken은 토큰 무효 확정이 아니다 —
 *   호출부는 삭제 대신 선점 해제(다음 틱 재시도)로 처리한다.
 * 레거시 토큰(iOS17↓/build15↓/미보고)은 기존 그대로 — 채널 payload 없이 전체 attempt.
 */
export type P2sSendPlan =
  | { kind: "defer" }
  | { kind: "send"; attempts: ApnsEnvironment[]; channelRequired: boolean; truncated: boolean };

export function p2sSendPlan(
  token: { os_major: number | null; app_build: number | null; env: ApnsEnvironment | null },
  channelEnvs: ReadonlySet<ApnsEnvironment>,
): P2sSendPlan {
  const attempts = p2sEnvAttempts(token.env);
  if (!p2sChannelEligible(token)) {
    return { kind: "send", attempts, channelRequired: false, truncated: false };
  }
  const withChannel = attempts.filter((e) => channelEnvs.has(e));
  if (withChannel.length === 0) return { kind: "defer" };
  return {
    kind: "send",
    attempts: withChannel,
    channelRequired: true,
    truncated: withChannel.length < attempts.length,
  };
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

/** started row에 기록된 채널 출생 세대 — p2s 발송 성공 시점의 (environment, channel_id). */
export interface ChannelBornRef {
  game_id: string;
  channel_born_environment: string | null;
  channel_born_channel_id: string | null;
}

/**
 * 채널 출생 세대 유효성 — 기록된 (game_id, environment, channel_id)가 *현재 active
 * 채널과 정확 일치*할 때만 broadcast 수신으로 인정(삼순 라운드2 blocker). 채널 A로
 * 태어난 카드는 A가 ChannelNotRegistered로 무효화되고 B로 재생성되면 B broadcast를
 * 못 받으므로, 세대 불일치(구채널) 행은 gap/wake 대상으로 복귀해야 한다. 이후 update
 * 토큰 또는 새 채널 ACK가 생기면 기존 로직(토큰∪유효 ACK)이 다시 제외한다.
 * null(마이그레이션 이전 행 = 세대 미기록)은 보수적으로 불인정(gap 포함).
 * 어드민 updatable 합산과 wake 제외 판정이 *모두 이 함수 하나*를 기준으로 삼는다
 * (이중 기준 금지 계약).
 */
export function isLiveBornChannel(row: ChannelBornRef, activeKeys: Set<string>): boolean {
  if (!row.channel_born_environment || !row.channel_born_channel_id) return false;
  return activeKeys.has(
    `${row.game_id}|${row.channel_born_environment}|${row.channel_born_channel_id}`,
  );
}

/**
 * '갱신 수신(updatable)' 유저 수 — started ∩ (update토큰 ∪ 유효 채널ACK ∪ 유효 채널출생).
 * 채널출생(p2s payload에 channelId 내장 발송 성공 서버 기록)은 네이티브 ACK가 아직/영영
 * 안 와도 broadcast로 갱신을 받으므로 updatable — ACK만 인정하면 gap 과대계상(2026-07-23
 * 실측). ⚠️ channelBornUsers는 반드시 isLiveBornChannel(세대 일치) 통과 유저만 담아야
 * 한다 — 출생 채널이 재생성으로 교체된 행을 그대로 세면 갱신 못 받는 카드를 수신으로
 * 오인한다(삼순 라운드2 blocker). 과거 행은 세대 기록이 없어(backfill 불가) 종전과 동일 집계.
 */
export function countUpdatableUsers(i: {
  started: Iterable<string>;
  tokenUsers: Set<string>;
  channelAckUsers: Set<string>;
  channelBornUsers: Set<string>;
}): number {
  let n = 0;
  for (const u of i.started) {
    if (i.tokenUsers.has(u) || i.channelAckUsers.has(u) || i.channelBornUsers.has(u)) n += 1;
  }
  return n;
}

// ── 무음 wake 대상 선별 (③ wake 오염 제거, 삼순 재리뷰 2026-07-23) ──────
// 유효 채널출생 카드는 broadcast로 갱신을 받아 wake가 불필요한데, 이를 wake 대상에
// 넣으면 FCM 무음 wake가 낭비될 뿐 아니라 wake_attempted_at이 기록돼 어드민의
// wake 구제 성공률 분모가 오염된다(시도할 필요가 없던 카드가 분모에 섞임).
// gap 판정과 attempted 기록이 같은 행 집합에서 나오도록 순수 함수로 고정한다.

export interface WakeGapRow extends ChannelBornRef {
  user_id: string;
  game_id: string;
  created_at: string | null;
}

/**
 * 무음 wake 대상 gap 행 선별 — wake 발송 대상과 wake_attempted_at 기록이 모두
 * 이 반환값에서만 파생돼야 한다(분모 오염 방지 계약).
 * - 유효 채널출생 행 제외(isLiveBornChannel — 어드민 updatable 합산과 동일 기준):
 *   출생 채널이 지금도 active면 토큰/ACK 없이도 broadcast 수신 — wake 불필요·attempted
 *   기록 금지. 출생 채널이 교체됐으면(세대 불일치) gap으로 복귀 = wake 대상(삼순 라운드2).
 * - updatableKeys(`user|game` — update 토큰 or 유효 채널 ACK) 보유 행 제외.
 * - scheduled 경기 행은 카드 발급(created_at) 후 wakeWindowMs 이내만(그 뒤는 live 전환 창이 백스톱).
 */
export function selectWakeGapRows<T extends WakeGapRow>(
  rows: T[],
  updatableKeys: Set<string>,
  activeChannelKeys: Set<string>,
  scheduledGameIds: Set<string>,
  nowMs: number,
  wakeWindowMs: number,
): T[] {
  return rows.filter((r) => {
    if (isLiveBornChannel(r, activeChannelKeys)) return false;
    if (updatableKeys.has(`${r.user_id}|${r.game_id}`)) return false;
    if (scheduledGameIds.has(r.game_id)) {
      return r.created_at !== null && nowMs - new Date(r.created_at).getTime() <= wakeWindowMs;
    }
    return true;
  });
}

// ── 무음 wake 창 오픈 판정 (삼순 라운드3: 채널 세대 기준 재오픈) ──────────

/**
 * 무음 wake 창 오픈 여부 — live 전환/취소·종료 이벤트 시각 기준 windowMs 창에 더해,
 * *해당 게임의 현재 active 채널 세대가 생성/변경된 시각*(live_activity_channels.created_at
 * — 재생성 CAS 경로가 새 시각으로 다시 기록) 기준으로도 창을 재오픈한다(삼순 라운드3
 * blocker): 라이브 도중 채널이 늦게 생성되거나 A→B로 교체되면 *그 시점 이후에야*
 * 구채널/레거시 카드가 gap으로 복귀하는데, 이벤트 창(live 전환+20분)만 보면 이미 닫혀
 * wake 자동구제가 불가능하다(2026-07-23 실사례: 19:07 시작 경기의 늦은 채널 생성).
 * - eventSinceMs undefined(이벤트 row 없음 = 막 발생/알림 경로 이슈) → 오픈(기존 안전 동작).
 * - 채널 변경 없이 두 창 모두 지난 경우 → 기존대로 마감(스팸/throttle 방지 유지).
 */
export function isWakeWindowOpen(
  nowMs: number,
  eventSinceMs: number | undefined,
  channelGenerationMs: number | undefined,
  windowMs: number,
): boolean {
  if (eventSinceMs === undefined) return true;
  if (nowMs - eventSinceMs <= windowMs) return true;
  return channelGenerationMs !== undefined && nowMs - channelGenerationMs <= windowMs;
}

// ── p2s stale 토큰 발송 제외 ─────────────────────────────────────────
// gap 유저 41%가 updated_at 1~30일+ 미갱신 휴면 기기(2026-07-23 실측) — 앱을 오래 안 연
// 기기는 p2s로 카드가 떠도 update 토큰 등록(wake/앱 오픈)이 사실상 안 일어나 갱신불가
// 카드만 늘린다. 30일+ 미갱신 토큰은 발송 대상에서 제외한다(토큰 삭제는 아님 — 앱을
// 다시 열어 updated_at이 갱신되면 즉시 발송 재개).
export const STALE_START_TOKEN_MS = 30 * 24 * 60 * 60 * 1000;

/** p2s 토큰 stale 판정 — updated_at 30일+ 경과. null/파싱 불가는 stale 아님(발송 유지, 보수적). */
export function isStaleStartToken(updatedAt: string | null, nowMs: number): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > STALE_START_TOKEN_MS;
}

// ── 채널 출생 세대 마킹 — 재시도/부분실패 격리 (2026-07-24 사고 견고화) ──────
//
// 20260724WOHT0(최대 배치 경기, 18:01 피크): 발송 성공 2,017 중 channel_born 마킹이
// 177(9%)만 기록 — 배치 update 실패(에러 무시)로 조용히 소실. 마킹 소실 = 어드민
// '갱신 불가' 과대계상 + wake 대상 오포함. 이 헬퍼가 계약을 강제한다:
//   ① 배치 실패 시 지수 백오프 재시도(최대 2회 — 과설계 금지)
//   ② 최종 실패는 경기ID·env/채널·배치 인덱스·건수 포함 명시 로깅(조용한 소실 금지)
//   ③ 한 배치가 실패해도 나머지 배치는 계속 진행(부분실패 격리)
//   ④ retryDeadlineMs 경과 후엔 새 marking operation을 *시작 자체를 안 함*(첫 시도 포함
//      즉시 skip+실패 집계) — deadline 후 첫 UPDATE들이 직렬로 8s statement timeout을
//      기다리며 뒤 chunk를 굶기는 경로 차단(삼순 R2 blocker starvation 방지). 시작하는
//      UPDATE도 남은 예산으로 AbortSignal.timeout 유계화 — 전체 marking wall-clock 상한
//      = 예산(+백오프 sleep ≤1.5s). 마킹 skip은 발송을 막지 않는다(발송·선점 계약 불변,
//      실패분은 로깅 집계 후 backfill-channel-born.ts로 구제).
// updateBatch 주입으로 유닛 스모크에서 직접 검증한다(qa:la-born-marking).

/** p2s 발송 성공 유저의 채널 출생 그룹 — (env, channelId)별 user 목록. */
export interface ChannelBornGroup {
  env: ApnsEnvironment;
  channelId: string;
  users: string[];
}

export const CHANNEL_BORN_BATCH_SIZE = 200;
/** 배치당 최대 시도 횟수(최초 1 + 재시도 2). */
export const CHANNEL_BORN_MAX_ATTEMPTS = 3;
/** 재시도 백오프(ms) — attempt 1 실패 후 500, attempt 2 실패 후 1000. */
export const CHANNEL_BORN_RETRY_BASE_MS = 500;
/** start fanout 전체에서 실제 channel_born 마킹 대기에 쓸 수 있는 총 예산(ms). */
export const CHANNEL_BORN_RETRY_BUDGET_MS = 20_000;

export interface ChannelBornMarkBudget {
  remainingMs: number;
}

export function createChannelBornMarkBudget(
  totalMs = CHANNEL_BORN_RETRY_BUDGET_MS,
): ChannelBornMarkBudget {
  return { remainingMs: Math.max(0, totalMs) };
}

/**
 * APNs/쿼리 시간은 제외하고 실제 마킹 작업의 wall-clock만 전역 예산에서 차감한다.
 * 호출부는 순차 실행 계약(start chunk persist)을 지키므로 별도 동시성 잠금은 불필요하다.
 */
export async function runWithChannelBornMarkBudget<T>(
  budget: ChannelBornMarkBudget,
  task: (retryDeadlineMs: number) => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  const startedAt = now();
  const retryDeadlineMs = startedAt + budget.remainingMs;
  try {
    return await task(retryDeadlineMs);
  } finally {
    const elapsedMs = Math.max(0, now() - startedAt);
    budget.remainingMs = Math.max(0, budget.remainingMs - elapsedMs);
  }
}

export async function markChannelBornGroups(params: {
  gameId: string;
  groups: Iterable<ChannelBornGroup>;
  /**
   * 배치 1건 DB 반영 — supabase update 결과({ error })를 그대로 반환. throw도 실패로 취급.
   * opts.signal이 있으면 남은 예산으로 유계화된 AbortSignal — 실배선은 .abortSignal()로 전달.
   */
  updateBatch: (
    group: ChannelBornGroup,
    userIds: string[],
    opts: { signal?: AbortSignal },
  ) => PromiseLike<{ error: { message: string } | null }>;
  logError?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** 절대 시각(ms). 경과 후엔 새 UPDATE 시작 금지(첫 시도 포함 skip) + 진행 중 UPDATE도 남은 예산으로 abort. */
  retryDeadlineMs?: number;
  now?: () => number;
}): Promise<{ batches: number; failedBatches: number; failedUsers: number }> {
  const logError = params.logError ?? ((msg) => console.error(msg));
  const sleep = params.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = params.now ?? (() => Date.now());
  const retryDeadlineMs = params.retryDeadlineMs ?? Number.POSITIVE_INFINITY;
  let batches = 0;
  let failedBatches = 0;
  let failedUsers = 0;
  for (const group of params.groups) {
    for (let i = 0; i < group.users.length; i += CHANNEL_BORN_BATCH_SIZE) {
      const slice = group.users.slice(i, i + CHANNEL_BORN_BATCH_SIZE);
      const batchIndex = Math.floor(i / CHANNEL_BORN_BATCH_SIZE);
      batches += 1;
      let lastError = "unknown";
      let ok = false;
      let attempts = 0;
      for (let attempt = 1; attempt <= CHANNEL_BORN_MAX_ATTEMPTS; attempt++) {
        // deadline 경과 후엔 새 marking operation을 *시작하지 않는다*(첫 시도 포함) —
        // deadline 뒤 첫 UPDATE들이 직렬 8s timeout을 기다리며 뒤 배치/chunk를 굶기는
        // 경로 차단(삼순 R2). skip된 배치는 실패로 집계·로깅 → backfill로 구제.
        const remainingMs = retryDeadlineMs - now();
        if (remainingMs <= 0) {
          if (attempts === 0) lastError = "marking deadline exceeded (batch skipped)";
          break;
        }
        attempts = attempt;
        try {
          // 시작하는 UPDATE도 남은 예산으로 유계화 — 8s statement timeout이 예산을
          // 초과 잠식하지 않게(실배선은 supabase .abortSignal()로 전달).
          const signal = Number.isFinite(retryDeadlineMs)
            ? AbortSignal.timeout(Math.ceil(remainingMs))
            : undefined;
          const { error } = await params.updateBatch(group, slice, { signal });
          if (!error) {
            ok = true;
            break;
          }
          lastError = error.message;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
        // 재시도 예산 소진 → 즉시 다음 배치로(굶김 방지 ④).
        if (now() >= retryDeadlineMs) break;
        if (attempt < CHANNEL_BORN_MAX_ATTEMPTS) {
          await sleep(
            Math.min(CHANNEL_BORN_RETRY_BASE_MS * 2 ** (attempt - 1), retryDeadlineMs - now()),
          );
        }
      }
      if (!ok) {
        failedBatches += 1;
        failedUsers += slice.length;
        logError(
          `[live-activity] channel_born marking failed: game=${params.gameId} ` +
            `env=${group.env} channel=${group.channelId} batch=${batchIndex} ` +
            `users=${slice.length} attempts=${attempts} error=${lastError}`,
        );
      }
    }
  }
  return { batches, failedBatches, failedUsers };
}

// ── start fanout 유계 chunk + chunk당 즉시 내구 저장 (삼순 R1 blocker②) ──────────
//
// 18:02 실측: away 147명은 138 마킹, 직후 home 1,827명은 0 — 1,827건 APNs Promise.all
// 뒤 tail에서만 마킹하다 fanout 68s deadline/함수 종료에 잘리면 재시도·로그 0으로
// 전량 소실된다. 발송을 유계 chunk로 나누고 *다음 chunk 발송 시작 전에* 직전 chunk의
// 마킹을 내구 저장한다 — 도중 cutoff되어도 이미 보낸 chunk의 마킹은 잔존(손실 상한 =
// 마지막 미완료 chunk 1개). 순서 불변식(persist(k) → send(k+1))을 스모크가 검증한다.

/** start p2s 발송 chunk 크기 — chunk당 APNs 동시 발송 + 마킹 1배치(≤200) 내구 저장. */
export const START_SEND_CHUNK_SIZE = 100;

export async function runStartSendChunks<T>(params: {
  items: readonly T[];
  chunkSize: number;
  /** 항목 1건 발송 — 실패는 내부에서 집계(throw 금지 계약, 실배선은 자체 catch). */
  sendOne: (item: T) => Promise<void>;
  /** 직전 chunk 성공분 내구 저장 — 다음 chunk 발송 시작 전에 반드시 완료. */
  persistChunk: () => Promise<void>;
}): Promise<void> {
  for (let i = 0; i < params.items.length; i += params.chunkSize) {
    await Promise.all(params.items.slice(i, i + params.chunkSize).map(params.sendOne));
    await params.persistChunk();
  }
}
