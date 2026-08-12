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

console.log(`\n[field-defense-boxscore] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
