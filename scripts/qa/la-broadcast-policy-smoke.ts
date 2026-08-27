/**
 * Broadcast 채널 전환 — 정책 순수 함수 스모크 (스펙 v4).
 * 실행: npx tsx scripts/qa/la-broadcast-policy-smoke.ts  (npm run qa:la-broadcast)
 */
import {
  decideChannelPush,
  scoreStateOf,
  fullStateHashOf,
  p2sChannelEligible,
  p2sEnvAttempts,
  p2sSendPlan,
  endRetryDelayMinutes,
  startTokenEnvPatch,
  channelMutationFence,
  startTokenResultFence,
  decideLegacyTokenUpdate,
  decideStartReissue,
  startTokenChangePatch,
  shouldAdvanceFallbackCursor,
  applyChannelHeartbeat,
  isBallStrikeOnlyChange,
  resolveChannelUpdateDecision,
  CHANNEL_HEARTBEAT_INTERVAL_MS,
  activeChannelKeySet,
  isLiveChannelSubscription,
  isLiveBornChannel,
  countUpdatableUsers,
  isStaleStartToken,
  STALE_START_TOKEN_MS,
  isWakeWindowOpen,
  selectWakeGapRows,
} from "../../src/lib/notifications/live-activity-channel-policy";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

const baseCs = {
  awayScore: 4, homeScore: 1, inning: 8, isTopInning: false,
  balls: 1, strikes: 2, outs: 2,
  onFirst: true, onSecond: false, onThird: false,
  pitcherName: "스기모토", batterName: "박동원", stadium: "잠실", status: "live",
};

// ── decideChannelPush ──
// 첫 틱(직전 상태 없음) = priority 10
check("first tick → 10", decideChannelPush({
  scoreState: scoreStateOf(baseCs), fullStateHash: fullStateHashOf(baseCs),
  lastScoreState: null, lastStateHash: null,
}), { send: true, priority: "10" });

// 점수 변화 = 10
const scored = { ...baseCs, homeScore: 2 };
check("score change → 10", decideChannelPush({
  scoreState: scoreStateOf(scored), fullStateHash: fullStateHashOf(scored),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "10" });

// 이닝 전환 = 10
const nextInning = { ...baseCs, inning: 9, isTopInning: true };
check("inning change → 10", decideChannelPush({
  scoreState: scoreStateOf(nextInning), fullStateHash: fullStateHashOf(nextInning),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "10" });

// 주자 변화 = 10
const runner = { ...baseCs, onSecond: true };
check("runner change → 10", decideChannelPush({
  scoreState: scoreStateOf(runner), fullStateHash: fullStateHashOf(runner),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "10" });

// 볼카운트만 변화 = 5
const ballOnly = { ...baseCs, balls: 2 };
check("ball-count only → 5", decideChannelPush({
  scoreState: scoreStateOf(ballOnly), fullStateHash: fullStateHashOf(ballOnly),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "5" });

// 타자 교체만 = 5
const newBatter = { ...baseCs, batterName: "오지환", balls: 0, strikes: 0 };
check("batter only → 5", decideChannelPush({
  scoreState: scoreStateOf(newBatter), fullStateHash: fullStateHashOf(newBatter),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "5" });

// lastPlay만 변화 = 5
const withPlay = { ...baseCs, lastPlay: "최원준 2루수 땅볼 아웃" };
check("lastPlay only → 5", decideChannelPush({
  scoreState: scoreStateOf(withPlay), fullStateHash: fullStateHashOf(withPlay),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "5" });

// 완전 무변화 = 스킵
check("unchanged → skip", decideChannelPush({
  scoreState: scoreStateOf(baseCs), fullStateHash: fullStateHashOf(baseCs),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: false });

// status 전환(live→final)은 score축 = 10
const finalCs = { ...baseCs, status: "final" };
check("status change → 10", decideChannelPush({
  scoreState: scoreStateOf(finalCs), fullStateHash: fullStateHashOf(finalCs),
  lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
}), { send: true, priority: "10" });

// ── p2sChannelEligible (게이트 = os_major>=18 && app_build>=16, 미보고 = 레거시) ──
check("eligible 18/16", p2sChannelEligible({ os_major: 18, app_build: 16 }), true);
check("eligible 26/17", p2sChannelEligible({ os_major: 26, app_build: 17 }), true);
check("iOS17 → legacy", p2sChannelEligible({ os_major: 17, app_build: 16 }), false);
check("build15 → legacy", p2sChannelEligible({ os_major: 18, app_build: 15 }), false);
check("unreported os → legacy", p2sChannelEligible({ os_major: null, app_build: 16 }), false);
check("unreported build → legacy", p2sChannelEligible({ os_major: 18, app_build: null }), false);
check("both null → legacy", p2sChannelEligible({ os_major: null, app_build: null }), false);

// ── p2sEnvAttempts (known = 그 env만 / null = prod → sandbox) ──
check("env null → prod,sandbox", p2sEnvAttempts(null), ["production", "sandbox"]);
check("env prod → prod only", p2sEnvAttempts("production"), ["production"]);
check("env sandbox → sandbox only", p2sEnvAttempts("sandbox"), ["sandbox"]);

// ── endRetryDelayMinutes (즉시→1m→5m→15m→30m→이후 1h) ──
check("attempt 0 → immediate", endRetryDelayMinutes(0), 0);
check("attempt 1 → +1m", endRetryDelayMinutes(1), 1);
check("attempt 2 → +5m", endRetryDelayMinutes(2), 5);
check("attempt 3 → +15m", endRetryDelayMinutes(3), 15);
check("attempt 4 → +30m", endRetryDelayMinutes(4), 30);
check("attempt 5 → +60m", endRetryDelayMinutes(5), 60);
check("attempt 12 → +60m", endRetryDelayMinutes(12), 60);
// 8h 창 내 총 발송 횟수 = 12회 (즉시,+1,+5,+15,+30 후 1h 간격 — 마지막 471분, 스펙 "~13회" 근사)
{
  let t = 0;
  let count = 0;
  let attempts = 0;
  while (t <= 480) {
    count++;
    attempts++;
    t += endRetryDelayMinutes(attempts);
  }
  check("12 sends in 8h window", count, 12);
}

// ── startTokenEnvPatch (토큰 rotation 시 env 귀속 리셋 — 삼순 #659 blocker③) ──
check("rotation: 신규 등록(기존 없음) → env reset", startTokenEnvPatch(null, "tokA"), {
  apns_environment: null,
});
check("rotation: 동일 토큰 재등록 → env 유지", startTokenEnvPatch("tokA", "tokA"), {});
check("rotation: 토큰 교체 → env reset", startTokenEnvPatch("tokA", "tokB"), {
  apns_environment: null,
});

// ── 동시성 fence 회귀 (삼순 #659 재리뷰 blocker①②) ──
// fence는 SQL WHERE 조건으로 동작한다 — 여기서는 그 predicate 의미를 행 매칭으로 재현해
// "in-flight 결과가 교체된 행을 건드리지 않음"을 회귀 고정한다.
function rowMatches(fence: Record<string, string>, dbRow: Record<string, unknown>): boolean {
  return Object.entries(fence).every(([k, v]) => dbRow[k] === v);
}

// 채널 generation: worker A가 old 채널 작업 중 행이 new 채널로 재생성 → A의 mutation은 no-op
const oldChanRow = { game_id: "20260717KTLG0", environment: "production", channel_id: "chanOLD" };
const recreatedRow = { game_id: "20260717KTLG0", environment: "production", channel_id: "chanNEW", status: "active" };
check(
  "channel fence: stale worker(old) does not touch recreated row(new)",
  rowMatches(channelMutationFence(oldChanRow), recreatedRow),
  false,
);
check(
  "channel fence: same generation still matches",
  rowMatches(channelMutationFence(oldChanRow), { ...recreatedRow, channel_id: "chanOLD" }),
  true,
);

// 대시보드 갱신 수신 집계: 현재 active 채널 세대와 정확히 일치하는 ACK만 인정.
// 채널 재생성 뒤 남은 old ACK가 수신 가능으로 오집계되는 #688 NO-GO 회귀를 봉인한다.
{
  const activeKeys = activeChannelKeySet([
    { game_id: "20260718KTLG0", environment: "production", channel_id: "chanNEW" },
    { game_id: "20260718KTLG0", environment: "sandbox", channel_id: "chanSB" },
  ]);
  const baseSub = {
    game_id: "20260718KTLG0",
    environment: "production",
    channel_id: "chanNEW",
    user_id: "u1",
    device_key: "device1",
  };
  check("dashboard ACK: current active generation → included",
    isLiveChannelSubscription(baseSub, activeKeys), true);
  check("dashboard ACK: recreated channel old ACK → excluded",
    isLiveChannelSubscription({ ...baseSub, channel_id: "chanOLD" }, activeKeys), false);
  check("dashboard ACK: same channel id but wrong environment → excluded",
    isLiveChannelSubscription({ ...baseSub, environment: "sandbox" }, activeKeys), false);
  check("dashboard ACK: no active channel for game → excluded",
    isLiveChannelSubscription({ ...baseSub, game_id: "20260718OBNC0" }, activeKeys), false);
}

// 토큰 rotation: cron이 tokA 발송 중 앱이 tokB 등록(env null 리셋)
//  → A의 늦은 성공(env 기록)도, A의 BadDeviceToken(행 삭제)도 B 행에 적용되면 안 됨.
const rowAfterRotation = { user_id: "u1", push_to_start_token: "tokB", apns_environment: null };
check(
  "rotation fence: in-flight tokA success does not overwrite tokB env",
  rowMatches(startTokenResultFence("u1", "tokA"), rowAfterRotation),
  false,
);
check(
  "rotation fence: in-flight tokA invalid does not delete tokB row",
  rowMatches(startTokenResultFence("u1", "tokA"), rowAfterRotation),
  false,
);
check(
  "rotation fence: un-rotated row still matches (정상 반영 경로 보존)",
  rowMatches(startTokenResultFence("u1", "tokA"), { ...rowAfterRotation, push_to_start_token: "tokA" }),
  true,
);

// ── decideLegacyTokenUpdate — 늦은 토큰 catch-up (#664) ──
// 상태 행은 *틱 시작 시각*으로 기록된다(live-activity.ts tickStartedAtIso) — 아래
// 경계(>=) 테스트들이 그 계약 위에서만 성립한다. 기록을 발송 후 now()로 되돌리면
// "틱 처리 중 등록된 토큰이 catch-up을 영영 놓치는" race가 부활한다.
const T = 1_784_260_000_000; // 기준 시각(ms)
const skipTick = { send: false } as const;
const p5Tick = { send: true, priority: "5" } as const;
const p10Tick = { send: true, priority: "10" } as const;

// 스킵 틱: 직전 기록 이후 등록된 토큰만 p10 catch-up, 나머지는 스킵 유지
check("catch-up: skip tick + late token → p10",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T + 1, lastWriteAtMs: T }),
  { send: true, priority: "10" });
check("catch-up: skip tick + old token → skip",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T - 1, lastWriteAtMs: T }),
  { send: false });
// 경계: 같은 ms 등록(틱 시작과 동시) = catch-up 포함(>=). 틱 처리 중 등록 race 방어.
check("catch-up: boundary token(updated == lastWrite) → p10 (race 방어)",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T, lastWriteAtMs: T }),
  { send: true, priority: "10" });

// p5 틱: 늦은 토큰만 p10 승격, 나머지는 p5 유지
check("catch-up: p5 tick + late token → p10 승격",
  decideLegacyTokenUpdate({ decision: p5Tick, tokenUpdatedAtMs: T + 1, lastWriteAtMs: T }),
  { send: true, priority: "10" });
check("catch-up: p5 tick + old token → p5 유지",
  decideLegacyTokenUpdate({ decision: p5Tick, tokenUpdatedAtMs: T - 1, lastWriteAtMs: T }),
  { send: true, priority: "5" });

// p10 틱: catch-up 여부 무관 p10 (중복 승격 없음)
check("catch-up: p10 tick + late token → p10 (변화 없음)",
  decideLegacyTokenUpdate({ decision: p10Tick, tokenUpdatedAtMs: T + 1, lastWriteAtMs: T }),
  { send: true, priority: "10" });

// 자연 해제: catch-up p10을 받은 다음 틱(상태 행이 그 틱 시작 시각으로 전진)엔 old token
// → 스킵. 같은 토큰이 매 틱 p10을 반복 수신하지 않는다(과도한 p10 재발송 방지).
check("catch-up: 해제 — 상태 행 전진 후 같은 토큰은 skip",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T + 1, lastWriteAtMs: T + 60_000 }),
  { send: false });
