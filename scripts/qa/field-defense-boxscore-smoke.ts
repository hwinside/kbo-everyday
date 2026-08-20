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
import { mergeNaverSubPositions, hasPureSubPositions } from "../../src/lib/utils/sub-position-merge";
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

// ── 케이스 5: 실제 제보 경기(20260728KTNC0) 운영 원문 배열 순서 그대로 ──
// 삼순 NO-GO(P0): BoxScore 배열은 전역 시간순이 아니라 *타순별 그룹 순서*.
//   · 1번 슬롯: 최원준(중우) → 장진혁(RF)   ← 현재 RF = 장진혁
//   · 3번 슬롯: 안현민(우) → 배정대(주중)  ← 현재 CF = 배정대, 안현민은 사라짐
// 포지션별 전체 스캔(구 버그)은 뒤쪽 3번 슬롯의 안현민(우→RF)가 1번 슬롯 장진혁을
// 덮어 RF=안현민을 낸다(false green). 타순별 마지막 entry를 먼저 골라야 RF=장진혁.
// 원문 행·타순·순서를 그대로 고정하고 최종 8명을 검증한다.
const awayLineupKT: LineupEntry[] = [
  lineupEntry(1, "CF", "최원준"),
  lineupEntry(2, "1B", "김현수"),
  lineupEntry(3, "RF", "안현민"),
  lineupEntry(4, "LF", "힐리어드"),
  lineupEntry(5, "DH", "장성우"),
  lineupEntry(6, "2B", "김상수"),
  lineupEntry(7, "3B", "허경민"),
  lineupEntry(8, "C", "한승택"),
  lineupEntry(9, "SS", "권동진"),
];
{
  // 2026-07-29 Production 캡처의 away lineup/boxScore 행·타순·포지션·순서 그대로.
  const awayBoxKT: BatterRecord[] = [
    batter(1, "중우", "최원준"),          // 1번 선발(중→우 이동), 이후 교체되어 사라짐
    batter(1, "RF", "장진혁", true),      // 1번 현재 = RF
    batter(2, "一", "김현수"),
    batter(2, "一", "오윤석", true),     // 2번 현재 = 1B
    batter(3, "우", "안현민"),          // 3번 선발(우→RF), 이후 교체되어 사라짐
    batter(3, "CF", "배정대", true),    // 3번 현재 = CF (대주→중견)
    batter(4, "좌", "힐리어드"),        // 4번 = LF
    batter(5, "지", "장성우"),
    batter(5, "DH", "김민혁", true),    // 5번 현재 = DH → 수비 제외
    batter(6, "二", "김상수"),
    batter(6, "타二", "류현인", true), // 6번 현재 = 2B (대타→2루)
    batter(7, "三", "허경민"),
    batter(7, "三", "장준원", true),   // 7번 현재 = 3B
    batter(8, "포", "한승택"),
    batter(8, "타", "이정훈", true),
    batter(8, "포", "조대현", true),   // 8번 현재 = C
    batter(9, "유", "권동진"),          // 9번 = SS
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineupKT, home: homeLineup },
    boxScore: { awayBatters: awayBoxKT, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const gameKTNC = { status: "live", inning: "9회말", awayScore: 3, homeScore: 5, awayTeamId: 12, homeTeamId: 9 };
  const s = deriveGameState(undefined, gameKTNC, detail).defensiveSide;
  console.log("[case5] 실제 제보 경기 운영 원문 배열(타순별 그룹) → 현재 수비 (원정 9회말)");
  check("C = 조대현", defenderAt(s, "C") === "조대현", `got ${defenderAt(s, "C")}`);
  check("1B = 오윤석 (一, 김현수 아님)", defenderAt(s, "1B") === "오윤석", `got ${defenderAt(s, "1B")}`);
  check("2B = 류현인 (타二, 김상수 아님)", defenderAt(s, "2B") === "류현인", `got ${defenderAt(s, "2B")}`);
  check("3B = 장준원 (三, 허경민 아님)", defenderAt(s, "3B") === "장준원", `got ${defenderAt(s, "3B")}`);
  check("SS = 권동진 (유)", defenderAt(s, "SS") === "권동진", `got ${defenderAt(s, "SS")}`);
  check("LF = 힐리어드 (좌)", defenderAt(s, "LF") === "힐리어드", `got ${defenderAt(s, "LF")}`);
  check("CF = 배정대 (3번 슬롯 현재, 최원준/안현민 아님)", defenderAt(s, "CF") === "배정대", `got ${defenderAt(s, "CF")}`);
  check("RF = 장진혁 (1번 슬롯 현재, 안현민/최원준 아님)", defenderAt(s, "RF") === "장진혁", `got ${defenderAt(s, "RF")}`);
  check("수비수 정확히 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
  const positionsSeen = (s ?? []).map(d => d.position);
  check("포지션 중복 0", new Set(positionsSeen).size === positionsSeen.length, `got ${positionsSeen.join(",")}`);
  const names = (s ?? []).map(d => d.name);
  check("교체된 안현민 미포함", !names.includes("안현민"), `got ${names.join(",")}`);
  check("중간 이동 최원준 미포함", !names.includes("최원준"), `got ${names.join(",")}`);
}

// ── 케이스 6: normalizeFieldPosition 직접 검증 (투수/DH 제외 + 순수 대타 슬롯 상속) ──
{
  console.log("[case6] 투수·DH 제외 + 순수 대타는 빠진 선수 위치 상속");
  const box: BatterRecord[] = [
    batter(1, "투", "켈리"),      // 투수 → 제외
    batter(2, "지", "오지환"),    // 지명 → 제외 (선발 SS 최원준 슬롯이지만 지명은 상속 대상 아님)
    batter(3, "타", "이재원", true), // 순수 대타 → 선발 LF(안현민) 위치 상속
    batter(4, "포", "박동원"),    // C
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  check("C = 박동원", defenderAt(s, "C") === "박동원", `got ${defenderAt(s, "C")}`);
  check("투수 켈리 미포함", !(s ?? []).some(d => d.name === "켈리"));
  check("지명 오지환 미포함", !(s ?? []).some(d => d.name === "오지환"));
  check("순수 대타 이재원 = LF 상속(선발 안현민 슬롯)", defenderAt(s, "LF") === "이재원", `got ${defenderAt(s, "LF")}`);
}

// ── 케이스 7: 미확정 순수 타/주가 2명 이상 → 상속 금지(더블스위치 구분 불가), fail-empty 유지 ──
{
  console.log("[case7] 미확정 2명 → 추정 상속 금지 + stale 선발 억제");
  const box: BatterRecord[] = [
    batter(2, "SS", "최원준"),
    batter(2, "타", "대타", true),
    batter(3, "LF", "안현민"),
    batter(3, "주", "대주자", true),
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  check("미확정 2명 → SS 비움(추정 금지)", defenderAt(s, "SS") === undefined, `got ${defenderAt(s, "SS")}`);
  check("미확정 2명 → LF 비움(추정 금지)", defenderAt(s, "LF") === undefined, `got ${defenderAt(s, "LF")}`);
  check("교체된 최원준 미포함", !(s ?? []).some(d => d.name === "최원준"));
  check("교체된 안현민 미포함", !(s ?? []).some(d => d.name === "안현민"));
}

// ── 케이스 8: 선발 선수가 포지션 이동하면 옛 위치 fallback과 이름 중복을 막음 ──
{
  console.log("[case8] 포지션 이동 + 부분 BoxScore → 동일 선수 2포지션 방지");
  const box: BatterRecord[] = [
    batter(1, "중우", "박해민"), // 선발 CF였지만 현재 RF
    batter(6, "타", "대타", true), // 선발 RF 슬롯은 순수 대타로 종료
  ];
  const s = deriveGameState(undefined, game, makeDetail(box)).defensiveSide;
  const names = (s ?? []).map(d => d.name);
  check("RF = 박해민 (현재 위치)", defenderAt(s, "RF") === "박해민", `got ${defenderAt(s, "RF")}`);
  check("옛 CF 위치 미노출", defenderAt(s, "CF") === undefined, `got ${defenderAt(s, "CF")}`);
  check("선발 RF 홍창기 stale 미노출", !names.includes("홍창기"), `got ${names.join(",")}`);
  check("선수명 중복 0", new Set(names).size === names.length, `got ${names.join(",")}`);
}

// ── 케이스 9: 실제 제보 경기(20260812LGWO0) 운영 원문 — 순수 대/주가 끝까지 미갱신 ──
// 9회초 키움 수비: 2번 안치홍(1B)→김웅빈 '대', 7번 임병욱(CF)→최주환 '대'→박채울 '주'.
// KBO BoxScore가 경기 종료까지 두 교체 선수의 수비 위치를 갱신하지 않아
// 1B/CF가 빈 자리로 렌더된 실사고(2026-08-12 하린아빠 제보). 상속으로 채워져야 한다.
const homeLineupWO: LineupEntry[] = [
  lineupEntry(1, "2B", "서건창"),
  lineupEntry(2, "1B", "안치홍"),
  lineupEntry(3, "DH", "데이비슨"),
  lineupEntry(4, "RF", "박찬혁"),
  lineupEntry(5, "LF", "추재현"),
  lineupEntry(6, "C", "김건희"),
  lineupEntry(7, "CF", "임병욱"),
  lineupEntry(8, "SS", "권혁빈"),
  lineupEntry(9, "3B", "여동욱"),
];
// KBO 원문(순수 대/주 방치) — 매 케이스마다 fresh copy를 쓴다(merge가 mutate하므로).
function homeBoxWOKbo(): BatterRecord[] {
  return [
    batter(1, "二", "서건창"),
    batter(2, "一", "안치홍"),
    batter(2, "대", "김웅빈", true),   // 2번 현재 = 순수 대타, KBO가 수비 위치 미갱신
    batter(3, "DH", "데이비슨"),
    batter(4, "RF", "박찬혁"),
    batter(5, "LF", "추재현"),
    batter(6, "C", "김건희"),
    batter(7, "CF", "임병욱"),
    batter(7, "대", "최주환", true),   // 7번 중간 교체(대타)
    batter(7, "주", "박채울", true),   // 7번 현재 = 순수 대주, KBO가 수비 위치 미갱신
    batter(8, "SS", "권혁빈"),
    batter(9, "三", "여동욱"),
  ];
}
const gameWO = { status: "live", inning: "9회초", awayScore: 3, homeScore: 4, awayTeamId: 5, homeTeamId: 10 };
function detailWO(homeBatters: BatterRecord[]): GameDetailResponse {
  return {
    status: "live",
    lineup: { away: awayLineup, home: homeLineupWO },
    boxScore: { awayBatters: [], homeBatters, awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
}
{
  // 2026-08-12 22:38 Production 캡처(boxScoreSource=naver)의 선수별 복합 위치 그대로.
  const naverBoxWO: BatterRecord[] = [
    batter(1, "二", "서건창"),
    batter(2, "一", "안치홍"),
    batter(2, "타一", "김웅빈", true),  // Naver 원문: 타·1루 → 1B
    batter(3, "DH", "데이비슨"),
    batter(4, "RF", "박찬혁"),
    batter(5, "LF", "추재현"),
    batter(6, "C", "김건희"),
    batter(7, "CF", "임병욱"),
    batter(7, "타", "최주환", true),
    batter(7, "주중", "박채울", true),  // Naver 원문: 대주·중견 → CF
    batter(8, "SS", "권혁빈"),
    batter(9, "三", "여동욱"),
  ];
  const kboBox = { awayBatters: [] as BatterRecord[], homeBatters: homeBoxWOKbo(), awayPitchers: [], homePitchers: [] };
  const naverBox = { awayBatters: [] as BatterRecord[], homeBatters: naverBoxWO, awayPitchers: [], homePitchers: [] };
  console.log("[case9] 실제 제보 경기(20260812LGWO0): KBO 대/주 방치 → Naver 복합 위치 병합 → 1B/CF 복원");
  check("hasPureSubPositions: KBO 원문 감지", hasPureSubPositions(kboBox) === true);
  mergeNaverSubPositions(kboBox, naverBox);
  check("병합 후 김웅빈 position = 타一", kboBox.homeBatters.find(b => b.name === "김웅빈")?.position === "타一");
  check("병합 후 박채울 position = 주중", kboBox.homeBatters.find(b => b.name === "박채울")?.position === "주중");
  check("비교체 entry 무변경(안치홍 一 유지)", kboBox.homeBatters.find(b => b.name === "안치홍")?.position === "一");
  const s = deriveGameState(undefined, gameWO, detailWO(kboBox.homeBatters)).defensiveSide;
  check("1B = 김웅빈 (Naver 소스 진실)", defenderAt(s, "1B") === "김웅빈", `got ${defenderAt(s, "1B")}`);
  check("CF = 박채울 (Naver 소스 진실, 최주환 아님)", defenderAt(s, "CF") === "박채울", `got ${defenderAt(s, "CF")}`);
  check("교체된 안치홍 미포함", !(s ?? []).some(d => d.name === "안치홍"));
  check("교체된 임병욱 미포함", !(s ?? []).some(d => d.name === "임병욱"));
  check("중간 교체 최주환 미포함", !(s ?? []).some(d => d.name === "최주환"));
  check("수비수 정확히 8명", (s?.length ?? 0) === 8, `got ${s?.length}`);
  const positionsSeen = (s ?? []).map(d => d.position);
  check("포지션 중복 0", new Set(positionsSeen).size === positionsSeen.length, `got ${positionsSeen.join(",")}`);
  check("2B = 서건창", defenderAt(s, "2B") === "서건창", `got ${defenderAt(s, "2B")}`);
  check("DH 데이비슨 미포함", !(s ?? []).some(d => d.name === "데이비슨"));
}

// ── 케이스 10: 더블스위치(미확정 2명이 서로 위치 교환) — Naver 소스 진실이 이긴다 ──
// 김웅빈이 빠진 자리(1B)가 아니라 CF로, 박채울이 1B로 들어간 교환 시나리오.
// 추정 상속이면 둘 다 자기 타순의 옛 자리로 오배정되지만(8명·중복 0 통과하는 false
// green — 삼순 NO-GO 지적), 소스 병합은 선수별 위치를 쓰므로 올바르게 풀린다.
{
  const naverSwap: BatterRecord[] = [
    batter(2, "주중", "김웅빈", true),  // 교환: 김웅빈 → CF
    batter(7, "타一", "박채울", true),  // 교환: 박채울 → 1B
  ];
  const kboBox = { awayBatters: [] as BatterRecord[], homeBatters: homeBoxWOKbo(), awayPitchers: [], homePitchers: [] };
  const naverBox = { awayBatters: [] as BatterRecord[], homeBatters: naverSwap, awayPitchers: [], homePitchers: [] };
  mergeNaverSubPositions(kboBox, naverBox);
  const s = deriveGameState(undefined, gameWO, detailWO(kboBox.homeBatters)).defensiveSide;
  console.log("[case10] 더블스위치 교환 → Naver 선수별 위치로 올바르게 배정");
  check("CF = 김웅빈 (교환 반영, 옛 자리 1B 아님)", defenderAt(s, "CF") === "김웅빈", `got ${defenderAt(s, "CF")}`);
  check("1B = 박채울 (교환 반영, 옛 자리 CF 아님)", defenderAt(s, "1B") === "박채울", `got ${defenderAt(s, "1B")}`);
  check("수비수 8명·중복 0", (s?.length ?? 0) === 8 && new Set((s ?? []).map(d => d.position)).size === (s?.length ?? 0));
}

// ── 케이스 11: Naver 부재/부분 병합 — 다중 미확정은 추정 금지, 단일 미확정만 상속 ──
{
  // 11-a: Naver 전면 부재 → 미확정 2명 그대로 → 1B/CF 비움(오배정 금지).
  const sA = deriveGameState(undefined, gameWO, detailWO(homeBoxWOKbo())).defensiveSide;
  console.log("[case11] Naver 부재/부분 병합 폴백");
  check("11-a: 병합 없이 미확정 2명 → 1B 비움", defenderAt(sA, "1B") === undefined, `got ${defenderAt(sA, "1B")}`);
  check("11-a: 병합 없이 미확정 2명 → CF 비움", defenderAt(sA, "CF") === undefined, `got ${defenderAt(sA, "CF")}`);
  check("11-a: stale 안치홍·임병욱 미포함", !(sA ?? []).some(d => d.name === "안치홍" || d.name === "임병욱"));
  // 11-b: Naver가 한 명만 해소(김웅빈=타一) → 남은 미확정 1명(박채울)은 상속으로 CF 복원.
  const kboBoxB = { awayBatters: [] as BatterRecord[], homeBatters: homeBoxWOKbo(), awayPitchers: [], homePitchers: [] };
  const naverPartial = { awayBatters: [] as BatterRecord[], homeBatters: [batter(2, "타一", "김웅빈", true)], awayPitchers: [], homePitchers: [] };
  mergeNaverSubPositions(kboBoxB, naverPartial);
  const sB = deriveGameState(undefined, gameWO, detailWO(kboBoxB.homeBatters)).defensiveSide;
  check("11-b: 부분 병합 → 1B = 김웅빈(소스)", defenderAt(sB, "1B") === "김웅빈", `got ${defenderAt(sB, "1B")}`);
  check("11-b: 단일 미확정 박채울 = CF 상속", defenderAt(sB, "CF") === "박채울", `got ${defenderAt(sB, "CF")}`);
  // 11-c: Naver도 순수 대/주라면 병합 무효(fail-safe).
  const kboBoxC = { awayBatters: [] as BatterRecord[], homeBatters: homeBoxWOKbo(), awayPitchers: [], homePitchers: [] };
  const naverPure = { awayBatters: [] as BatterRecord[], homeBatters: [batter(2, "대", "김웅빈", true), batter(7, "주", "박채울", true)], awayPitchers: [], homePitchers: [] };
  mergeNaverSubPositions(kboBoxC, naverPure);
  check("11-c: Naver도 순수 대/주 → 병합 무효(김웅빈 '대' 유지)", kboBoxC.homeBatters.find(b => b.name === "김웅빈")?.position === "대");
}

// ── 케이스 12: 실제 제보 경기(20260820KTLG0) — 현재 선수 2명이 같은 포지션(二) 충돌 ──
// KBO·Naver 양쪽 모두 류현인 2B→3B 이동을 미갱신: 오윤석(5번 교체입) 二 + 류현인(6번
// 선발) 二, 三 공석. 구 동작 = 류현인 필드 탈락 + 3B 실종(하린아빠 제보 스크린샷).
// 신규 규칙 = 독립 신호 판별: fresh(본인 선발 슬롯과 다름/명단에 없음) 1명 + stale(선발
// 위치 그대로) 1명 + 빈자리 1개일 때만 fresh가 충돌 위치, stale이 빈자리 → 3B = 류현인.
const awayLineup0820: LineupEntry[] = [
  lineupEntry(1, "CF", "최원준"),
  lineupEntry(2, "1B", "김현수"),
  lineupEntry(3, "RF", "안현민"),
  lineupEntry(4, "LF", "힌리어드"),
  lineupEntry(5, "3B", "허경민"),
  lineupEntry(6, "2B", "류현인"),
  lineupEntry(7, "DH", "이정범"),
  lineupEntry(8, "C", "한승택"),
  lineupEntry(9, "SS", "권동진"),
];
function awayBox0820(): BatterRecord[] {
  // 2026-08-20 20:5x Production /api/game-detail 원문 행·타순·포지션·순서 그대로.
  return [
    batter(1, "CF", "최원준"),
    batter(2, "一", "김현수"),
    batter(3, "RF", "안현민"),
    batter(4, "LF", "힌리어드"),
    batter(5, "三", "허경민"),
    batter(5, "二", "오윤석", true),  // 5번 현재 = 2B
    batter(6, "二", "류현인"),        // 6번 현재 — 소스 미갱신으로 二 유지(실제는 3B)
    batter(7, "DH", "이정범"),
    batter(8, "C", "한승택"),
    batter(9, "SS", "권동진"),
    batter(9, "대", "김상수", true),  // 9번 현재 = 순수 대타 → SS 상속(기존 규칙)
  ];
}
const gameKTLG = { status: "live", inning: "5회말", awayScore: 1, homeScore: 3, awayTeamId: 3, homeTeamId: 1 };
{
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: homeLineup },
    boxScore: { awayBatters: awayBox0820(), homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case12] 실제 제보 경기(20260820KTLG0): 二 충돌 패자 1명 → 단일 빈자리 3B 배치");
  check("2B = 오윤석 (first-wins 유지)", defenderAt(s, "2B") === "오윤석", `got ${defenderAt(s, "2B")}`);
  check("3B = 류현인 (충돌 패자 배치, 허경민 아님)", defenderAt(s, "3B") === "류현인", `got ${defenderAt(s, "3B")}`);
  check("SS = 김상수 (대타 상속 비회귀)", defenderAt(s, "SS") === "김상수", `got ${defenderAt(s, "SS")}`);
  check("stale 허경민·권동진 미포함", !(s ?? []).some(d => d.name === "허경민" || d.name === "권동진"));
  check("수비수 8명 완성", (s?.length ?? 0) === 8, `got ${s?.length}`);
}

// ── 케이스 13: 충돌 패자 2명 → 추정 금지(fail-empty 유지) ──
{
  const box = awayBox0820();
  // 예술적 조작: 8번 한승택도 二로 미갱신된 상황 가정 → 패자 2명(류현인·한승택), 빈자리 2개(3B·C)
  const hans = box.find(b => b.name === "한승택")!;
  hans.position = "二";
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: homeLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case13] 충돌 패자 2명 → 추정 금지");
  check("3B 비움 (배치 안 함)", defenderAt(s, "3B") === undefined, `got ${defenderAt(s, "3B")}`);
  check("C 비움 (배치 안 함)", defenderAt(s, "C") === undefined, `got ${defenderAt(s, "C")}`);
}

// ── 케이스 15: 역순 타순 동형 — stale 선발이 더 앞 타순(first-wins 승자)여도 fresh가 이긴다 ──
// 삼순 NO-GO P0 반례: first-wins(배열 순서)로 승자를 정하면 타순이 반대일 때 두 선수가
// 뒤바뀝. 독립 신호(선발 슬롯 대비 위치 변경)로만 판별해야 양방향 동일 결과가 나온다.
const awayLineupRev: LineupEntry[] = [
  lineupEntry(1, "CF", "최원준"),
  lineupEntry(2, "1B", "김현수"),
  lineupEntry(3, "RF", "안현민"),
  lineupEntry(4, "LF", "힌리어드"),
  lineupEntry(5, "2B", "류현인"),   // 선발 2B가 교체 슬롯(6번)보다 앞 타순
  lineupEntry(6, "3B", "허경민"),
  lineupEntry(7, "DH", "이정범"),
  lineupEntry(8, "C", "한승택"),
  lineupEntry(9, "SS", "권동진"),
];
{
  const box: BatterRecord[] = [
    batter(1, "CF", "최원준"),
    batter(2, "一", "김현수"),
    batter(3, "RF", "안현민"),
    batter(4, "LF", "힌리어드"),
    batter(5, "二", "류현인"),        // stale-의심(선발 2B 그대로)이 first-wins 승자 위치
    batter(6, "三", "허경민"),
    batter(6, "二", "오윤석", true),   // fresh(교체 투입)가 뒤 타순
    batter(7, "DH", "이정범"),
    batter(8, "C", "한승택"),
    batter(9, "SS", "권동진"),
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineupRev, home: homeLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case15] 역순 타순 — fresh가 충돌 위치 획득(first-wins 교정), stale이 빈자리");
  check("2B = 오윤석 (fresh, first-wins 지지 아님)", defenderAt(s, "2B") === "오윤석", `got ${defenderAt(s, "2B")}`);
  check("3B = 류현인 (stale → 빈자리)", defenderAt(s, "3B") === "류현인", `got ${defenderAt(s, "3B")}`);
  check("수비수 8명 완성", (s?.length ?? 0) === 8, `got ${s?.length}`);
}

// ── 케이스 16: 양쪽 모두 fresh(교체 투입 2명 충돌) → 독립 신호 부재, 추정 금지 ──
{
  const box: BatterRecord[] = [
    batter(1, "CF", "최원준"),
    batter(2, "一", "김현수"),
    batter(3, "RF", "안현민"),
    batter(4, "LF", "힌리어드"),
    batter(5, "三", "허경민"),
    batter(5, "二", "오윤석", true),   // fresh 1 (3B 선발 슬롯 투입)
    batter(6, "二", "류현인"),
    batter(6, "二", "장준원", true),   // fresh 2 (2B 선발 슬롯 투입) — 둘 다 위치변경/신규
    batter(7, "DH", "이정범"),
    batter(8, "C", "한승택"),
    batter(9, "SS", "권동진"),
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: homeLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case16] 양쪽 모두 fresh → 배치 억제(fail-empty)");
  check("3B 비움 (추정 안 함)", defenderAt(s, "3B") === undefined, `got ${defenderAt(s, "3B")}`);
  check("2B는 소스 충실 first-wins 유지", defenderAt(s, "2B") === "오윤석", `got ${defenderAt(s, "2B")}`);
}

// ── 케이스 17: 양쪽 모두 stale(데이터 오염으로 선발 2B 2명) → 추정 금지 ──
{
  const corruptLineup: LineupEntry[] = awayLineup0820.map(e =>
    e.name === "허경민" ? lineupEntry(5, "2B", "허경민") : e,
  );
  const box: BatterRecord[] = [
    batter(1, "CF", "최원준"),
    batter(2, "一", "김현수"),
    batter(3, "RF", "안현민"),
    batter(4, "LF", "힌리어드"),
    batter(5, "二", "허경민"),          // stale 1 (선발 2B 그대로)
    batter(6, "二", "류현인"),          // stale 2 (선발 2B 그대로)
    batter(7, "DH", "이정범"),
    batter(8, "C", "한승택"),
    batter(9, "SS", "권동진"),
  ];
  const detail = {
    status: "live",
    lineup: { away: corruptLineup, home: homeLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case17] 양쪽 모두 stale → 배치 억제(fail-empty)");
  check("3B 비움 (추정 안 함)", defenderAt(s, "3B") === undefined, `got ${defenderAt(s, "3B")}`);
}

// ── 케이스 14: 패자 1명 + 빈자리 2개 → 추정 금지(fail-empty 유지) ──
{
  const box = awayBox0820().filter(b => b.name !== "한승택");
  // 8번(C 선발 한승택)을 순수 대타로 교체 → 미확정 2명(김상수·이준호) → 상속 불가 →
  // 빈자리가 C·SS·3B 다수 → 충돌 패자(류현인) 배치도 억제되는지 확인.
  box.push(batter(8, "C", "한승택"));
  box.push(batter(8, "대", "이준호", true));
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: homeLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail).defensiveSide;
  console.log("[case14] 미확정 2명 + 빈자리 다수 → 충돌 패자 배치 억제");
  check("3B 비움 (류현인 배치 안 함)", defenderAt(s, "3B") === undefined, `got ${defenderAt(s, "3B")}`);
  check("류현인 미포함", !(s ?? []).some(d => d.name === "류현인"));
}

// ── 케이스 18: 교체 타임라인(20260820KTLG0 실측 이벤트) — 미확정 2명 케이스를 소스 진실로 완성 ──
// boxScore만으로는 배정대 '주'·김상수 '대'(미확정 2명+빈자리 2개 → fail-empty)였던 상황을
// Naver textRelay 교체 공지 재생으로 8명 확정. 이벤트 문자열은 원문 그대로.
// route.ts 는 import 시 supabase admin 싱글톤을 즉시 생성한다(모듈 사이드이펙트).
// 파싱 순수함수만 검증하므로 더미 env 를 route import 전에 주입한다
// (pitch-inning-parser-smoke 와 동일 패턴 — 정적 import 는 호이스팅되므로 await import).
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.local";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";
// 이 파일은 tsx가 CJS로 변환하므로(상단 정적 import 구성) top-level await 불가 →
// env 주입 뒤 시점에 실행되는 require로 로드(정적 import는 호이스팅돼 env보다 먼저 돌아감).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseFieldingEvent, parseInningRelays } = require("../../src/app/api/game-relay/route") as typeof import("../../src/app/api/game-relay/route");
import type { NaverTextRelay, FieldingEvent } from "../../src/app/api/game-relay/route";

// 공격팀(LG) 라인업 — 수비팀과 이름이 겹치지 않게 분리(기존 homeLineup 픽스처는 최원준·
// 허경민 등을 공유해 양팀 동명이인 가드가 타임라인을 전체 폐기해버린다 — 가드가 실제로
// 동작한다는 방증이기도 하다. 동명이인 케이스 자체는 case22에서 명시적으로 검증).
const lgLineup0820: LineupEntry[] = [
  lineupEntry(1, "2B", "신민재"),
  lineupEntry(2, "CF", "박해민"),
  lineupEntry(3, "DH", "오스틴"),
  lineupEntry(4, "1B", "문정빈"),
  lineupEntry(5, "LF", "송찬의"),
  lineupEntry(6, "3B", "문보경"),
  lineupEntry(7, "SS", "오지환"),
  lineupEntry(8, "C", "박동원"),
  lineupEntry(9, "RF", "홍창기"),
];
const ktLineup0820: LineupEntry[] = [
  lineupEntry(1, "CF", "최원준"),
  lineupEntry(2, "1B", "김현수"),
  lineupEntry(3, "RF", "안현민"),
  lineupEntry(4, "LF", "힌리어드"),
  lineupEntry(5, "3B", "허경민"),
  lineupEntry(6, "2B", "류현인"),
  lineupEntry(7, "DH", "이정범"),
  lineupEntry(8, "C", "한승택"),
  lineupEntry(9, "SS", "권동진"),
];
const ktEvents0820raw = [
  "3루수 허경민 : 2루수 오윤석 (으)로 교체",
  "2루수 류현인 : 3루수(으)로 수비위치 변경",
  "5번타자 오윤석 : 대타 김민혁 (으)로 교체",
  "대타 김민혁 : 유격수 장준원 (으)로 교체",
  "유격수 권동진 : 대타 김상수 (으)로 교체",
  "유격수 김상수 : 2루수(으)로 수비위치 변경",
  "포수 한승택 : 포수 조대현 (으)로 교체",
  "좌익수 힌리어드 : 좌익수 장진혁 (으)로 교체",
  "1루주자 안현민 : 대주자 배정대 (으)로 교체",
  "대주자 배정대 : 중견수(으)로 수비위치 변경",
  "중견수 최원준 : 우익수(으)로 수비위치 변경",
  // 상대팀(LG)·투수 이벤트 — KT replay에서 무시되어야 함
  "3번타자 오스틴 : 대타 천성호 (으)로 교체",
  "투수 고영표 : 투수 주권 (으)로 교체",
];
const ktEvents0820: FieldingEvent[] = ktEvents0820raw
  .map(parseFieldingEvent)
  .filter((e): e is FieldingEvent => e !== null);
{
  check("[case18] 원문 13줄 전부 이벤트로 파싱됨", ktEvents0820.length === 13, `got ${ktEvents0820.length}`);
  // boxScore: 실측 형태(배정대 '주'·김상수 '대' 미갱신, 장준원 SS 등)
  const box: BatterRecord[] = [
    batter(1, "CF", "최원준"),
    batter(2, "一", "김현수"),
    batter(3, "우", "안현민"),
    batter(3, "주", "배정대", true),
    batter(4, "좌", "힌리어드"),
    batter(4, "좌", "장진혁", true),
    batter(5, "三", "허경민"),
    batter(5, "二", "오윤석", true),
    batter(5, "대", "김민혁", true),
    batter(5, "SS", "장준원", true),
    batter(6, "二", "류현인"),
    batter(7, "DH", "이정범"),
    batter(8, "C", "한승택"),
    batter(8, "C", "조대현", true),
    batter(9, "SS", "권동진"),
    batter(9, "대", "김상수", true),
  ];
  const detail = {
    status: "live",
    lineup: { away: ktLineup0820, home: lgLineup0820 },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const relayInnings = [{ fielding: ktEvents0820 }];
  const s = deriveGameState(undefined, gameKTLG, detail, relayInnings).defensiveSide;
  console.log("[case18] 교체 타임라인 재생 → 미확정 2명 케이스 소스 진실로 8명 완성");
  check("3B = 류현인", defenderAt(s, "3B") === "류현인", `got ${defenderAt(s, "3B")}`);
  check("2B = 김상수 (대타→SS→2B 체인)", defenderAt(s, "2B") === "김상수", `got ${defenderAt(s, "2B")}`);
  check("SS = 장준원", defenderAt(s, "SS") === "장준원", `got ${defenderAt(s, "SS")}`);
  check("CF = 배정대 (대주→CF)", defenderAt(s, "CF") === "배정대", `got ${defenderAt(s, "CF")}`);
  check("RF = 최원준 (CF→RF 이동)", defenderAt(s, "RF") === "최원준", `got ${defenderAt(s, "RF")}`);
  check("LF = 장진혁", defenderAt(s, "LF") === "장진혁", `got ${defenderAt(s, "LF")}`);
  check("C = 조대현", defenderAt(s, "C") === "조대현", `got ${defenderAt(s, "C")}`);
  check("1B = 김현수 (무이벤트 유지)", defenderAt(s, "1B") === "김현수", `got ${defenderAt(s, "1B")}`);
  check("수비수 8명 완성", (s?.length ?? 0) === 8, `got ${s?.length}`);
  check("퇴장 허경민·권동진·오윤석 미포함", !(s ?? []).some(d => ["허경민","권동진","오윤석"].includes(d.name)));
}

// ── 케이스 19: 이벤트 결손(류현인 변경 누락) → 모순 위치는 타임라인 배정 없음(fail-close 후 기존 로직) ──
{
  const events = [
    parseFieldingEvent("3루수 허경민 : 2루수 오윤석 (으)로 교체")!,
    // "2루수 류현인 : 3루수 변경" 이벤트가 안 온 상황 → 오윤석·류현인 둘 다 2B → 모순
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: lgLineup0820 },
    boxScore: { awayBatters: awayBox0820(), homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail, [{ fielding: events }]).defensiveSide;
  console.log("[case19] 이벤트 결손 → 모순 위치 fail-close, 기존(case12) 경로 유지");
  // 타임라인 2B 모순 → 타임라인 미배정 → 기존 독립신호 규칙(case12)이 그대로 동작
  check("2B = 오윤석 (기존 규칙)", defenderAt(s, "2B") === "오윤석", `got ${defenderAt(s, "2B")}`);
  check("3B = 류현인 (기존 독립신호 규칙)", defenderAt(s, "3B") === "류현인", `got ${defenderAt(s, "3B")}`);
}

// ── 케이스 20: stale 타임라인 교차검증 — 타임라인이 지목한 선수가 boxScore상 이미 퇴장 → 불신 ──
{
  // 타임라인은 "허경민 3B 유지"를 말하지만(이벤트 1개만 도착한 오래된 relay),
  // boxScore는 허경민 퇴장(5번 현재=오윤석)을 안다 → 타임라인 배정 무시.
  const events = [
    parseFieldingEvent("유격수 권동진 : 대타 김상수 (으)로 교체")!, // 허경민 이벤트는 유실된 상황
  ];
  const detail = {
    status: "live",
    lineup: { away: awayLineup0820, home: lgLineup0820 },
    boxScore: { awayBatters: awayBox0820(), homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail, [{ fielding: events }]).defensiveSide;
  console.log("[case20] 타임라인 결손 + 퇴장 교차검증");
  // 허경민은 타임라인상 3B로 남아있지만 boxScore상 퇴장 → 3B는 기존 규칙(류현인)로
  check("3B ≠ 허경민 (퇴장 교차검증)", defenderAt(s, "3B") !== "허경민", `got ${defenderAt(s, "3B")}`);
  check("SS = 김상수 (타임라인 재생... 미배정이므로 기존 상속 규칙)", defenderAt(s, "SS") === "김상수", `got ${defenderAt(s, "SS")}`);
}

// ── 케이스 21: production parseInningRelays가 교체 공지를 inning.fielding으로 구조화 ──
{
  const textRelays: NaverTextRelay[] = [
    // reverse-chronological 입력(원본 API 순서) — 파서가 flip 함
    {
      title: "3번타자 오스틴", titleStyle: "8",
      // textOptions는 relay 항목 내에서 시간순(파서의 pendingPitches 소비와 동일 가정).
      textOptions: [
        { seqno: 1, type: 2, text: "3루수 허경민 : 2루수 오윤석 (으)로 교체" },
        { seqno: 2, type: 2, text: "2루수 류현인 : 3루수(으)로 수비위치 변경" },
      ],
    },
    { title: "5회말 LG 공격", titleStyle: "0" },
  ];
  const innings = parseInningRelays(textRelays);
  console.log("[case21] parseInningRelays → fielding 구조화");
  check("이닝 1개 파싱", innings.length === 1, `got ${innings.length}`);
  const f = innings[0]?.fielding ?? [];
  check("fielding 이벤트 2개", f.length === 2, `got ${f.length}`);
  check("replace 구조화", f[0]?.kind === "replace" && (f[0] as {inName:string}).inName === "오윤석");
  check("reposition 구조화", f[1]?.kind === "reposition" && (f[1] as {toPosKr:string}).toPosKr === "3루수");
  // 패턴 밖 텍스트·공백 이름 가드
  check("외국인 공백 이름 파싱", (() => {
    const e = parseFieldingEvent("좌익수 밴 헤켄 : 좌익수 장진혁 (으)로 교체");
    return e?.kind === "replace" && e.outName === "밴 헤켄";
  })());
  check("비패턴 텍스트 null", parseFieldingEvent("류현인 : 중견수 플라이 아웃") === null);
  check("홈인 텍스트 null", parseFieldingEvent("3루주자 장준원 : 홈인") === null);
}

// ── 케이스 22: 양팀 동명이인 — 상대팀 교체 이벤트가 수비 맵을 바꾸면 안 된다(삼순 P0) ──
// 수비팀(KT)과 공격팀(LG) 양쪽에 '김민준'이 있는 상황에서 상대팀의
// "우익수 김민준 : 대타 홍길동 교체"가 평탄화된 이벤트로 들어오면, 귀속을 증명할 수
// 없으므로 *타임라인 전체 폐기* → 기존(legacy) 결과 그대로가 계약이다.
{
  const dupLineup: LineupEntry[] = [
    lineupEntry(1, "CF", "최원준"),
    lineupEntry(2, "1B", "김현수"),
    lineupEntry(3, "RF", "김민준"), // 수비팀 RF 김민준 (공격팀에도 동명이인)
    lineupEntry(4, "LF", "힌리어드"),
    lineupEntry(5, "3B", "허경민"),
    lineupEntry(6, "2B", "류현인"),
    lineupEntry(7, "DH", "이정범"),
    lineupEntry(8, "C", "한승택"),
    lineupEntry(9, "SS", "권동진"),
  ];
  // 공격팀(home) 라인업에 동명이인 김민준 포함
  const oppLineup: LineupEntry[] = [
    lineupEntry(1, "CF", "박해민"),
    lineupEntry(2, "RF", "김민준"), // 동명이인
    lineupEntry(3, "DH", "오스틴"),
  ];
  const box: BatterRecord[] = [
    batter(3, "RF", "김민준"),
    batter(6, "二", "류현인"),
  ];
  const events = [
    // 실제로는 상대팀(LG) 김민준 교체지만 평탄화 이벤트엔 팀 정보가 없다
    parseFieldingEvent("우익수 김민준 : 대타 홍길동 (으)로 교체")!,
    // 유효했을 이벤트(수비팀 류현인 이동)도 같이 있지만 전체 폐기되어야 함
    parseFieldingEvent("2루수 류현인 : 3루수(으)로 수비위치 변경")!,
  ];
  const detail = {
    status: "live",
    lineup: { away: dupLineup, home: oppLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail, [{ fielding: events }]).defensiveSide;
  console.log("[case22] 양팀 동명이인 주체 이벤트 → 타임라인 전체 폐기(fail-close)");
  check("RF = 김민준 유지 (상대 교체가 수비팀을 지우지 않음)", defenderAt(s, "RF") === "김민준", `got ${defenderAt(s, "RF")}`);
  check("홍길동 미포함 (상대 선수 필드 진입 차단)", !(s ?? []).some(d => d.name === "홍길동"));
  check("3B = 허경민 (타임라인 폐기 → legacy 유지, 류현인 이동 미적용)", defenderAt(s, "3B") === "허경민", `got ${defenderAt(s, "3B")}`);
  check("2B = 류현인 (legacy)", defenderAt(s, "2B") === "류현인", `got ${defenderAt(s, "2B")}`);
}

// ── 케이스 23: 동명이인이 있어도 *이벤트 주체가 아니면* 타임라인 정상 동작 ──
{
  const dupLineup: LineupEntry[] = [
    lineupEntry(1, "CF", "최원준"),
    lineupEntry(2, "1B", "김현수"),
    lineupEntry(3, "RF", "김민준"), // 동명이인 존재하지만 이벤트 주체 아님
    lineupEntry(4, "LF", "힌리어드"),
    lineupEntry(5, "3B", "허경민"),
    lineupEntry(6, "2B", "류현인"),
    lineupEntry(7, "DH", "이정범"),
    lineupEntry(8, "C", "한승택"),
    lineupEntry(9, "SS", "권동진"),
  ];
  const oppLineup: LineupEntry[] = [
    lineupEntry(1, "CF", "박해민"),
    lineupEntry(2, "RF", "김민준"),
  ];
  const box: BatterRecord[] = [batter(6, "二", "류현인")];
  // 현실 순서: 허경민이 먼저 교체로 빠져야 류현인 3B 이동이 무모순(미교체면 3B 2명 모순로 그 위치 fail-close되는 것이 계약).
  const events = [
    parseFieldingEvent("3루수 허경민 : 2루수 오윤석 (으)로 교체")!,
    parseFieldingEvent("2루수 류현인 : 3루수(으)로 수비위치 변경")!,
  ];
  const detail = {
    status: "live",
    lineup: { away: dupLineup, home: oppLineup },
    boxScore: { awayBatters: box, homeBatters: [], awayPitchers: [], homePitchers: [] },
  } as unknown as GameDetailResponse;
  const s = deriveGameState(undefined, gameKTLG, detail, [{ fielding: events }]).defensiveSide;
  console.log("[case23] 동명이인 존재 + 주체 무관 → 타임라인 정상 적용");
  check("3B = 류현인 (타임라인 적용)", defenderAt(s, "3B") === "류현인", `got ${defenderAt(s, "3B")}`);
  check("2B = 오윤석 (교체 진입)", defenderAt(s, "2B") === "오윤석", `got ${defenderAt(s, "2B")}`);
  check("RF = 김민준 유지", defenderAt(s, "RF") === "김민준", `got ${defenderAt(s, "RF")}`);
}

console.log(`\n[field-defense-boxscore] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
