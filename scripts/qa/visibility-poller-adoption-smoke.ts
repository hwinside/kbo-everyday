/**
 * visibility-aware 폴링 훅 확산 배선 회귀 (Tier1-② 확산).
 * 실 fetch 폴러가 공용 훅으로 배선됐고, 조건 게이트(enabled)와 대상전환(resetKey)이
 * 보존됐으며, 백그라운드 정지를 우회하는 bare setInterval 폴링이 없음을 고정한다.
 *
 * 실행: npx tsx scripts/qa/visibility-poller-adoption-smoke.ts
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${name}`); }
}

// ── 경기목록 페이지 (30s, 라이브 시) ──
{
  const src = readFileSync("src/app/(main)/games/page.tsx", "utf8");
  check("games: 공용 훅 import", src.includes('from "@/lib/hooks/useVisibilityAwareInterval"'));
  check("games: 30초 cadence를 훅에 배선(loadGames)",
    /useVisibilityAwareInterval\(\s*refreshGames\s*,\s*30000/.test(src));
  check("games: 라이브일 때만 폴링(enabled: hasLive)",
    /useVisibilityAwareInterval\([^)]*enabled:\s*hasLive/.test(src));
  check("games: 날짜 전환 즉시 갱신(resetKey: selectedDate)",
    /useVisibilityAwareInterval\([^)]*resetKey:\s*selectedDate/.test(src));
  check("games: 백그라운드 정지를 우회하는 bare setInterval(loadGames) 폴링 없음",
    !/setInterval\(\s*\(\)\s*=>\s*loadGames/.test(src) && !src.includes("setInterval(loadGames"));
}

// ── 홈 최애선수 오늘 활약 (45s) ──
{
  const src = readFileSync("src/components/home/FavoritePlayersSection.tsx", "utf8");
  check("fav: 공용 훅 import", src.includes('from "@/lib/hooks/useVisibilityAwareInterval"'));
  check("fav: 45초 cadence를 훅에 배선(loadTodayGames)",
    /useVisibilityAwareInterval\(\s*loadTodayGames\s*,\s*45000/.test(src));
  check("fav: 최애선수 있을 때만 폴링(enabled: hasFav)",
    /useVisibilityAwareInterval\([^)]*enabled:\s*hasFav/.test(src));
  check("fav: 최애팀 변경 즉시 갱신(resetKey: favKey)",
    /useVisibilityAwareInterval\([^)]*resetKey:\s*favKey/.test(src));
  check("fav: bare setInterval(load) 폴링 없음",
    !src.includes("setInterval(load"));
  // 조건/집계 로직 보존: player-today-game fetch + show 필터 유지
  check("fav: player-today-game fetch 보존", src.includes("/api/player-today-game?team="));
  check("fav: show 필터 보존", /if \(r && r\.show\)/.test(src));
}

console.log(`\nvisibility-poller-adoption: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
if (fail) process.exit(1);