// 단, 재등록(register upsert가 동일 토큰도 updated_at 갱신 — route 계약)하면 다시 1회 catch-up
check("catch-up: 재등록(updated_at 갱신) → 다시 1회 p10",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T + 120_000, lastWriteAtMs: T + 60_000 }),
  { send: true, priority: "10" });

// bootstrap gap (#664 재리뷰 blocker): cursor(lastWriteAt=null) 미생성 동안 채널 행 기반
// skip이 이어지면 발송 0 → cursor가 영영 안 생겨 늦은 토큰이 계속 굶는다. null = bootstrap
// 미완료로 보고 skip/p5여도 p10 1회 — 성공 틱이 cursor를 만들어 다음 틱 해제(위 해제 테스트).
check("bootstrap: cursor 없음(lastWrite null) + skip tick → p10 1회",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T, lastWriteAtMs: null }),
  { send: true, priority: "10" });
check("bootstrap: cursor 없음 + p5 tick → p10 승격",
  decideLegacyTokenUpdate({ decision: p5Tick, tokenUpdatedAtMs: T, lastWriteAtMs: null }),
  { send: true, priority: "10" });
check("bootstrap: cursor 없음 + token updated_at 미기록 → p10 (비교 기준 부재, 전 토큰 포함)",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: null, lastWriteAtMs: null }),
  { send: true, priority: "10" });
check("bootstrap: cursor 없음 + p10 tick → p10 (변화 없음)",
  decideLegacyTokenUpdate({ decision: p10Tick, tokenUpdatedAtMs: T, lastWriteAtMs: null }),
  { send: true, priority: "10" });
// bootstrap 해제: cursor 생성 후엔 일반 catch-up 매트릭스로 복귀(위 테스트들이 고정) —
// 대표 케이스로 old token skip 재확인.
check("bootstrap 해제: cursor 생성 후 old token → skip 복귀",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T - 1, lastWriteAtMs: T }),
  { send: false });

// 판정 재료 부재 폴백
check("catch-up: cursor 있음 + token updated_at 미기록 → catch-up 아님 (skip 유지)",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: null, lastWriteAtMs: T }),
  { send: false });
check("catch-up: decision null(판정 불가) → 기존 매분 발송 동작(p10 폴백)",
  decideLegacyTokenUpdate({ decision: null, tokenUpdatedAtMs: T - 1, lastWriteAtMs: T }),
  { send: true });

