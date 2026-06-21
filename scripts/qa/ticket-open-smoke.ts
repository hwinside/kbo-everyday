/**
 * 예매 오픈(홈/원정) 회귀 스모크 (npm run qa:ticket-open)
 * 원정경기=호스트팀 예매처/룰, 홈경기=자기팀, 최단오픈 선택을 실제 모듈로 검증.
 */
import { getNextTicketOpen } from "@/lib/utils/ticket-utils";
import { TICKET_OPEN_RULES } from "@/lib/constants/tickets";

let pass = 0, fail = 0;
const ck = (n: string, c: boolean) => { c ? (pass++, console.log("  ✓", n)) : (fail++, console.error("  ✗", n)); };

const now = new Date(2026, 0, 1, 12, 0, 0); // 2026-01-01, 이후 경기는 전부 미래 오픈
const HOST_HOME = 1; // 룰 보유
const HOST_AWAY = 3; // 룰 보유

// 1) 원정경기 → 호스트(상대)팀 예매처/룰
const away = getNextTicketOpen([{ date: "20260601", time: "18:30", homeTeamId: HOST_AWAY, isAway: true, opponentName: "상대" }], now);
ck("원정경기 isAway=true", !!away && away.isAway === true);
ck("원정경기 예매처=호스트팀", !!away && away.provider === TICKET_OPEN_RULES[HOST_AWAY].provider && away.buyUrl === TICKET_OPEN_RULES[HOST_AWAY].url);

// 2) 홈경기 → 자기팀 예매처
const home = getNextTicketOpen([{ date: "20260601", homeTeamId: HOST_HOME, isAway: false, opponentName: "상대" }], now);
ck("홈경기 isAway=false", !!home && home.isAway === false);
ck("홈경기 예매처=자기팀", !!home && home.provider === TICKET_OPEN_RULES[HOST_HOME].provider);

// 3) 홈+원정 동시 → 더 먼저 오픈되는 경기 선택
const both = getNextTicketOpen([
  { date: "20260701", homeTeamId: HOST_HOME, isAway: false },
  { date: "20260601", homeTeamId: HOST_AWAY, isAway: true },
], now);
ck("홈+원정 중 최단오픈(6/1 원정) 선택", !!both && both.gameDate === "20260601" && both.isAway === true);

// 4) 빈 목록 → null
ck("빈 목록 → null", getNextTicketOpen([], now) === null);

// 5) 이미 지난 경기만 → null
ck("과거 경기만 → null", getNextTicketOpen([{ date: "20251231", homeTeamId: HOST_HOME }], now) === null);

console.log(`\n예매 오픈 스모크: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
