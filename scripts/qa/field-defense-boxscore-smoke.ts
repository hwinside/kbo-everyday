/**
 * QA: 필드뷰 수비 위치(defensiveSide)가 BoxScore 교체 이력을 반영하는지 검증.
 *
 * 버그(건의함): 대타·수비교체 후 타순/투수는 바뀌는데 수비 위치 그림만 선발 선수
 * 그대로 남음. 원인 = defensiveSide가 선발 라인업만 보고 만들어졌기 때문.
 * 수정 = 각 포지션별로 BoxScore의 마지막(=현재) 선수를 쓰고, 없을 때만 선발 폴백.
 *
 * 실행: npx tsx scripts/qa/field-defense-boxscore-smoke.ts
 */
import { deriveGameState } from "../../src/lib/utils/game-derived";
import type { GameDetailResponse, LineupEntry, BatterRecord } from "../../src/lib/hooks/useGameDetail";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

function lineupEntry(order: number, position: string, name: string): LineupEntry {
  return { order, position, positionKr: position, name, war: 0, avg: ".300" };
}
function batter(order: number, position: string, name: string, isSubstitute = false): BatterRecord {
  return {
    order, position, positionFull: position, name,
    atBats: 0, hits: 0, runs: 0, rbi: 0, hr: 0, h2b: 0, h3b: 0, bb: 0, so: 0, sb: 0,
    avg: ".000", isSubstitute,
  };
}

// 홈팀 선발 라인업 (수비 8포지션 + 투수는 별도)
const homeLineup: LineupEntry[] = [
  lineupEntry(1, "CF", "박해민"),
  lineupEntry(2, "SS", "최원준"),
  lineupEntry(3, "LF", "안현민"),
  lineupEntry(4, "3B", "허경민"),
  lineupEntry(5, "1B", "김현수"),
  lineupEntry(6, "RF", "홍창기"),
  lineupEntry(7, "2B", "신민재"),
  lineupEntry(8, "C", "박동원"),
  lineupEntry(9, "DH", "오지환"),
];
const awayLineup: LineupEntry[] = [
  lineupEntry(1, "CF", "정수빈"),
  lineupEntry(2, "SS", "김재호"),
  lineupEntry(3, "C", "양의지"),
];

function makeDetail(homeBatters: BatterRecord[] | null): GameDetailResponse {
  return {
    status: "live",
    lineup: { away: awayLineup, home: homeLineup },
    boxScore: homeBatters
      ? { awayBatters: [], homeBatters, awayPitchers: [], homePitchers: [] }
      : null,
  } as unknown as GameDetailResponse;
}

const game = { status: "live", inning: "5회초", awayScore: 1, homeScore: 2, awayTeamId: 6, homeTeamId: 1 };
// 5회초 → 수비팀 = 홈(1)

function defenderAt(side: ReturnType<typeof deriveGameState>["defensiveSide"], pos: string): string | undefined {
  return side?.find(d => d.position === pos)?.name;
}

// ── 케이스 1: BoxScore에 교체 반영 (최원준 SS → 배정대 SS) ──
{
  const box: BatterRecord[] = [
    batter(1, "CF", "박해민"),
    batter(2, "SS", "최원준"),
    batter(2, "SS", "배정대", true), // 같은 타순 마지막 = 현재 SS
    batter(3, "LF", "안현민"),
    batter(3, "LF", "장진혁", true), // 좌익 교체
    batter(4, "3B", "허경민"),
    batter(4, "3B", "장준원", true),
    batter(5, "1B", "김현수"),
    batter(5, "1B", "오윤석", true),
    batter(6, "RF", "홍창기"),
    batter(7, "2B", "신민재"),
    batter(8, "C", "박동원"),
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  console.log("[case1] BoxScore 교체 반영");
  check("SS = 배정대 (최원준 아님)", defenderAt(s, "SS") === "배정대", `got ${defenderAt(s, "SS")}`);
  check("LF = 장진혁 (안현민 아님)", defenderAt(s, "LF") === "장진혁", `got ${defenderAt(s, "LF")}`);
  check("3B = 장준원 (허경민 아님)", defenderAt(s, "3B") === "장준원", `got ${defenderAt(s, "3B")}`);
  check("1B = 오윤석 (김현수 아님)", defenderAt(s, "1B") === "오윤석", `got ${defenderAt(s, "1B")}`);
  check("교체 없는 CF = 박해민 유지", defenderAt(s, "CF") === "박해민", `got ${defenderAt(s, "CF")}`);
  check("교체 없는 C = 박동원 유지", defenderAt(s, "C") === "박동원", `got ${defenderAt(s, "C")}`);
  check("투수는 수비목록에 없음", !s?.some(d => d.position === "P"));
  check("DH는 수비목록에 없음", !s?.some(d => d.position === "DH"));
  check("수비수 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
}

// ── 케이스 2: BoxScore 없음 → 선발 라인업 폴백 (기존 동작 유지) ──
{
  const s = deriveGameState(undefined, game, makeDetail(null)).defensiveSide;
  console.log("[case2] BoxScore 미수신 → 선발 폴백");
  check("SS = 최원준 (선발)", defenderAt(s, "SS") === "최원준", `got ${defenderAt(s, "SS")}`);
  check("1B = 김현수 (선발)", defenderAt(s, "1B") === "김현수", `got ${defenderAt(s, "1B")}`);
  check("수비수 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
}

// ── 케이스 3: BoxScore에 일부 포지션만 있음 → 나머지는 선발 폴백 ──
{
  const box: BatterRecord[] = [
    batter(2, "SS", "최원준"),
    batter(2, "SS", "배정대", true),
    // 나머지 포지션은 BoxScore에 없음
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  console.log("[case3] 부분 BoxScore → 포지션별 폴백");
  check("SS = 배정대 (BoxScore 교체)", defenderAt(s, "SS") === "배정대", `got ${defenderAt(s, "SS")}`);
  check("LF = 안현민 (선발 폴백)", defenderAt(s, "LF") === "안현민", `got ${defenderAt(s, "LF")}`);
  check("C = 박동원 (선발 폴백)", defenderAt(s, "C") === "박동원", `got ${defenderAt(s, "C")}`);
  check("수비수 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
}

// ── 케이스 4: 5회말 → 수비팀 = 원정(away) 라인업 사용 ──
{
  const gameBottom = { ...game, inning: "5회말" };
  const s = deriveGameState(undefined, gameBottom, makeDetail(null)).defensiveSide;
  console.log("[case4] 5회말 → 원정 수비");
  check("SS = 김재호 (원정 선발)", defenderAt(s, "SS") === "김재호", `got ${defenderAt(s, "SS")}`);
  check("CF = 정수빈 (원정 선발)", defenderAt(s, "CF") === "정수빈", `got ${defenderAt(s, "CF")}`);
}

console.log(`\n[field-defense-boxscore] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
