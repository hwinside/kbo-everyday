/**
 * 변이(mutation) 대상 파일의 단일 SSOT.
 *
 * 게이트(self-fetch-internal-gate.mjs)의 백업/복원 목록과 외부 cleanup selftest
 * (self-fetch-cleanup-selftest.mjs)의 검사 목록이 각각 따로 적혀 있으면,
 * 새 mutation target 을 한쪽에만 추가하는 순간 list drift 가 생긴다.
 * 그 drift 가 정확히 #1257 사고의 형태다 — 백업 목록에서 빠진 파일의 변이가
 * 워킹트리에 남고, 그대로 커밋되어 프로덕션 응답계약이 깨졌다.
 *
 * 그래서 목록은 여기 한 곳에만 둔다. 양쪽 모두 이 모듈을 import 하고,
 * 게이트는 mutateFile 단계에서 "이 목록에 없는 파일은 변이 금지"로 fail-close 한다.
 */
export const MUTATION_TARGETS = Object.freeze([
  "src/lib/services/player-today-game.ts",
  "src/app/api/widget/player-card/route.ts",
  "src/lib/services/player-stats.ts",
  "src/app/api/player-today-game/route.ts",
  "src/app/api/game-detail/route.ts",
  "src/app/api/player-stats/route.ts",
  "src/app/api/stats/route.ts",
  "src/app/api/player-game-logs/route.ts",
]);