// ── decideStartReissue — 재설치 재발급 + 늦은 윈도우 per-토큰 게이트 (2026-07-17 사고) ──
// 기준은 token_changed_at(토큰 *세대*) — updated_at(등록 heartbeat)이 아님(삼순 NO-GO).
{
  const GS = 1_000_000_000; // 경기 시작
  const W = 90 * 60 * 1000; // START_WINDOW_MS
  const base = { gameStartMs: GS, startWindowMs: W };

  // 윈도우 내 기본 동작(기존 계약 보존)
  check("reissue: 윈도우 내 + claim/구독 없음 → 발송",
    decideStartReissue({ ...base, nowMs: GS + 10_000, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: null, hasCurrentTokenSubscription: false }),
    { eligible: true, invalidateStaleClaim: false });
  check("reissue: 현 세대의 claim(세대 이후 생성) → 제외(중복 방지)",
    decideStartReissue({ ...base, nowMs: GS + 10_000, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: GS, hasCurrentTokenSubscription: false }),
    { eligible: false });
  check("reissue: 현재 토큰 device_key 일치 구독 → 제외",
    decideStartReissue({ ...base, nowMs: GS + 10_000, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: null, hasCurrentTokenSubscription: true }),
    { eligible: false });

  // 삼순 지정 회귀 ①: same-token 포그라운드 재등록(세대 불변, heartbeat만 전진) +
  // 기존 claim + current-channel ACK → 절대 재발송 아님(중복 카드 방지).
  // 세대는 GS-60s 그대로, claim은 세대 이후(GS) = 현 세대 수신분.
  check("reissue: [회귀] same-token 재등록 + 기존 claim + 현 ACK → 제외",
    decideStartReissue({ ...base, nowMs: GS + 30 * 60 * 1000, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: GS, hasCurrentTokenSubscription: true }),
    { eligible: false });
  check("reissue: [회귀] same-token 재등록 + 기존 claim만(ACK 없음) → 제외",
    decideStartReissue({ ...base, nowMs: GS + 30 * 60 * 1000, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: GS, hasCurrentTokenSubscription: false }),
    { eligible: false });

  // 삼순 지정 회귀 ②: 실제 토큰 값 교체(새 세대) + 이전 설치 claim/ACK → 재발송.
  // 이전 구독은 device_key 불일치 = hasCurrentTokenSubscription false로 들어옴.
  check("reissue: [회귀] 토큰 교체 + 옛 claim/옛 ACK → invalidate + 재발송",
    decideStartReissue({ ...base, nowMs: GS + 30 * 60 * 1000, tokenGenerationMs: GS + 5_000, claimCreatedAtMs: GS, hasCurrentTokenSubscription: false }),
    { eligible: true, invalidateStaleClaim: true });

  // 늦은 윈도우(시작+90분 경과): 경기 시작 이후 새 세대 토큰만 — 재설치 사고 재현
  const late = GS + W + 10 * 60 * 1000;
  check("reissue: 늦은 윈도우 + 경기 중 재설치(새 세대) → 발송 (사고 재현 fix)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: late - 60_000, claimCreatedAtMs: null, hasCurrentTokenSubscription: false }),
    { eligible: true, invalidateStaleClaim: false });
  check("reissue: 늦은 윈도우 + 재설치 + stale claim(17:30 발급분) → invalidate+재발송 (하린아빠 케이스)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: late - 60_000, claimCreatedAtMs: GS - 30 * 60 * 1000, hasCurrentTokenSubscription: false }),
    { eligible: true, invalidateStaleClaim: true });
  check("reissue: 늦은 윈도우 + 경기 전 세대 토큰 → 제외 (뒷북 대량 발송 방지 유지)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: GS - 60_000, claimCreatedAtMs: null, hasCurrentTokenSubscription: false }),
    { eligible: false });
  check("reissue: 늦은 윈도우 + same-token heartbeat만 있는 유저(세대=경기 전) → 제외 (포그라운드 복귀 ≠ 재설치)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: GS - 3 * 60 * 60 * 1000, claimCreatedAtMs: GS - 60_000, hasCurrentTokenSubscription: false }),
    { eligible: false });
  check("reissue: 늦은 윈도우 + 세대 미기록(레거시 행) → 제외 (보수적)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: null, claimCreatedAtMs: null, hasCurrentTokenSubscription: false }),
    { eligible: false });

  // 보수적 폴백
  check("reissue: 세대 미기록 + claim 있음 → 제외 (기존 동작)",
    decideStartReissue({ ...base, nowMs: GS + 10_000, tokenGenerationMs: null, claimCreatedAtMs: GS, hasCurrentTokenSubscription: false }),
    { eligible: false });
  check("reissue: gameStartMs 파싱 불가 → 늦은 윈도우 게이트 없이 기본 규칙",
    decideStartReissue({ gameStartMs: null, startWindowMs: W, nowMs: GS, tokenGenerationMs: GS - 1, claimCreatedAtMs: null, hasCurrentTokenSubscription: false }),
    { eligible: true, invalidateStaleClaim: false });
  // 재발송 후 반복 방지: 새 claim(created_at > 세대) 생성 후 다음 틱 → 제외
  check("reissue: 재발송 후 새 claim → 다음 틱 제외 (p10 반복 없음)",
    decideStartReissue({ ...base, nowMs: late, tokenGenerationMs: late - 60_000, claimCreatedAtMs: late - 30_000, hasCurrentTokenSubscription: false }),
    { eligible: false });

  // startTokenChangePatch — 세대 기록 계약
  check("changePatch: 동일 토큰 재등록 → 세대 보존(빈 패치)",
    startTokenChangePatch("tokA", "tokA", "2026-07-17T00:00:00Z"), {});
  check("changePatch: 토큰 교체 → token_changed_at 갱신",
    startTokenChangePatch("tokA", "tokB", "2026-07-17T00:00:00Z"),
    { token_changed_at: "2026-07-17T00:00:00Z" });
  check("changePatch: 신규 행(existing null) → 세대 시작",
    startTokenChangePatch(null, "tokB", "2026-07-17T00:00:00Z"),
    { token_changed_at: "2026-07-17T00:00:00Z" });
}
// ── shouldAdvanceFallbackCursor — mixed-result 영구 누락 방지 (#665 재리뷰 NO-GO) ──
check("cursor: 전원 성공 → 전진", shouldAdvanceFallbackCursor(["sent"]), true);
check("cursor: 다수 성공 → 전진", shouldAdvanceFallbackCursor(["sent", "sent"]), true);
check("cursor: 1 성공 + 1 invalidToken → 전진 (invalidToken은 terminal)",
  shouldAdvanceFallbackCursor(["sent", "invalidToken"]), true);
check("cursor: 1 성공 + 1 retryable 실패 → 보류 (재현 케이스)",
  shouldAdvanceFallbackCursor(["sent", "retryableFailure"]), false);
check("cursor: 성공 다수 + retryable 1건 섞임 → 보류",
  shouldAdvanceFallbackCursor(["sent", "sent", "retryableFailure"]), false);
check("cursor: 전원 retryable 실패 → 보류",
  shouldAdvanceFallbackCursor(["retryableFailure"]), false);
check("cursor: invalidToken + retryable 혼합(성공 無) → 보류",
  shouldAdvanceFallbackCursor(["invalidToken", "retryableFailure"]), false);

// ── applyChannelHeartbeat — 채널 무변화 stale 상한(삼순 5조건 ②, ≤2분 p10 server-attempt SLO) ──
{
  const HB = CHANNEL_HEARTBEAT_INTERVAL_MS;
  const t = 10_000_000;
  check("hb: interval = 2분", HB, 120_000);
  check("hb: 자연 p10 → 그대로(성공 시 last_p10_at 전진)",
    applyChannelHeartbeat({ send: true, priority: "10" }, t - HB * 5, t),
    { send: true, priority: "10" });
  check("hb: skip + 최근 p10(1분 전) → skip 유지",
    applyChannelHeartbeat({ send: false }, t - 60_000, t), { send: false });
  check("hb: skip + 2분 경과 → p10 heartbeat(놓친 단말 catch-up)",
    applyChannelHeartbeat({ send: false }, t - HB, t), { send: true, priority: "10" });
  check("hb: skip + last_p10 null(신규 채널/마이그레이션 backfill) → p10",
    applyChannelHeartbeat({ send: false }, null, t), { send: true, priority: "10" });
  check("hb: p5 + 최근 p10 → p5 유지(예산 미소모 경로 보존)",
    applyChannelHeartbeat({ send: true, priority: "5" }, t - 60_000, t),
    { send: true, priority: "5" });
  check("hb: p5 + 2분 경과 → p10 승격(p5는 last_p10_at 미전진이므로)",
    applyChannelHeartbeat({ send: true, priority: "5" }, t - HB - 1, t),
    { send: true, priority: "10" });
  check("hb: 경계 직전(2분-1ms) → 유지(과다 발송 방지)",
    applyChannelHeartbeat({ send: false }, t - HB + 1, t), { send: false });
}

