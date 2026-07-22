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
  "30초 폴링 fallback 유지",
  source.includes("setInterval(fetchChatMood, 30_000)"),
);
check(
  "고트래픽 경기에서도 최근 채팅 조회를 500건으로 제한",
  source.includes('.order("created_at", { ascending: false })') && source.includes(".limit(500)"),
);

console.log(`\nMood gauge Realtime load smoke: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
