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

// ── 승인 범위: FavoritePlayersSection은 이번 PR에서 제외 ──
{
  const src = readFileSync("src/components/home/FavoritePlayersSection.tsx", "utf8");
  check("fav: 공용 훅 미채택(다음 슬라이스)", !src.includes("useVisibilityAwareInterval"));
  check("fav: 기존 45초 setInterval 보존", src.includes("setInterval(load, 45000)"));
}

console.log(`\nvisibility-poller-adoption: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
if (fail) process.exit(1);
