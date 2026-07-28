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

// ── 케이스 5: 실제 제보 경기(20260728KTNC0) raw 약어 정규화 ──
// 삼순 리뷰: Naver fallback BoxScore는 원시 약어(一/二/三, 타二, 중우/주우/주중)를
// 그대로 반환. exact match만 하면 제보 핵심 4명이 미반영됨.
// 원정(KT) 9회말 수비, 최종 8명 검증. (배열 뒤가 나중 = 현재 수비수)
{
  const awayBoxKT: BatterRecord[] = [
    batter(5, "一", "김현수"),
    batter(5, "一", "오윤석", true),   // 1B 최종
    batter(6, "二", "김상수"),
    batter(6, "타二", "류현인", true), // 2B 최종 (대타→2루)
    batter(4, "三", "허경민"),
    batter(4, "三", "장준원", true),   // 3B 최종
    batter(8, "RF", "안현민"),
    batter(8, "중우", "최원준", true), // 중간 이동 (최종 아님)
    batter(8, "주우", "장진혁", true), // RF 최종 (대주→우익)
    batter(1, "중", "박민석"),
    batter(1, "주중", "배정대", true), // CF 최종 (대주→중견)
    batter(2, "포", "조대현"),          // C
    batter(3, "유", "권동진"),          // SS
    batter(7, "좌", "힐리어드"),        // LF
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineup, home: homeLineup },
    boxScore: { awayBatters: awayBoxKT, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const gameKTNC = { status: "live", inning: "9회말", awayScore: 3, homeScore: 5, awayTeamId: 12, homeTeamId: 9 };
  const s = deriveGameState(undefined, gameKTNC, detail).defensiveSide;
  console.log("[case5] 실제 제보 경기 raw 약어 정규화 (원정 9회말 수비)");
  check("C = 조대현", defenderAt(s, "C") === "조대현", `got ${defenderAt(s, "C")}`);
  check("1B = 오윤석 (一, 김현수 아님)", defenderAt(s, "1B") === "오윤석", `got ${defenderAt(s, "1B")}`);
  check("2B = 류현인 (타二, 김상수 아님)", defenderAt(s, "2B") === "류현인", `got ${defenderAt(s, "2B")}`);
  check("3B = 장준원 (三, 허경민 아님)", defenderAt(s, "3B") === "장준원", `got ${defenderAt(s, "3B")}`);
  check("SS = 권동진 (유)", defenderAt(s, "SS") === "권동진", `got ${defenderAt(s, "SS")}`);
  check("LF = 힐리어드 (좌)", defenderAt(s, "LF") === "힐리어드", `got ${defenderAt(s, "LF")}`);
  check("CF = 배정대 (주중, 박민석 아님)", defenderAt(s, "CF") === "배정대", `got ${defenderAt(s, "CF")}`);
  check("RF = 장진혁 (주우, 안현민/최원준 아님)", defenderAt(s, "RF") === "장진혁", `got ${defenderAt(s, "RF")}`);
  check("수비수 정확히 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
  const positionsSeen = (s ?? []).map(d => d.position);
  check("포지션 중복 0", new Set(positionsSeen).size === positionsSeen.length, `got ${positionsSeen.join(",")}`);
  const names = (s ?? []).map(d => d.name);
  check("중간 이동 최원준 미포함", !names.includes("최원준"), `got ${names.join(",")}`);
}

// ── 케이스 6: normalizeFieldPosition 직접 검증 (투수/DH/순수 대타 제외) ──
{
  console.log("[case6] 투수·DH·순수 대타는 수비 그림에서 제외");
  const box: BatterRecord[] = [
    batter(1, "투", "켈리"),      // 투수 → 제외
    batter(2, "지", "오지환"),    // 지명 → 제외
    batter(3, "타", "이재원", true), // 순수 대타(수비 미정) → 제외
    batter(4, "포", "박동원"),    // C
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  check("C = 박동원", defenderAt(s, "C") === "박동원", `got ${defenderAt(s, "C")}`);
  check("투수 켈리 미포함", !(s ?? []).some(d => d.name === "켈리"));
  check("지명 오지환 미포함", !(s ?? []).some(d => d.name === "오지환"));
  check("순수 대타 이재원 미포함", !(s ?? []).some(d => d.name === "이재원"));
}

console.log(`\n[field-defense-boxscore] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