// ── countUpdatableUsers — gap 집계 교정(channel_born 합산, 2026-07-23) ──
{
  const started = ["a", "b", "c", "d"];
  // 교정 전(channel_born 미합산): a=토큰, b=ACK → updatable 2, gap 2.
  check("updatable: 토큰∪ACK만(기존 집계) → 2",
    countUpdatableUsers({ started, tokenUsers: new Set(["a"]), channelAckUsers: new Set(["b"]), channelBornUsers: new Set() }), 2);
  // 교정 후: c가 채널 내장 발송 → updatable 3, gap 1 (ACK 미도착이어도 수신).
  check("updatable: channel_born 합산 → 3 (gap 과대계상 교정)",
    countUpdatableUsers({ started, tokenUsers: new Set(["a"]), channelAckUsers: new Set(["b"]), channelBornUsers: new Set(["c"]) }), 3);
  // 중복(토큰+ACK+내장 동일 유저)은 1로만 셈.
  check("updatable: 토큰∩ACK∩내장 중복 유저 → 1",
    countUpdatableUsers({ started: ["a"], tokenUsers: new Set(["a"]), channelAckUsers: new Set(["a"]), channelBornUsers: new Set(["a"]) }), 1);
  // started 밖 유저(경기룸 방문으로만 뜼 LA)는 분자에 안 셈.
  check("updatable: started 밖 토큰 유저 미집계",
    countUpdatableUsers({ started: ["a"], tokenUsers: new Set(["z"]), channelAckUsers: new Set(), channelBornUsers: new Set() }), 0);
}

// ── isStaleStartToken — ④ 30일+ 휴면 p2s 발송 제외 ──
{
  const now = Date.parse("2026-07-23T12:00:00+09:00");
  check("stale: 30일+1ms 경과 → true",
    isStaleStartToken(new Date(now - STALE_START_TOKEN_MS - 1).toISOString(), now), true);
  check("stale: 정확히 30일(경계) → false(발송 유지)",
    isStaleStartToken(new Date(now - STALE_START_TOKEN_MS).toISOString(), now), false);
  check("stale: 어제 갱신 → false",
    isStaleStartToken(new Date(now - 24 * 60 * 60 * 1000).toISOString(), now), false);
  check("stale: null → false(보수적 — 발송 유지)", isStaleStartToken(null, now), false);
  check("stale: 파싱 불가 → false(보수적)", isStaleStartToken("not-a-date", now), false);
}

// ── selectWakeGapRows — 무음 wake 대상·attempted 기록 선별(삼순 재리뷰 wake 오염 제거) ──
// pushLiveActivitySilentWakes는 wake 발송 대상과 wake_attempted_at 기록을 *모두* 이
// 함수 반환값(gapRows)에서만 파생시킨다 — 여기서 빠지면 wake도 attempted 기록도 없다.
// 채널출생 제외는 *세대 일치(isLiveBornChannel)*일 때만 — 출생 채널이 교체되면 gap 복귀
// (삼순 라운드2 blocker).
{
  const now = Date.parse("2026-07-23T19:00:00+09:00");
  const W = 10 * 60 * 1000; // wake 창 10분 가정
  const live = "20260723LGKT0";
  const sched = "20260723OBSS0";
  // 출생 세대: "A" = chanA(구채널), "B" = chanB(현 active), null = 레거시/비채널 발송.
  const row = (user: string, game: string, born: "A" | "B" | null, createdAt: string | null = null) =>
    ({
      user_id: user, game_id: game, created_at: createdAt,
      channel_born_environment: born ? "production" : null,
      channel_born_channel_id: born === "A" ? "chanA" : born === "B" ? "chanB" : null,
    });
  // 현재 active 채널 = chanB (채널 A는 ChannelNotRegistered로 deleted 후 B로 재생성된 상황).
  const activeB = new Set([`${live}|production|chanB`, `${sched}|production|chanB`]);

  // 핵심 회귀: 유효 채널출생 단독 row(토큰/ACK 없음)는 wake 대상·attempted 기록에서 제외.
  check("wakeGap: 유효 채널출생(세대 일치) 단독 row → 제외(wake·attempted 모두 없음)",
    selectWakeGapRows([row("u1", live, "B")], new Set(), activeB, new Set(), now, W), []);
  // 삼순 라운드2 회귀: 채널 A born → A 무효화(deleted) → B active — 구채널 출생 row는
  // broadcast를 못 받으므로 wake gap으로 복귀해야 한다(boolean 영구 제외 금지).
  check("wakeGap: [라운드2] 채널 A born + 현 active=B → gap 복귀(wake 대상)",
    selectWakeGapRows([row("u1", live, "A")], new Set(), activeB, new Set(), now, W),
    [row("u1", live, "A")]);
  // 재제외(③): 구채널 출생 row도 이후 update 토큰 또는 새 채널 B ACK가 생기면
  // updatableKeys(토큰∪유효 ACK 동일 경로)로 다시 제외된다.
  check("wakeGap: [라운드2] 구채널 born + 이후 토큰/B ACK 등록 → 재제외",
    selectWakeGapRows([row("u1", live, "A")], new Set([`u1|${live}`]), activeB, new Set(), now, W), []);
  // 채널출생 아닌 순수 gap row(세대 null)는 여전히 대상 — 마이그레이션 이전 행 포함(보수적).
  check("wakeGap: 토큰·ACK·채널출생 없는 row(null 세대) → 대상 유지",
    selectWakeGapRows([row("u1", live, null)], new Set(), activeB, new Set(), now, W),
    [row("u1", live, null)]);
  // 혼합: 유효 채널출생 row만 정확히 빠진다(같은 경기 다른 유저 영향 없음).
  check("wakeGap: 혼합 — 유효 채널출생 row만 제외, 구채널·null row는 gap 유지",
    selectWakeGapRows([row("u1", live, "B"), row("u2", live, "A"), row("u3", live, null)], new Set(), activeB, new Set(), now, W),
    [row("u2", live, "A"), row("u3", live, null)]);
  // 기존 제외 조건 회귀: update 토큰/유효 ACK 보유 유저 제외 유지.
  check("wakeGap: update 토큰/유효 ACK 보유 → 제외(기존 동작 보존)",
    selectWakeGapRows([row("u1", live, null)], new Set([`u1|${live}`]), activeB, new Set(), now, W), []);
  // scheduled 창 회귀: 발급 직후만 포함, 창 밖/created_at null 제외.
  const fresh = new Date(now - W + 1000).toISOString();
  const old = new Date(now - W - 1000).toISOString();
  check("wakeGap: scheduled 창 이내 발급 row → 포함",
    selectWakeGapRows([row("u1", sched, null, fresh)], new Set(), activeB, new Set([sched]), now, W),
    [row("u1", sched, null, fresh)]);
  check("wakeGap: scheduled 창 경과 row → 제외",
    selectWakeGapRows([row("u1", sched, null, old)], new Set(), activeB, new Set([sched]), now, W), []);
  check("wakeGap: scheduled + 유효 채널출생 → 창 이내여도 제외",
    selectWakeGapRows([row("u1", sched, "B", fresh)], new Set(), activeB, new Set([sched]), now, W), []);
  check("wakeGap: scheduled + 구채널 born → 창 이내면 gap 복귀(재제외 아님)",
    selectWakeGapRows([row("u1", sched, "A", fresh)], new Set(), activeB, new Set([sched]), now, W),
    [row("u1", sched, "A", fresh)]);
}

