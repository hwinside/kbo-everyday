/**
 * Regression smoke — pitch-by-pitch 어댑터 `parseNaverPitch` (2026-07-25).
 *
 * Why
 * ---
 * 네이버 relay `type:1`(투구)를 소스 무관 `PitchDetail`로 변환하는 격리 어댑터.
 * 삼순 리뷰 실측(종료 9경기 2,726구)에서 확인된 예외를 회귀로 고정한다:
 *   - 원문 `pitchResult` code 의미 불안정(실측 H=타격) → 색상 카테고리는 text 파생.
 *   - 사구 마지막 공/자동고의4구/대타 교체는 투구행이 아예 없거나 text 없음 → null(생략).
 *   - `V`(번트헛스윙) 등 신규 pitchResult는 text 기반이라 enum 확장 불요.
 *
 * Assertions
 * ----------
 *   T1  정상 투구: "3구 헛스윙"/슬라이더/145 → num3·stuff·speed·kind=strike.
 *   T2  타격(인플레이): "1구 타격"/H → kind=inplay (code H를 헛스윙으로 오분류하지 않음).
 *   T3  볼: "2구 볼" → kind=ball.
 *   T4  파울: "4구 파울" → kind=foul.
 *   T5  번트헛스윙(V): "2구 번트헛스윙" → kind=strike (스윙 키워드).
 *   T6  구속/구종 누락: speed/stuff 없음 → speed=0·stuff="" 이지만 pitch는 유지(fail-safe).
 *   T7  자동고의4구/빈 text: text="" → null.
 *   T8  type!==1: 결과행(type:13) → null.
 *   T9  currentGameState → count{ball,strike,out} 파싱.
 *   T10 접두 "N구 " 제거: resultText에 "3구" 접두 없음.
 */

import { parseNaverPitch, type NaverPitchOption } from "@/lib/game/pitch-provider";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// T1
const t1 = parseNaverPitch({ type: 1, text: "3구 헛스윙", pitchNum: 3, stuff: "슬라이더", speed: "145", pitchResult: "H" });
check("T1 정상 투구 num/stuff/speed", !!t1 && t1.num === 3 && t1.stuff === "슬라이더" && t1.speed === 145, JSON.stringify(t1));
check("T1 헛스윙 kind=strike", t1?.kind === "strike", t1?.kind);
check("T1 resultText 접두제거", t1?.resultText === "헛스윙", t1?.resultText);

// T2 — 실측: "타격" pitchResult=H
const t2 = parseNaverPitch({ type: 1, text: "1구 타격", pitchNum: 1, stuff: "슬라이더", speed: "145", pitchResult: "H" });
check("T2 타격 kind=inplay (H 오분류 방지)", t2?.kind === "inplay", t2?.kind);

// T3
const t3 = parseNaverPitch({ type: 1, text: "2구 볼", pitchNum: 2, stuff: "포크", speed: "132", pitchResult: "B" });
check("T3 볼 kind=ball", t3?.kind === "ball", t3?.kind);

// T4
const t4 = parseNaverPitch({ type: 1, text: "4구 파울", pitchNum: 4, stuff: "직구", speed: "150", pitchResult: "F" });
check("T4 파울 kind=foul", t4?.kind === "foul", t4?.kind);

// T5 — 번트헛스윙 V (enum 확장 없이 text 기반)
const t5 = parseNaverPitch({ type: 1, text: "2구 번트헛스윙", pitchNum: 2, stuff: "커브", speed: "120", pitchResult: "V" });
check("T5 번트헛스윙(V) kind=strike", t5?.kind === "strike", t5?.kind);

// T6 — 구속/구종 누락 fail-safe
const t6 = parseNaverPitch({ type: 1, text: "1구 볼", pitchNum: 1 });
check("T6 구속누락 speed=0 유지", !!t6 && t6.speed === 0 && t6.stuff === "", JSON.stringify(t6));

// T7 — 빈 text (자동고의4구/교체) → null
const t7 = parseNaverPitch({ type: 1, text: "", pitchNum: 0 });
check("T7 빈 text → null", t7 === null);

// T8 — 결과행(type 13) → null
const t8 = parseNaverPitch({ type: 13, text: "홍창기 : 우익수 앞 1루타" } as NaverPitchOption);
check("T8 type!==1 → null", t8 === null);

// T9 — currentGameState → count
const t9 = parseNaverPitch({ type: 1, text: "3구 스트라이크", pitchNum: 3, stuff: "직구", speed: "148", currentGameState: { ball: "1", strike: "2", out: "1" } });
check("T9 count 파싱", !!t9?.count && t9.count.ball === 1 && t9.count.strike === 2 && t9.count.out === 1, JSON.stringify(t9?.count));

// T10 — 접두 제거 재확인
check("T10 resultText에 '3구' 없음", t9?.resultText === "스트라이크", t9?.resultText);

// pendingAtBat 누적 시뮬레이션 (route.ts parseInningRelays 로직 재현)
const atBatOpts: NaverPitchOption[] = [
  { type: 8, text: "5번타자 한준수" },
  { type: 1, text: "1구 볼", pitchNum: 1, stuff: "슬라이더", speed: "145" },
  { type: 1, text: "2구 헛스윙", pitchNum: 2, stuff: "포크", speed: "132" },
  { type: 1, text: "3구 타격", pitchNum: 3, stuff: "직구", speed: "150" },
  { type: 13, text: "한준수 : 2루수 라인드라이브 아웃" },
];
const pitches = atBatOpts.map(parseNaverPitch).filter((p): p is NonNullable<typeof p> => p !== null);
check("A1 타석 투구 누적 3개", pitches.length === 3, `${pitches.length}`);
check("A1 순서 보존(1→2→3구)", pitches[0].num === 1 && pitches[2].num === 3);

console.log(`\npitch-parser-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
