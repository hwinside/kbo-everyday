import type { GameRelayResponse, InningRelay } from "@/lib/hooks/useGameRelay";

export type InningLinescore = NonNullable<GameRelayResponse["linescore"]>;

/**
 * 해당 초/말 이닝의 실제 득점을 page가 선택한 authoritative linescore에서 읽는다.
 * top(초)=원정팀 타석 → away.innings[n-1], bottom(말)=홈팀 타석 → home.innings[n-1].
 * linescore가 없거나 해당 이닝 값이 null/배열 밖이면 undefined를 반환해 배지를 숨긴다.
 */
export function inningRuns(
  linescore: InningLinescore | null | undefined,
  inning: InningRelay,
): number | undefined {
  if (!linescore) return undefined;
  const side = inning.half === "top" ? linescore.away : linescore.home;
  const val = side?.innings?.[inning.inning - 1];
  return typeof val === "number" ? val : undefined;
}