// ── isWakeWindowOpen — 채널 세대 기준 wake 창 재오픈(삼순 라운드3) ──
// live 전환 20분 창이 닫혀도, 라이브 도중 채널이 늦게 생성/A→B 교체되면 그 시점
// 기준으로 창을 다시 연다 — 구채널·레거시 카드 자동구제(2026-07-23 실사례: 19:07 시작
// 경기의 늦은 채널 생성 시 이미 닫힌 창 때문에 구제 불가). 정책(20분 창)은 그대로.
{
  const W = 20 * 60 * 1000;
  const now = Date.parse("2026-07-23T19:40:00+09:00");
  const liveAt = now - 30 * 60 * 1000; // live 전환 30분 전 = 이벤트 창 마감 상황

  // ① live+30분(이벤트 창 마감) 후 채널 A→B 교체(5분 전) → 창 재오픈.
  check("wakeWindow: [라운드3①] live+30분 마감 + 채널 A→B 교체 5분 전 → 재오픈",
    isWakeWindowOpen(now, liveAt, now - 5 * 60 * 1000, W), true);
  // ① 통합: 재오픈된 창에서 구채널(A) 출생 세대 카드가 wake gap으로 복귀(라운드2 세대
  // 일치 설계 그대로 — 창만 열리면 selectWakeGapRows가 구채널 row를 대상으로 복원).
  {
    const game = "20260723LGKT0";
    const oldBorn = {
      user_id: "u1", game_id: game, created_at: null,
      channel_born_environment: "production", channel_born_channel_id: "chanA",
    };
    const activeB = new Set([`${game}|production|chanB`]);
    check("wakeWindow: [라운드3① 통합] 재오픈 창 + 구채널(A) born row → wake gap 복귀",
      isWakeWindowOpen(now, liveAt, now - 5 * 60 * 1000, W)
        ? selectWakeGapRows([oldBorn], new Set(), activeB, new Set(), now, W)
        : [],
      [oldBorn]);
  }
  // ② 채널이 live 도중 늦게 *처음* 생성 → 생성 시각 기준 창 오픈.
  check("wakeWindow: [라운드3②] live 도중 늦은 첫 채널 생성(1분 전) → 생성 시각 기준 오픈",
    isWakeWindowOpen(now, liveAt, now - 60 * 1000, W), true);
  // ③ 채널 변경 없음(세대도 live 직후 생성) + 20분 경과 → 기존대로 마감 유지.
  check("wakeWindow: [라운드3③] 채널 변경 없음 + 20분 경과 → 마감 유지(스팸 방지)",
    isWakeWindowOpen(now, liveAt, liveAt, W), false);
  check("wakeWindow: 채널 세대 정보 없음(active 없음/created_at null) + 창 마감 → 마감 유지",
    isWakeWindowOpen(now, liveAt, undefined, W), false);
  check("wakeWindow: 채널 교체 후에도 20분+ 경과 → 재오픈 창도 마감(정책 유지)",
    isWakeWindowOpen(now, liveAt, now - W - 1000, W), false);
  // 기존 동작 회귀: 이벤트 창 이내 · 이벤트 row 없음(막 발생) → 오픈.
  check("wakeWindow: 이벤트 창 이내(live+1분) → 오픈(기존 동작)",
    isWakeWindowOpen(now, now - 60 * 1000, undefined, W), true);
  check("wakeWindow: 이벤트 row 없음(막 전환) → 오픈(기존 안전 동작)",
    isWakeWindowOpen(now, undefined, undefined, W), true);
}

// ── isLiveBornChannel — 채널출생 세대 일치(삼순 라운드2) — 어드민 updatable 합산과
// wake 제외가 모두 이 함수 하나를 기준으로 삼는다(이중 기준 금지 계약).
{
  const game = "20260723LGKT0";
  const activeKeys = new Set([`${game}|production|chanB`]);
  const born = (env: string | null, chan: string | null) =>
    ({ game_id: game, channel_born_environment: env, channel_born_channel_id: chan });
  check("bornChannel: 현 active 세대 일치 → 유효",
    isLiveBornChannel(born("production", "chanB"), activeKeys), true);
  check("bornChannel: 구채널(chanA 출생, 현 active=chanB) → 불인정(gap 복귀)",
    isLiveBornChannel(born("production", "chanA"), activeKeys), false);
  check("bornChannel: 같은 channel_id지만 env 불일치 → 불인정",
    isLiveBornChannel(born("sandbox", "chanB"), activeKeys), false);
  check("bornChannel: 세대 미기록(null — 마이그레이션 이전 행) → 불인정(보수적)",
    isLiveBornChannel(born(null, null), activeKeys), false);
  check("bornChannel: active 채널 없는 경기 → 불인정",
    isLiveBornChannel({ ...born("production", "chanB"), game_id: "20260723OBNC0" }, activeKeys), false);

  // 어드민 updatable 통합 시나리오: 채널 A born → A deleted → B active.
  // channelBornUsers는 isLiveBornChannel 통과 유저만 담는다(호출부 계약) — 구채널 출생
  // 유저는 updatable 아님(①), 이후 B ACK/토큰 생기면 다시 updatable(③).
  const rows = [born("production", "chanA"), born("production", "chanB")].map((b, i) =>
    ({ ...b, user_id: `u${i + 1}` }));
  const bornUsers = new Set(rows.filter((r) => isLiveBornChannel(r, activeKeys)).map((r) => r.user_id));
  check("updatable: [라운드2] 구채널 born 유저는 updatable 아님(u2만 인정)",
    countUpdatableUsers({ started: ["u1", "u2"], tokenUsers: new Set(), channelAckUsers: new Set(), channelBornUsers: bornUsers }), 1);
  check("updatable: [라운드2] 구채널 born 유저도 이후 토큰/B ACK 등록 시 재인정 → 2",
    countUpdatableUsers({ started: ["u1", "u2"], tokenUsers: new Set(["u1"]), channelAckUsers: new Set(), channelBornUsers: bornUsers }), 2);
}

// ── p2sSendPlan — 서버 자동 p2s 채널-우선/유보 (PR #808 R3, 삼순 blocker①) ──
{
  const none = new Set<never>();
  const prodOnly = new Set(["production" as const]);
  const both = new Set(["production" as const, "sandbox" as const]);
  // 레거시 토큰(iOS17↓/build15↓) — 채널 무관, 기존 attempt 그대로 발송(채널 payload 없음).
  check("레거시(build15/iOS17) + 채널 없음 → 기존대로 발송(channelRequired=false)",
    p2sSendPlan({ os_major: 17, app_build: 15, env: "production" }, none),
    { kind: "send", attempts: ["production"], channelRequired: false, truncated: false });
  check("레거시 + 채널 있음이어도 channelRequired=false(레거시엔 채널 미첨부)",
    p2sSendPlan({ os_major: 17, app_build: 15, env: null }, both),
    { kind: "send", attempts: ["production", "sandbox"], channelRequired: false, truncated: false });
  // channel-capable(iOS18+/build16+) — 채널 준비된 env로만 발송.
  check("capable + 채널 전무 → defer(claim/발송 0, 다음 틱 재시도)",
    p2sSendPlan({ os_major: 18, app_build: 16, env: "production" }, none),
    { kind: "defer" });
  check("capable(known prod) + prod 채널 준비 → prod로만 발송(channelRequired)",
    p2sSendPlan({ os_major: 18, app_build: 16, env: "production" }, prodOnly),
    { kind: "send", attempts: ["production"], channelRequired: true, truncated: false });
  check("capable(known sandbox) + prod 채널만 → sandbox env 미준비 → defer",
    p2sSendPlan({ os_major: 18, app_build: 16, env: "sandbox" }, prodOnly),
    { kind: "defer" });
  check("capable(env null) + prod 채널만 → prod attempt만(truncated: sandbox 제거)",
    p2sSendPlan({ os_major: 18, app_build: 16, env: null }, prodOnly),
    { kind: "send", attempts: ["production"], channelRequired: true, truncated: true });
  check("capable(env null) + 양 env 채널 → 두 attempt, truncated 없음",
    p2sSendPlan({ os_major: 18, app_build: 16, env: null }, both),
    { kind: "send", attempts: ["production", "sandbox"], channelRequired: true, truncated: false });
  check("경계: build16/iOS18 정확히 = capable(채널 없으면 defer)",
    p2sSendPlan({ os_major: 18, app_build: 16, env: "production" }, none),
    { kind: "defer" });
  check("경계: build15는 미달 = 레거시 발송(defer 아님)",
    p2sSendPlan({ os_major: 18, app_build: 15, env: "production" }, none),
    { kind: "send", attempts: ["production"], channelRequired: false, truncated: false });
}

