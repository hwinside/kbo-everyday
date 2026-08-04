import playersRoster from "@/lib/constants/players-roster.json";
import type { PlayerRef } from "@/lib/baseball-qa/pipeline";

/**
 * 야잘알봇이 "이 문장이 선수 질문인가"를 판정하는 **정본 로스터**.
 *
 * ⚠️ 이 모듈이 따로 있는 이유 (삼순 8차 P0-2, 2026-08-04).
 *
 * 종전에는 server.ts 안에 `async function loadPlayers() { return ROSTER_PLAYERS; }` 가
 * 인라인으로 있었고, 게이트들은 각자 자기 fixture 로스터를 주입해서 돌았다. 그래서
 * production loader 를 `return []` 로 끊어도 `qa:baseball-qa`·`qa:baseball-genius-context`·
 * `qa:baseball-rag-serving`·tsc·ESLint 가 전부 GREEN 이었다. 실제로는 로스터가 비면
 * `도루/출루율 → blocked`, `OPS → LLM 1회 뒤 blocked` 가 되어 합의 계약
 * (`history_hold` + `HISTORY_HOLD_ANSWER`, LLM/RAG/cache 0)이 깨진다.
 *
 * 그래서 주입값을 이 seam 으로 끌어내 게이트가 **실제 배포되는 함수를 그대로 실행**한다.
 * `createSeasonRecordFetcher` 와 같은 이유·같은 모양이다.
 */
export const ROSTER_PLAYERS: PlayerRef[] = playersRoster.map(
  ({ name, kboId, team, position, backNo }) => ({
    name,
    kboId,
    // 동명이인 picker 선택지를 사람이 구분하려면 팀·포지션·등번호까지 필요하다 —
    // 같은 팀에도 동명이인이 있기 때문이다.
    team: team ?? null,
    position: position ?? null,
    backNo: backNo ?? null,
  }),
);

/** production `QaDeps.loadPlayers` 주입값. 게이트가 이 함수를 그대로 실행한다. */
export async function loadRosterPlayers(): Promise<PlayerRef[]> {
  return ROSTER_PLAYERS;
}
