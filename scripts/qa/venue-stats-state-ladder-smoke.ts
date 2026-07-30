/**
 * 직관 다이어리 통계 S1a — state 전역 단일 사다리 / 판정 파이프라인 회귀 (순수, DB X).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §12
 *
 * 고정하는 계약:
 *  - 사다리 순서·판정 파이프라인 단락 순서 (①snapshot → ②final → ③favorite → ④표본)
 *  - 복합상태: cancelled-only(final=0)+invalid snapshot → invalid_snapshot 단 1개
 *  - cancelled-only C = no_final (no_favorite은 final≥1일 때만)
 *  - leaf 승격: no_wins는 outer worstState 순위화 제외, leaf 제외 전부 ready면 outer=ready
 *    (D6 ready+no_wins 고정 payload와 1:1)
 *  - empty 계약: attendance=0 → empty (다른 어떤 하위 상태보다 먼저, unsupported 다음)
 *
 * 실행: npm run qa:venue-stats-state
 */
import {
  LEAF_ONLY_STATES,
  METRIC_STATE_LADDER,
  resolveMetricState,
  statePriority,
  worstState,
  type MetricStateInput,
} from "@/lib/venue-stats/state";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

/** 기본 supported·직관 있음 입력. 케이스별로 필요한 필드만 덮어쓴다. */
function input(over: Partial<MetricStateInput>): MetricStateInput {
  return { seasonSupported: true, attendanceGames: 5, finalGames: 5, ...over };
}

console.log("[사다리 선언]");
ok("사다리 10단계 순서 고정 (§12 유일 선언)",
  METRIC_STATE_LADDER.join(">") ===
    "unsupported>empty>attendance_only>invalid_snapshot>mixed_team>partial_data>no_final>no_favorite>sample_limited>ready");
ok("no_wins는 사다리 밖 leaf-only", !(METRIC_STATE_LADDER as readonly string[]).includes("no_wins") && LEAF_ONLY_STATES.includes("no_wins"));
ok("priority 단조 (unsupported < ready)", statePriority("unsupported") < statePriority("ready"));

console.log("\n[파이프라인 단락 순서]");
ok("season 미지원 → unsupported (전 조건보다 먼저)",
  resolveMetricState(input({ seasonSupported: false, attendanceGames: 0, invalidSnapshotGames: 3 })) === "unsupported");
ok("attendance=0 → empty (empty 계약)",
  resolveMetricState(input({ attendanceGames: 0, finalGames: 0, favoriteRequired: true, favoriteCount: 0 })) === "empty");
ok("비교 소스 미지원 → attendance_only (snapshot 오류보다 먼저)",
  resolveMetricState(input({ comparisonSourceSupported: false, invalidSnapshotGames: 1 })) === "attendance_only");
ok("snapshot 오류행 → invalid_snapshot (mixed/partial보다 먼저)",
  resolveMetricState(input({ invalidSnapshotGames: 1, mixedTeamApplies: true, snapshotTeamCount: 2, partialDataApplies: true, unknownGames: 2 })) === "invalid_snapshot");
ok("복수 snapshot 팀 → mixed_team (partial보다 먼저)",
  resolveMetricState(input({ mixedTeamApplies: true, snapshotTeamCount: 2, partialDataApplies: true, unknownGames: 2 })) === "mixed_team");
ok("적재 incomplete → partial_data (no_final보다 먼저)",
  resolveMetricState(input({ partialDataApplies: true, unknownGames: 1, finalGames: 0 })) === "partial_data");
ok("final=0 → no_final (favorite보다 먼저)",
  resolveMetricState(input({ finalGames: 0, favoriteRequired: true, favoriteCount: 0 })) === "no_final");
ok("final≥1 + 최애 없음 → no_favorite",
  resolveMetricState(input({ favoriteRequired: true, favoriteCount: 0 })) === "no_favorite");
ok("표본 미달 → sample_limited",
  resolveMetricState(input({ sampleMet: false })) === "sample_limited");
ok("전부 통과 → ready", resolveMetricState(input({})) === "ready");

console.log("\n[복합상태 — rev5 확정 회귀]");
// cancelled-only(final=0) + invalid snapshot 행 포함 → 기대 state=invalid_snapshot 단 1개 (§12)
ok("cancelled-only + invalid snapshot → invalid_snapshot 단 1개 (snapshot 검증이 final 선별보다 먼저)",
  resolveMetricState(input({ finalGames: 0, invalidSnapshotGames: 1 })) === "invalid_snapshot");
// cancelled-only C 확정: 최애 미설정 + 전부 취소 → no_final (no_favorite 아님)
ok("cancelled-only + 최애 미설정(C) → no_final (종전 no_favorite>no_final 폐기)",
  resolveMetricState(input({ finalGames: 0, favoriteRequired: true, favoriteCount: 0 })) === "no_final");
// mixed_team 미적용 metric은 복수 팀이어도 통과
ok("mixed_team 미적용 metric(A2 등)은 복수 팀이어도 ready",
  resolveMetricState(input({ mixedTeamApplies: false, snapshotTeamCount: 2 })) === "ready");
// partial_data 미적용 metric(A/D/E)은 unknown이 있어도 통과
ok("partial_data 미적용 metric은 unknown>0이어도 ready",
  resolveMetricState(input({ partialDataApplies: false, unknownGames: 3 })) === "ready");

console.log("\n[worstState / leaf 승격 (§12 rev5)]");
// D6 ready+no_wins 고정 payload: components={maxTeamRuns:ready, maxMarginWin:no_wins} → outer=ready
ok("D6: [ready, no_wins] → outer=ready (leaf 승격)", worstState(["ready", "no_wins"]) === "ready");
ok("leaf만 있으면 outer=ready", worstState(["no_wins"]) === "ready");
ok("빈 components → ready", worstState([]) === "ready");
ok("[ready, partial_data, no_wins] → partial_data (leaf 제외 후 최고 우선순위)",
  worstState(["ready", "partial_data", "no_wins"]) === "partial_data");
ok("[sample_limited, ready] → sample_limited", worstState(["sample_limited", "ready"]) === "sample_limited");
ok("[invalid_snapshot, mixed_team] → invalid_snapshot (사다리 우선순위)",
  worstState(["invalid_snapshot", "mixed_team"]) === "invalid_snapshot");
ok("[no_favorite, ready] → no_favorite (E4 stadium ready+favorite no_favorite 케이스)",
  worstState(["no_favorite", "ready"]) === "no_favorite");

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