// ── resolveChannelUpdateDecision — 지명 catch-up p10 승격 (삼순 R2 blocker③) ──
// fast-path가 유실 복구로 지명한 경기는 base 판정이 skip이든 p5든 반드시 p10 —
// R1은 `!send`일 때만 승격해 relay lastPlay만 다른 base=p5 틱에서 catch-up이 p5로
// 나가고(pending은 이미 clear) 놓친 단말이 2분 heartbeat까지 stale로 남았다.
{
  const HB = CHANNEL_HEARTBEAT_INTERVAL_MS;
  const t = 10_000_000;
  const same = {
    scoreState: scoreStateOf(baseCs), fullStateHash: fullStateHashOf(baseCs),
    lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
  };
  // lastPlay만 다름 = 점수축 동일·전체축 변화 → base p5.
  const lastPlayOnly = { ...baseCs, lastPlay: "박동원 안타" };
  const p5Base = {
    scoreState: scoreStateOf(lastPlayOnly), fullStateHash: fullStateHashOf(lastPlayOnly),
    lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
  };
  check("resolve: 지명 catch-up + base p5(lastPlay만) + fresh p10 → p10 승격(R2③ 핵심)",
    resolveChannelUpdateDecision({ ...p5Base, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: true, lastSendAtMs: t - 10_000, hasLastContent: false }),
    { decision: { send: true, priority: "10" }, isHeartbeat: false, isForcedCatchup: true, resendLastContent: false });
  check("resolve: 지명 catch-up + 무변화 skip + fresh p10 → p10 승격",
    resolveChannelUpdateDecision({ ...same, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: true, lastSendAtMs: t - 10_000, hasLastContent: false }),
    { decision: { send: true, priority: "10" }, isHeartbeat: false, isForcedCatchup: true, resendLastContent: false });
  check("resolve: 지명 catch-up + 자연 p10(점수 변화) → 그 발송이 겸함(이중 승격 아님)",
    resolveChannelUpdateDecision({
      scoreState: scoreStateOf({ ...baseCs, homeScore: 2 }),
      fullStateHash: fullStateHashOf({ ...baseCs, homeScore: 2 }),
      lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
      lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: true, lastSendAtMs: t - 10_000, hasLastContent: false,
    }),
    { decision: { send: true, priority: "10" }, isHeartbeat: false, isForcedCatchup: false, resendLastContent: false });
  check("resolve: 지명 catch-up + heartbeat 만료 p10 → heartbeat가 겸함(catchup 카운트 아님)",
    resolveChannelUpdateDecision({ ...same, lastP10AtMs: t - HB, nowMs: t, forceCatchup: true, lastSendAtMs: t - 10_000, hasLastContent: false }),
    { decision: { send: true, priority: "10" }, isHeartbeat: true, isForcedCatchup: false, resendLastContent: false });
  check("resolve: 비지명 + base p5 + fresh p10 → p5 그대로(예산 경로 보존)",
    resolveChannelUpdateDecision({ ...p5Base, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 61_000, hasLastContent: false }),
    { decision: { send: true, priority: "5" }, isHeartbeat: false, isForcedCatchup: false, resendLastContent: false });
  check("resolve: 비지명 + 무변화 + fresh p10 → skip 그대로",
    resolveChannelUpdateDecision({ ...same, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 10_000, hasLastContent: false }),
    { decision: { send: false }, isHeartbeat: false, isForcedCatchup: false, skipReason: "no_change", resendLastContent: false });
}

// ── resolveChannelUpdateDecision — p5 코얼레싱 + retreat 중 heartbeat 복구 (삼순 2026-08-27) ──
// 재리뷰 P1 반영: 코얼레싱 자격 = *볼/스트라이크만* 변화(p5CoalesceEligible). lastPlay(중계
// 한 줄)·타자·투수·아웃 변화 p5 는 비대상 — 즉시성 유지.
{
  const HB = CHANNEL_HEARTBEAT_INTERVAL_MS;
  const t = 20_000_000;
  // 볼카운트만 변화 = 코얼레싱 자격 있는 p5.
  const ballsOnly = { ...baseCs, balls: 2 };
  const p5Balls = {
    scoreState: scoreStateOf(ballsOnly), fullStateHash: fullStateHashOf(ballsOnly),
    lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
  };
  // lastPlay(중계 한 줄) 변화 = 자격 없는 p5(즉시 발송 유지).
  const lastPlayOnly = { ...baseCs, lastPlay: "박동원 안타" };
  const p5LastPlay = {
    scoreState: scoreStateOf(lastPlayOnly), fullStateHash: fullStateHashOf(lastPlayOnly),
    lastScoreState: scoreStateOf(baseCs), lastStateHash: fullStateHashOf(baseCs),
  };
  // C1) 볼카운트-only p5 + 마지막 발송 60s 미만 → 코얼레싱 스킵.
  check("resolve C1: 볼카운트-only p5 + lastSend 59s 전 → p5_coalesced 스킵",
    resolveChannelUpdateDecision({ ...p5Balls, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 59_000, hasLastContent: true, p5CoalesceEligible: true }),
    { decision: { send: false }, isHeartbeat: false, isForcedCatchup: false, skipReason: "p5_coalesced", resendLastContent: false });
  // C2) 볼카운트-only p5 + 60s 경과 → 발송(경계 포함).
  check("resolve C2: 볼카운트-only p5 + lastSend 정확히 60s 전 → p5 발송(경계)",
    resolveChannelUpdateDecision({ ...p5Balls, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 60_000, hasLastContent: true, p5CoalesceEligible: true }),
    { decision: { send: true, priority: "5" }, isHeartbeat: false, isForcedCatchup: false, resendLastContent: false });
  // C3) last_send_at 미기록(구 행) → 코얼레싱 미적용(기존 동작 보존).
  check("resolve C3: 볼카운트-only p5 + lastSendAtMs null(구 행) → p5 발송(diet 미적용)",
    resolveChannelUpdateDecision({ ...p5Balls, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: null, hasLastContent: false, p5CoalesceEligible: false }),
    { decision: { send: true, priority: "5" }, isHeartbeat: false, isForcedCatchup: false, resendLastContent: false });
  // C4) 지명 catch-up 은 코얼레싱 비대상(p10 승격이 우선).
  check("resolve C4: 볼카운트-only p5 + fresh send + 지명 catch-up → p10(코얼레싱에 안 먹힘)",
    resolveChannelUpdateDecision({ ...p5Balls, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: true, lastSendAtMs: t - 10_000, hasLastContent: true, p5CoalesceEligible: true }),
    { decision: { send: true, priority: "10" }, isHeartbeat: false, isForcedCatchup: true, resendLastContent: false });
  // C5) heartbeat 승격은 코얼레싱 비대상.
  check("resolve C5: 볼카운트-only p5 + fresh send + heartbeat 만료 → p10(코얼레싱에 안 먹힘)",
    resolveChannelUpdateDecision({ ...p5Balls, lastP10AtMs: t - HB, nowMs: t, forceCatchup: false, lastSendAtMs: t - 10_000, hasLastContent: true, p5CoalesceEligible: true }),
    { decision: { send: true, priority: "10" }, isHeartbeat: true, isForcedCatchup: false, resendLastContent: false });
  // C6, 삼순 재리뷰 P1) lastPlay(중계 한 줄)-only p5 는 자격 없음 → fresh send 여도 즉시 발송.
  check("resolve C6: lastPlay-only p5 + lastSend 10s 전 + 자격 없음 → p5 즉시 발송(코얼레싱 비대상)",
    resolveChannelUpdateDecision({ ...p5LastPlay, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 10_000, hasLastContent: true, p5CoalesceEligible: false }),
    { decision: { send: true, priority: "5" }, isHeartbeat: false, isForcedCatchup: false, resendLastContent: false });

  // retreat 스냅샷(점수 후퇴) — lastScoreState 가 더 높은 값.
  const retreat = {
    scoreState: scoreStateOf(baseCs), fullStateHash: fullStateHashOf(baseCs),
    lastScoreState: scoreStateOf({ ...baseCs, homeScore: 3 }),
    lastStateHash: fullStateHashOf({ ...baseCs, homeScore: 3 }),
  };
  // R1) retreat + heartbeat 미만료 → 스킵(사유 retreat).
  check("resolve R1: retreat + fresh p10 → skip(reason=retreat)",
    resolveChannelUpdateDecision({ ...retreat, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: false, lastSendAtMs: t - 30_000, hasLastContent: true }),
    { decision: { send: false }, isHeartbeat: false, isForcedCatchup: false, skipReason: "retreat", resendLastContent: false });
  // R2) retreat + heartbeat 만료 + 보존 콘텐츠 있음 → 마지막 성공값 p10 재전송(복구 핵심).
  check("resolve R2: retreat + HB 만료 + 보존 콘텐츠 → 마지막 성공값 p10 재전송",
    resolveChannelUpdateDecision({ ...retreat, lastP10AtMs: t - HB, nowMs: t, forceCatchup: false, lastSendAtMs: t - HB, hasLastContent: true }),
    { decision: { send: true, priority: "10" }, isHeartbeat: true, isForcedCatchup: false, resendLastContent: true });
  // R3) retreat + heartbeat 만료 + 보존 콘텐츠 없음(구 행) → 기존대로 스킵(fail-safe).
  check("resolve R3: retreat + HB 만료 + 콘텐츠 없음 → skip(fail-safe, 기존 동작)",
    resolveChannelUpdateDecision({ ...retreat, lastP10AtMs: t - HB, nowMs: t, forceCatchup: false, lastSendAtMs: t - HB, hasLastContent: false }),
    { decision: { send: false }, isHeartbeat: false, isForcedCatchup: false, skipReason: "retreat", resendLastContent: false });
  // R4) retreat + 지명 catch-up 이어도 후퇴 스냅샷 강제발송 금지(기존 B② 계약 유지).
  check("resolve R4: retreat + forceCatchup → 여전히 skip(후퇴값 강제발송 금지)",
    resolveChannelUpdateDecision({ ...retreat, lastP10AtMs: t - 30_000, nowMs: t, forceCatchup: true, lastSendAtMs: t - 30_000, hasLastContent: true }),
    { decision: { send: false }, isHeartbeat: false, isForcedCatchup: false, skipReason: "retreat", resendLastContent: false });
}

