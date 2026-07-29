import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/supabase/useMoodGauge.ts", "utf8");
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.error("  ✗", name);
  }
}

check(
  "분위기 게이지가 Postgres Changes 구독을 만들지 않음",
  !source.includes('"postgres_changes"') && !source.includes("mood-chat:"),
);
check(
  "현재 전체 채팅방만 집계",
  source.includes('.eq("room_id", `game:${gameId}`)'),
);
check(
  "폐기된 홈/어웨이 팬방을 재조회하지 않음",
  !source.includes('`game:${gameId}:home`') && !source.includes('`game:${gameId}:away`'),
);
check(
  "30초 cadence가 visibility-aware 폴링 훅에 실제 연결(fetchChatMood, 30_000)",
  /useVisibilityAwareInterval\(\s*fetchChatMood\s*,\s*30_000/.test(source),
);
check(
  "visibility-aware 폴링 훅을 import해 배선",
  source.includes('from "@/lib/hooks/useVisibilityAwareInterval"'),
);
check(
  "gameId 전환 즉시 갱신(resetKey: gameId)",
  /useVisibilityAwareInterval\([^)]*resetKey:\s*gameId/.test(source),
);
check(
  "백그라운드 탭 폴링 정지를 우회하는 bare setInterval 폴링 없음",
  !source.includes("setInterval(fetchChatMood"),
);
// 비하인드 0 / 복귀 즉시 1회 / 겹침 0 행동은 공용 스케줄러 회귀인 qa:visibility-poller가 고정한다
// (useMoodGauge가 그대로 이 스케줄러를 사용). 여기서는 배선 연결만 검증한다.
check(
  "고트래픽 경기에서도 최근 채팅 조회를 500건으로 제한",
  source.includes('.order("created_at", { ascending: false })') && source.includes(".limit(500)"),
);

console.log(`\nMood gauge Realtime load smoke: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
