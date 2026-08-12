// player-stats-parser-smoke — /api/player-stats 파서의 fail-close 실행 검증.
// 계약(삼순 #1166 2차 NO-GO #2): 부분/비정상 HTML(테이블 부재·t1 누락·필수 열 미달)은 throw,
// 명시적 '기록이 없습니다.'만 null, 정상 HTML은 값이 정확히 매핑되어야 한다.
// truncated fixture가 throw 하지 않으면 이 smoke가 RED — 0으로 오염된 성공 응답이 60초 엣지캐시되는 회귀 차단.
import { parsePlayerStats } from "../../src/lib/kbo/player-stats-parser";

function tbody(cells: string[]): string {
  return `<tbody><tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr></tbody>`;
}

const PITCHER_T0 = ["LG", "2.31", "20", "0", "0", "10", "3", "0", "0", "0.769", "480", "1800", "120 1/3", "98", "15", "2", "8"];
const PITCHER_T1 = ["3", "4", "28", "1", "131", "2", "0", "35", "31", "0", "1.05", "0.221", "12"];
const BATTER_T0 = ["삼성", "0.312", "110", "480", "420", "70", "131", "25", "2", "18", "214", "85", "5", "2", "0", "6"];
const BATTER_T1 = ["52", "3", "6", "78", "9", "0.510", "0.398", "4", "0.714", "38", "0.908", "0.325", "0.290"];

const failures: string[] = [];
function expectThrow(name: string, fn: () => unknown, needle: string) {
  try {
    fn();
    failures.push(`${name}: throw 기대했으나 성공 반환`);
  } catch (e) {
    if (!(e as Error).message.includes(needle)) failures.push(`${name}: 예상 밖 에러 — ${(e as Error).message}`);
  }
}

// 1) 정상 투수 HTML → 값 매핑
{
  const stats = parsePlayerStats(tbody(PITCHER_T0) + tbody(PITCHER_T1), true);
  if (!stats || !("era" in stats)) failures.push("정상 투수: null/타입 오류");
  else {
    if (stats.era !== "2.31" || stats.wins !== 10 || stats.so !== 131 || stats.whip !== "1.05" || stats.er !== 31) {
      failures.push(`정상 투수: 값 매핑 오류 — ${JSON.stringify(stats)}`);
    }
  }
}
// 2) 정상 타자 HTML → 값 매핑
{
  const stats = parsePlayerStats(tbody(BATTER_T0) + tbody(BATTER_T1), false);
  if (!stats || !("avg" in stats)) failures.push("정상 타자: null/타입 오류");
  else if (stats.avg !== "0.312" || stats.hr !== 18 || stats.bb !== 52 || stats.ops !== "0.908") {
    failures.push(`정상 타자: 값 매핑 오류 — ${JSON.stringify(stats)}`);
  }
}
// 3) 명시적 '기록 없음' → null (투수/타자)
if (parsePlayerStats(tbody(["기록이 없습니다."]) + tbody([]), true) !== null) failures.push("투수 기록없음: null 아님");
if (parsePlayerStats(tbody(["기록이 없습니다."]) + tbody([]), false) !== null) failures.push("타자 기록없음: null 아님");
// 4) 테이블 전무(비정상 HTML) → throw
expectThrow("투수 테이블 전무", () => parsePlayerStats("<html><body>error</body></html>", true), "tables missing");
expectThrow("타자 테이블 전무", () => parsePlayerStats("<html><body>error</body></html>", false), "tables missing");
// 5) t1 누락(부분 HTML) → throw — 종전엔 BB/SO/OPS 0으로 오염된 성공이 캐시됨
expectThrow("투수 t1 누락", () => parsePlayerStats(tbody(PITCHER_T0), true), "columns truncated");
expectThrow("타자 t1 누락", () => parsePlayerStats(tbody(BATTER_T0), false), "columns truncated");
// 6) t0 열 미달(잘린 행) → throw
expectThrow("투수 t0 truncated", () => parsePlayerStats(tbody(PITCHER_T0.slice(0, 10)) + tbody(PITCHER_T1), true), "columns truncated");
expectThrow("타자 t0 truncated", () => parsePlayerStats(tbody(BATTER_T0.slice(0, 10)) + tbody(BATTER_T1), false), "columns truncated");
// 7) t1 열 미달 → throw
expectThrow("투수 t1 truncated", () => parsePlayerStats(tbody(PITCHER_T0) + tbody(PITCHER_T1.slice(0, 5)), true), "columns truncated");
expectThrow("타자 t1 truncated", () => parsePlayerStats(tbody(BATTER_T0) + tbody(BATTER_T1.slice(0, 5)), false), "columns truncated");

if (failures.length > 0) {
  console.error(`player-stats-parser-smoke FAIL (${failures.length}건)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("player-stats-parser-smoke PASS — 정상 매핑 2 · 기록없음 null 2 · fail-close throw 8");