// ── runChannelBroadcastPass — 요청-절대 deadline 유계 종료·재-arm (삼순 R4 blocker②) ──
// route와 동일한 채널 순회 루프(live-activity-channels가 위임하는 pass)에 fake clock/
// 실패 send를 주입: 채널별 APNs send가 직렬 8s timeout이면 5경기×2 env = 80s로
// maxDuration(75s) 504가 가능했다. deadline(60s) 초과 시 새 send를 시작하지 않고 명시
// 종료 + 미발송 라이브 경기 전부 failedGameIds 보고(다음 틱 catch-up 재-arm 재료)를 고정.
import { runChannelBroadcastPass } from "../../src/lib/notifications/live-activity-channel-broadcast-pass";
import type { ChannelRow } from "../../src/lib/notifications/live-activity-channels";
import type { KboRawGame } from "../../src/types/api";

function liveGame(id: string): KboRawGame {
  return {
    G_ID: id, GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "두산",
    T_SCORE_CN: "1", B_SCORE_CN: "0", GAME_INN_NO: 4, GAME_TB_SC: "T",
    OUT_CN: 1, BALL_CN: 0, STRIKE_CN: 0, CANCEL_SC_ID: "", S_NM: "잠실",
  } as unknown as KboRawGame;
}
function channelRow(gameId: string, environment: "production" | "sandbox"): ChannelRow {
  return {
    game_id: gameId, environment, channel_id: `chan-${gameId}-${environment}`,
    status: "active", last_score_state: null, last_state_hash: null, last_p10_at: null,
    last_send_at: null, last_content_state: null,
    attempt_count: 0, next_retry_at: null,
    created_at: new Date(0).toISOString(), ending_at: null,
  };
}
function passDeps(clock: { now(): number }, send: (env: string) => Promise<{ ok: boolean; reason?: string }>) {
  const updated: { gameId: string; patch: Record<string, unknown> }[] = [];
  return {
    updated,
    deps: {
      now: clock.now,
      gameStatus: (g: KboRawGame) =>
        (g.GAME_STATE_SC === "2" ? "live" : g.GAME_STATE_SC === "3" ? "final" : "other") as
          "live" | "final" | "scheduled" | "other",
      buildContentState: (g: KboRawGame, status: "live" | "final" | "scheduled") => ({
        awayScore: parseInt(g.T_SCORE_CN ?? "0") || 0,
        homeScore: parseInt(g.B_SCORE_CN ?? "0") || 0,
        inning: g.GAME_INN_NO ?? 1, isTopInning: g.GAME_TB_SC === "T",
        balls: g.BALL_CN ?? 0, strikes: g.STRIKE_CN ?? 0, outs: g.OUT_CN ?? 0,
        onFirst: false, onSecond: false, onThird: false,
        pitcherName: "", batterName: "", stadium: g.S_NM ?? "", status,
      }),
      send: (p: { env: "production" | "sandbox" }) => send(p.env),
      deleteChannel: async () => true,
      updateChannel: async (row: ChannelRow, patch: Record<string, unknown>) => {
        updated.push({ gameId: row.game_id, patch });
        return 1;
      },
    },
  };
}

