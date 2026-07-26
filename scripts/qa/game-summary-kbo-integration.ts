#!/usr/bin/env tsx
/**
 * #888 실데이터 회귀: 2026-07-26 LG-한화 사고 경기.
 * KBO 경기목록(final 4-14)과 검증된 Schedule GetScoreBoard 이닝표가 수렴해야 한다.
 */

import { canonicalGate } from "../../src/lib/game-summary/cache-validation";

const GAME_ID = "20260726LGHH0";

async function main() {
  // crawler의 fallback tracker가 admin client를 모듈 로드 시 초기화하므로,
  // read-only 실데이터 회귀에서는 유효한 형태의 dummy env로 부수효과만 차단한다.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "qa-dummy-key";
  const { fetchGameLinescore, fetchGames } = await import("../../src/lib/crawler/kbo-api");

  const games = await fetchGames("20260726");
  const game = games.find((candidate) => candidate.gameId === GAME_ID);
  const linescore = await fetchGameLinescore(GAME_ID, "2026");
  const gate = canonicalGate(game, linescore);

  const checks: [string, boolean][] = [
    ["경기목록 exact gameId 존재", !!game],
    ["경기목록 final 4-14", game?.status === "final" && game.awayScore === 4 && game.homeScore === 14],
    ["스코어보드 final 4-14", linescore?.status === "final" && linescore.away.R === 4 && linescore.home.R === 14],
    ["스코어보드 검증 파서가 12회 셀을 분리", linescore?.away.innings.length === 12 && linescore.home.innings.length === 12],
    ["canonical gate 수렴", gate.reason === "ok" && gate.fingerprint?.awayScore === 4 && gate.fingerprint.homeScore === 14],
  ];

  let failed = 0;
  for (const [description, passed] of checks) {
    console.log(`${passed ? "✓" : "✗"} ${description}`);
    if (!passed) failed++;
  }

  if (failed > 0) {
    console.error(`FAIL: ${failed}/${checks.length} real integration checks failed`);
    process.exit(1);
  }
  console.log(`${checks.length}/${checks.length} passed (${GAME_ID})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
