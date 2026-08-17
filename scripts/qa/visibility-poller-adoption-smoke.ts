/**
 * 경기목록 visibility-aware 폴링 채택 배선 회귀 (Tier1-② 단일 슬라이스).
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
  check("games: 최초/날짜전환 중복 방지(runImmediately: false)",
    /useVisibilityAwareInterval\([^)]*runImmediately:\s*false/.test(src));
  check("games: poller callback이 loadGames Promise 반환(single-flight 연결)",
    /const refreshGames = useCallback\(\(\) => \{[\s\S]*?return loadGames\(selectedDate, token\)/.test(src));
  check("games: 대상전환 generation coordinator 배선",
    src.includes("createRequestCoordinator<GameData[]>()") &&
      src.includes("requestCoordinator.switchTarget(selectedDate)"));
  check("games: 실제 fetch AbortSignal 배선", /fetch\([^;]+,\s*\{\s*signal\s*\}\)/.test(src));
  check("games: 백그라운드 정지를 우회하는 bare setInterval(loadGames) 폴링 없음",
    !/setInterval\(\s*\(\)\s*=>\s*loadGames/.test(src) && !src.includes("setInterval(loadGames"));
}

// ── 홈 최애선수 오늘경기 (45s) ──
{
  const src = readFileSync("src/components/home/FavoritePlayersSection.tsx", "utf8");
  check("fav: 공용 훅 import", src.includes('from "@/lib/hooks/useVisibilityAwareInterval"'));
  check("fav: 45초 cadence를 훅에 배선(loadTodayGames)",
    /useVisibilityAwareInterval\(\s*loadTodayGames\s*,\s*45000/.test(src));
  check("fav: 최애선수 있을 때만 폴링(enabled: hasFavPlayers)",
    /useVisibilityAwareInterval\([^)]*enabled:\s*hasFavPlayers/.test(src));
  check("fav: 최애선수 변경 시 즉시 갱신(resetKey: favKey)",
    /useVisibilityAwareInterval\([^)]*resetKey:\s*`\$\{favKey\}/.test(src));
  check("fav: 백그라운드 정지를 우회하는 bare setInterval(load) 폴링 없음",
    !/setInterval\(\s*load\s*,/.test(src));
}

// ── 경기상세 game-detail (pollInterval, 기본 30s) ──
{
  const src = readFileSync("src/lib/hooks/useGameDetail.ts", "utf8");
  check("game-detail: 공용 훅 import", src.includes('from "@/lib/hooks/useVisibilityAwareInterval"'));
  check("game-detail: pollInterval cadence를 훅에 배선",
    /useVisibilityAwareInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?fetchDetail\(\)[\s\S]*?\},\s*pollInterval/.test(src));
  check("game-detail: stop(final+box) 후 tick no-op(!stoppedRef.current 가드)",
    /useVisibilityAwareInterval\(\s*\(\)\s*=>\s*\{\s*if\s*\(!stoppedRef\.current\)/.test(src));
  check("game-detail: gameId 전환 즉시 갱신(resetKey: gameId)",
    /useVisibilityAwareInterval\([\s\S]*?resetKey:\s*gameId/.test(src));
  check("game-detail: 백그라운드 정지를 우회하는 bare setInterval 폴링 없음",
    !/setInterval\(/.test(src));
}

console.log(`\nvisibility-poller-adoption: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
if (fail) process.exit(1);
