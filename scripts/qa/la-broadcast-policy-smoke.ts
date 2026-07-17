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
  endRetryDelayMinutes,
  startTokenEnvPatch,
  channelMutationFence,
  startTokenResultFence,
  decideLegacyTokenUpdate,
  decideStartReissue,
  startTokenChangePatch,
  shouldAdvanceFallbackCursor,
  applyChannelHeartbeat,
  CHANNEL_HEARTBEAT_INTERVAL_MS,
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

console.log(`\nla-broadcast-policy-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