(async () => {
  const GIDS = ["20260724LGOB0", "20260724NCSS0", "20260724KTHH0", "20260724SKHT0", "20260724WOLT0"];
  // ── 삼순 R4② 지정 회귀: 5경기×2 env 전부 APNs timeout(건당 8s) ──
  {
    let nowMs = 0;
    const { deps } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 8_000; // APNs http2 8s timeout 재현
      return { ok: false, reason: "timeout" };
    });
    const channels = GIDS.flatMap((id) => [channelRow(id, "production"), channelRow(id, "sandbox")]);
    const stats = await runChannelBroadcastPass(
      channels, GIDS.map(liveGame), undefined, { deadlineAtMs: 60_000 }, deps,
    );
    check("pass R4②: 5경기×2 env 전부 timeout → 60s deadline 후 새 send 시작 안 함(명시 종료)",
      nowMs <= 68_000, true);
    check("pass R4②: maxDuration(75s) 전 종료", nowMs < 75_000, true);
    check("pass R4②: deadline 초과 행은 발송 미시작으로 집계", stats.deadlineSkipped >= 1, true);
    check("pass R4②: 미발송 포함 라이브 5경기 전부 재-arm 보고(failedGameIds)",
      stats.failedGameIds.slice().sort().join(","), GIDS.slice().sort().join(","));
    check("pass R4②: 성공 update 0 — hash 미전진(다음 분 자연 재시도 유지)", stats.updates, 0);
  }
  // ── 정상 경로 보존: deadline 여유 시 전부 발송 + p10 커서 전진 ──
  {
    let nowMs = 0;
    const { deps, updated } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 100;
      return { ok: true };
    });
    const channels = GIDS.flatMap((id) => [channelRow(id, "production"), channelRow(id, "sandbox")]);
    const stats = await runChannelBroadcastPass(
      channels, GIDS.map(liveGame), undefined, { deadlineAtMs: 60_000 }, deps,
    );
    check("pass: 정상 경로 — 10채널 전부 update(첫 틱 p10)", stats.updates, 10);
    check("pass: 정상 경로 — 재-arm/deadline 스킵 없음",
      stats.failedGameIds.length === 0 && stats.deadlineSkipped === 0, true);
    check("pass: 성공 p10은 last_p10_at 커서 전진 기록",
      updated.every((u) => "last_p10_at" in u.patch) && updated.length === 10, true);
  }
  // ── 혼합: 일부 경기만 직전 send가 느려 deadline 도달 → 나머지만 재-arm ──
  {
    let nowMs = 0;
    let sends = 0;
    const { deps } = passDeps({ now: () => nowMs }, async () => {
      sends += 1;
      if (sends <= 2) { nowMs += 100; return { ok: true }; } // g1 양 env 성공
      nowMs += 30_000; // g2 production에서 대형 지연 → 이후 deadline 초과
      return { ok: false, reason: "timeout" };
    });
    const channels = GIDS.slice(0, 3).flatMap((id) => [channelRow(id, "production"), channelRow(id, "sandbox")]);
    const stats = await runChannelBroadcastPass(
      channels, GIDS.slice(0, 3).map(liveGame), undefined, { deadlineAtMs: 30_000 }, deps,
    );
    check("pass: 혼합 — 성공 경기 제외, 실패+미발송 경기만 재-arm",
      stats.failedGameIds.slice().sort().join(","),
      GIDS.slice(1, 3).sort().join(","));
    check("pass: 혼합 — 성공 2건(g1 양 env) 집계", stats.updates, 2);
  }

  // ── 삼순 재리뷰 Blocker②: stale-equal p5 틱이 last_content_state 를 오염시키지 않는다 ──
  // 시나리오: 카드 3:0 발송 완료(보존 콘텐츠=3:0 신선본) → 다음 틱 relay 실패로 schedule
  // 점수 3:0(stale-equal) + lastPlay 만 변화 = p5 발송. 이 틱이 last_content_state 를
  // 덮으면 복구 재료가 낡은 스냅샷으로 오염된다 → score축 무변화 발송은 content 미갱신.
  {
    let nowMs = 1_000_000;
    const { deps, updated } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 100;
      return { ok: true };
    });
    const gid = GIDS[0];
    // 현재 틱: 볼카운트만 변화(BALL_CN 0→2) = score축 동일·full축 변화 → base p5.
    // (fixture buildContentState 는 lastPlay 를 반영하지 않으므로 볼카운트로 p5 유발 —
    //  stale-equal 의 본질인 "score축 무변화 발송" 검증에는 동일.)
    const g = { ...liveGame(gid), BALL_CN: 2 };
    const prevCs = deps.buildContentState(liveGame(gid), "live", undefined, true) as Record<string, unknown>;
    const row: ChannelRow = {
      ...channelRow(gid, "production"),
      last_score_state: scoreStateOf(prevCs),
      last_state_hash: fullStateHashOf(prevCs),
      last_p10_at: new Date(nowMs - 30_000).toISOString(),
      last_send_at: new Date(nowMs - 90_000).toISOString(), // 코얼레싱 창(60s) 밖 → p5 발송됨
      last_content_state: prevCs,
    };
    const stats = await runChannelBroadcastPass([row], [g], undefined, {}, deps);
    check("pass B②: stale-equal p5 발송 자체는 나감(중계 즉시성)", stats.updates, 1);
    const patch = updated[0]?.patch ?? {};
    check("pass B②: score축 무변화 발송은 last_content_state 미갱신(오염 차단)",
      "last_content_state" in patch, false);
    check("pass B②: last_send_at 은 전진(코얼레싱 커서)", "last_send_at" in patch, true);
  }
  // ── 점수 전진 발송은 content 갱신(복구 재료 신선화) ──
  {
    let nowMs = 2_000_000;
    const { deps, updated } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 100;
      return { ok: true };
    });
    const gid = GIDS[0];
    const g = liveGame(gid); // 1:0
    const prev = { ...liveGame(gid), T_SCORE_CN: "0" }; // 직전 발송은 0:0
    const prevCs = deps.buildContentState(prev, "live", undefined, true) as Record<string, unknown>;
    const row: ChannelRow = {
      ...channelRow(gid, "production"),
      last_score_state: scoreStateOf(prevCs),
      last_state_hash: fullStateHashOf(prevCs),
      last_p10_at: new Date(nowMs - 30_000).toISOString(),
      last_send_at: new Date(nowMs - 30_000).toISOString(),
      last_content_state: prevCs,
    };
    const stats = await runChannelBroadcastPass([row], [g], undefined, {}, deps);
    check("pass B②: 점수 전진 p10 발송", stats.updates, 1);
    check("pass B②: 점수 전진 발송은 last_content_state 갱신(재료 신선화)",
      "last_content_state" in (updated[0]?.patch ?? {}), true);
  }
  // ── retreat + HB 만료 → 보존 콘텐츠 p10 재전송(복구) — pass 레벨 종단 ──
  {
    let nowMs = 3_000_000;
    const sent: Record<string, unknown>[] = [];
    const { deps } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 100;
      return { ok: true };
    });
    const origSend = deps.send;
    deps.send = (p: { env: "production" | "sandbox"; contentState: Record<string, unknown> }) => {
      sent.push(p.contentState);
      return origSend(p);
    };
    const gid = GIDS[0];
    const g = liveGame(gid); // 현재 스냅샷 1:0
    const higher = { ...liveGame(gid), T_SCORE_CN: "3" }; // 직전 성공 발송은 3:0(더 높음) → retreat
    const higherCs = deps.buildContentState(higher, "live", undefined, true) as Record<string, unknown>;
    const row: ChannelRow = {
      ...channelRow(gid, "production"),
      last_score_state: scoreStateOf(higherCs),
      last_state_hash: fullStateHashOf(higherCs),
      last_p10_at: new Date(nowMs - CHANNEL_HEARTBEAT_INTERVAL_MS).toISOString(), // HB 만료
      last_send_at: new Date(nowMs - CHANNEL_HEARTBEAT_INTERVAL_MS).toISOString(),
      last_content_state: higherCs,
    };
    const stats = await runChannelBroadcastPass([row], [g], undefined, {}, deps);
    check("pass R②: retreat+HB만료 → 복구 발송 1건(retreatHeartbeats)", stats.retreatHeartbeats, 1);
    check("pass R②: 재전송 콘텐츠 = 마지막 성공값(후퇴 스냅샷 아님)",
      sent[0] === higherCs, true);
  }

  // ── 삼순 재리뷰2 Blocker③: 코얼레싱 커서는 last_state_hash(매 발송 전진) 기준 ──
  // 시나리오: 득점(content 갱신) → 타자 변경 p5 발송(content 는 그대로) → 볼카운트-only 틱.
  // 구 코드(content 대조)는 타자 변경 순간부터 다음 득점까지 코얼레싱 영구 비활성이었다.
  {
    let nowMs = 4_000_000;
    const { deps } = passDeps({ now: () => nowMs }, async () => {
      nowMs += 100;
      return { ok: true };
    });
    const gid = GIDS[0];
    const g = { ...liveGame(gid), BALL_CN: 2 }; // 이번 틱: 볼카운트만 변화
    // 직전 발송 = 볼 0 (같은 타자·같은 아웃) — last_state_hash 는 직전 발송 것.
    const prevSentCs = deps.buildContentState(liveGame(gid), "live", undefined, true) as Record<string, unknown>;
    // 복구 재료(content)는 더 옛날 득점 시점(0:0, 다른 상황) — Blocker② 이후의 실제 배선.
    const oldScoreCs = deps.buildContentState(
      { ...liveGame(gid), T_SCORE_CN: "0", OUT_CN: 0 }, "live", undefined, true,
    ) as Record<string, unknown>;
    const row: ChannelRow = {
      ...channelRow(gid, "production"),
      last_score_state: scoreStateOf(prevSentCs),
      last_state_hash: fullStateHashOf(prevSentCs),
      last_p10_at: new Date(nowMs - 30_000).toISOString(),
      last_send_at: new Date(nowMs - 10_000).toISOString(), // 코얼레싱 창 안
      last_content_state: oldScoreCs, // 낡은 복구 재료여도 코얼레싱은 걸려야 함
    };
    const stats = await runChannelBroadcastPass([row], [g], undefined, {}, deps);
    check("pass B③: content 가 옛 득점 시점이어도 볼카운트-only p5 는 코얼레싱 스킵",
      stats.coalescedSkipped, 1);
    check("pass B③: 발송 0(diet 실작동)", stats.updates, 0);
  }
  // ── isBallStrikeOnlyChange 단위 계약 ──
  {
    const prev = fullStateHashOf(baseCs);
    check("bsOnly: 볼만 변화 → true",
      isBallStrikeOnlyChange(prev, fullStateHashOf({ ...baseCs, balls: 2 })), true);
    check("bsOnly: 스트라이크만 변화 → true",
      isBallStrikeOnlyChange(prev, fullStateHashOf({ ...baseCs, strikes: 0 })), true);
    check("bsOnly: 아웃 변화 → false(즉시성 유지)",
      isBallStrikeOnlyChange(prev, fullStateHashOf({ ...baseCs, outs: 1 })), false);
    check("bsOnly: 타자 변화 → false",
      isBallStrikeOnlyChange(prev, fullStateHashOf({ ...baseCs, batterName: "김현수" })), false);
    check("bsOnly: lastPlay 변화 → false(중계 즉시성)",
      isBallStrikeOnlyChange(prev, fullStateHashOf({ ...baseCs, lastPlay: "안타" })), false);
    check("bsOnly: lastPlay 에 | 포함돼도 원문 비교(밀림 오판 없음)",
      isBallStrikeOnlyChange(
        fullStateHashOf({ ...baseCs, lastPlay: "1루|2루 동시 도루" }),
        fullStateHashOf({ ...baseCs, lastPlay: "1루|2루 동시 도루", balls: 2 }),
      ), true);
    check("bsOnly: 직전 hash null(첫 발송 전) → false", isBallStrikeOnlyChange(null, prev), false);
  }

  console.log(`\nla-broadcast-policy-smoke: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
