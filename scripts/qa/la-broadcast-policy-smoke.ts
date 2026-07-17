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

// 판정 재료 부재 폴백
check("catch-up: 상태 행 없음(lastWrite null) → decision만 따름 (skip)",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: T, lastWriteAtMs: null }),
  { send: false });
check("catch-up: token updated_at 미기록 → catch-up 아님 (skip 유지)",
  decideLegacyTokenUpdate({ decision: skipTick, tokenUpdatedAtMs: null, lastWriteAtMs: T }),
  { send: false });
check("catch-up: decision null(판정 불가) → 기존 매분 발송 동작(p10 폴백)",
  decideLegacyTokenUpdate({ decision: null, tokenUpdatedAtMs: T - 1, lastWriteAtMs: T }),
  { send: true });

console.log(`\nla-broadcast-policy-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
