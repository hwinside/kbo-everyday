/**
 * MY TEAM 오늘 우선 카드 선택 규칙 스모크 (pick-myteam-game.ts).
 * 실행: npm run qa:pick-myteam-game
 * 배경: 삼순 리뷰 NO-GO — 더블헤더에서 종료 1차전이 상단에 고정되던 문제.
 *   상태 우선순위(live > scheduled > final > cancelled)로 가장 의미있는 경기를 골라야 한다.
 */
import { pickMyTeamPriorityGame, type MyTeamGameLike } from "../../src/lib/utils/pick-myteam-game";

let pass = 0;
let fail = 0;
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// id 를 붙여 어떤 경기가 뽑혔는지 식별
type G = MyTeamGameLike & { id: string };
const LG = 1, DOOSAN = 2, KT = 3;

console.log("[pickMyTeamPriorityGame]");

// myTeamId null → null
eq("myTeamId null → null", pickMyTeamPriorityGame<G>([
  { id: "a", awayTeamId: LG, homeTeamId: KT, status: "live" },
], null), null);

// MY TEAM 경기 없음 → null
eq("MY TEAM 경기 없음 → null", pickMyTeamPriorityGame<G>([
  { id: "a", awayTeamId: DOOSAN, homeTeamId: KT, status: "live" },
], LG), null);

// 단일 경기 → 그 경기
eq("단일 경기 → 그 경기", pickMyTeamPriorityGame<G>([
  { id: "a", awayTeamId: LG, homeTeamId: KT, status: "scheduled" },
], LG)?.id, "a");

// 🔴 핵심 회귀: 더블헤더 1차전 final → 2차전 live, 배열 순서 [final, live]
eq("더블헤더 [1차전 final, 2차전 live] → live 선택", pickMyTeamPriorityGame<G>([
  { id: "g1", awayTeamId: LG, homeTeamId: KT, status: "final" },
  { id: "g2", awayTeamId: LG, homeTeamId: KT, status: "live" },
], LG)?.id, "g2");

// live > scheduled
eq("[scheduled, live] → live", pickMyTeamPriorityGame<G>([
  { id: "s", awayTeamId: KT, homeTeamId: LG, status: "scheduled" },
  { id: "l", awayTeamId: LG, homeTeamId: DOOSAN, status: "live" },
], LG)?.id, "l");

// scheduled > final
eq("[final, scheduled] → scheduled", pickMyTeamPriorityGame<G>([
  { id: "f", awayTeamId: LG, homeTeamId: KT, status: "final" },
  { id: "s", awayTeamId: LG, homeTeamId: DOOSAN, status: "scheduled" },
], LG)?.id, "s");

// final > cancelled
eq("[cancelled, final] → final", pickMyTeamPriorityGame<G>([
  { id: "c", awayTeamId: LG, homeTeamId: KT, status: "cancelled" },
  { id: "f", awayTeamId: LG, homeTeamId: DOOSAN, status: "final" },
], LG)?.id, "f");

// 동일 우선순위 → 배열 순서(경기 시간 순) 유지: [scheduled g1, scheduled g2] → g1
eq("동일 우선순위 → 먼저 나온 경기 유지", pickMyTeamPriorityGame<G>([
  { id: "g1", awayTeamId: LG, homeTeamId: KT, status: "scheduled" },
  { id: "g2", awayTeamId: DOOSAN, homeTeamId: LG, status: "scheduled" },
], LG)?.id, "g1");

// 홈/원정 양쪽 매칭 확인 (homeTeamId 로도 MY TEAM 인식)
eq("homeTeamId 매칭도 인식", pickMyTeamPriorityGame<G>([
  { id: "h", awayTeamId: KT, homeTeamId: LG, status: "live" },
], LG)?.id, "h");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
