import type { GameRelayResponse, InningRelay } from "@/lib/hooks/useGameRelay";

/**
 * 해당 초/말 이닝의 실제 득점을 relay 응답의 linescore에서 직접 읽는다.
 * top(초)=원정팀 타석 → away.innings[n-1], bottom(말)=홈팀 타석 → home.innings[n-1].
 *
 * relay 문구 추정(countScoring)은 원문이 `홈인`이면 누락되고 주자 있는 홈런도
 * 1점만 잡히는 버그가 있어(파도 제보 7/26), linescore 값이 있으면 항상 우선한다.
 * linescore가 없거나 해당 이닝 값이 없으면 undefined → 카드가 추정카운트로 폴백.
 */
export function inningRuns(
  relay: GameRelayResponse | null | undefined,
  inning: InningRelay,
): number | null | undefined {
  const ls = relay?.linescore;
  if (!ls) return undefined;
  const side = inning.half === "top" ? ls.away : ls.home;
  const val = side?.innings?.[inning.inning - 1];
  return val ?? undefined;
}
