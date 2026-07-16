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

console.log(`\nla-broadcast-policy-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
