/**
 * Regression smoke — production `parseInningRelays` (game-relay/route.ts) 타석 경계 고정.
 *
 * Why
 * ---
 * pitch-parser-smoke.ts 는 어댑터(`parseNaverPitch`) + 별도 map 시뮬레이션이라
 * production 파싱 루프의 `pendingPitches` 타석 경계 처리를 고정하지 못한다(삼순 리뷰).
 * 이 스모크는 실제 `parseInningRelays` 를 직접 호출해 다음을 회귀로 못박는다:
 *   - malformed terminal(빈/무구분자 result) 뒤 정상 타석에 앞 타석 투구가 섞이지 않음.
 *   - 새 타석 시작(type:8)에서 앞 타석 잔여 투구가 fail-closed reset 됨.
 *   - 정상 attach(타석별 투구 시퀀스) 는 그대로 유지.
 *
 * ⚠️ parseInningRelays 는 입력을 newest-first 로 가정하고 내부에서 reverse 한다.
 *    따라서 fixture 는 chronological 순서로 만든 뒤 `.reverse()` 해서 넘긴다.
 */

// route.ts 는 import 시 supabase admin 싱글톤을 즉시 생성한다(모듈 사이드이펙트).
// 파싱 순수함수만 검증하므로 실제 연결이 필요 없다 → 더미 env 를 route import 전에 주입.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.local";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";

import type { NaverTextRelay as _NaverTextRelay } from "@/app/api/game-relay/route";
type NaverTextRelay = _NaverTextRelay;

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

async function main() {
// route.ts 는 동적 import 로 로드(top-level await 미지원 cjs 회피). env 주입 후 로드되므로
// supabase admin 싱글톤이 더미 env 로 문제없이 생성된다(실제 호출 없음).
const { parseInningRelays } = await import("@/app/api/game-relay/route");

/** chronological relay 배열을 production 이 받는 newest-first 로 뒤집어 파싱. */
function parse(chronological: NaverTextRelay[]) {
  return parseInningRelays([...chronological].reverse());
}

const inningHeader: NaverTextRelay = { title: "3회말 KIA 공격", titleStyle: "0" };
const batterRecord = (name: string, batOrder: number) => ({
  name,
  batOrder,
  ab: 0,
  hit: 0,
  hr: 0,
  bb: 0,
  so: 0,
  rbi: 0,
  run: 0,
  pa: 0,
  todayHra: 0,
  seasonHra: 0,
  posName: "대타",
});

// ── T1: malformed terminal 뒤 정상 타석 오염 방지 (핵심 blocker) ──
// A 타석: type:8 소개 → 투구 2개 → terminal 이 malformed(구분자 없음) → continue.
// B 타석: type:8 소개 → 투구 1개 → 정상 terminal.
// B 결과 pitches 에 A 의 2구가 섞이면 안 되고, B 자신의 1구만 있어야 한다.
{
  const relaysAB: NaverTextRelay[] = [
    inningHeader,
    {
      title: "1번타자 최원준",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "1번타자 최원준" },
        { seqno: 2, type: 1, text: "1구 볼", pitchNum: 1, stuff: "직구", speed: "148" },
        { seqno: 3, type: 1, text: "2구 헛스윙", pitchNum: 2, stuff: "슬라이더", speed: "135" },
        // malformed terminal: " : " 구분자 없음 → 정상 result 아님 → continue.
        { seqno: 4, type: 13, text: "최원준 파울플라이 아웃(기록오류)" },
      ],
    },
    {
      title: "2번타자 김도영",
      titleStyle: "8",
      textOptions: [
        { seqno: 5, type: 8, text: "2번타자 김도영" },
        { seqno: 6, type: 1, text: "1구 타격", pitchNum: 1, stuff: "포크", speed: "132" },
        { seqno: 7, type: 13, text: "김도영 : 중견수 앞 안타" },
      ],
    },
  ];
  const innings = parse(relaysAB);
  const plays = innings[0]?.plays ?? [];
  // A 는 malformed terminal 이라 play 로 확정되지 않음(정상 result 아님) → plays 는 B 만.
  const kim = plays.find((p) => p.batterName === "김도영");
  check("T1 정상 타석(김도영) 확정", !!kim, JSON.stringify(plays.map((p) => p.batterName)));
  check(
    "T1 malformed 앞 타석 투구 미오염 (김도영 pitches=1)",
    kim?.pitches?.length === 1,
    `pitches=${JSON.stringify(kim?.pitches?.map((p) => p.num))}`,
  );
  check(
    "T1 김도영 pitches 는 자신의 1구만 (num=1)",
    kim?.pitches?.[0]?.num === 1 && kim?.pitches?.[0]?.resultText === "타격",
    JSON.stringify(kim?.pitches),
  );
}

// ── T2: 새 타석 경계(type:8)에서 잔여 투구 fail-closed reset ──
// A 타석에 terminal 자체가 아예 없이(스키마 변형) 다음 B 타석 type:8 가 옴.
// B terminal 의 pitches 에 A 투구가 섞이면 안 된다.
{
  const relaysNoTerminal: NaverTextRelay[] = [
    inningHeader,
    {
      title: "3번타자 나성범",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "3번타자 나성범" },
        { seqno: 2, type: 1, text: "1구 볼", pitchNum: 1, stuff: "직구", speed: "150" },
        { seqno: 3, type: 1, text: "2구 볼", pitchNum: 2, stuff: "직구", speed: "149" },
        // terminal 없음 (외부 relay 스키마 변형/누락 시뮬)
      ],
    },
    {
      title: "4번타자 한준수",
      titleStyle: "8",
      textOptions: [
        { seqno: 4, type: 8, text: "4번타자 한준수" },
        { seqno: 5, type: 1, text: "1구 헛스윙", pitchNum: 1, stuff: "커브", speed: "121" },
        { seqno: 6, type: 13, text: "한준수 : 삼진 아웃" },
      ],
    },
  ];
  const innings = parse(relaysNoTerminal);
  const han = innings[0]?.plays.find((p) => p.batterName === "한준수");
  check("T2 terminal 없는 앞 타석 뒤 정상 타석 확정", !!han);
  check(
    "T2 새 타석 경계 fail-closed reset (한준수 pitches=1)",
    han?.pitches?.length === 1,
    `pitches=${JSON.stringify(han?.pitches?.map((p) => p.num))}`,
  );
  check("T2 한준수 pitches 는 자신의 1구만", han?.pitches?.[0]?.resultText === "헛스윙", JSON.stringify(han?.pitches));
}

// ── T3: 정상 attach 회귀 (기능 보존) — 실경기 20260724WOHT0 3회 구조 재현 ──
{
  const relaysNormal: NaverTextRelay[] = [
    { title: "3회초 키움 공격", titleStyle: "0" },
    {
      title: "5번타자 한준수",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "5번타자 한준수" },
        { seqno: 2, type: 1, text: "1구 볼", pitchNum: 1, stuff: "직구", speed: "145" },
        { seqno: 3, type: 1, text: "2구 볼", pitchNum: 2, stuff: "슬라이더", speed: "135" },
        { seqno: 4, type: 1, text: "3구 타격", pitchNum: 3, stuff: "포크", speed: "132" },
        { seqno: 5, type: 13, text: "한준수 : 좌익수 플라이 아웃" },
      ],
    },
  ];
  const innings = parse(relaysNormal);
  const play = innings[0]?.plays[0];
  check("T3 정상 타석 확정", play?.batterName === "한준수", play?.batterName);
  check("T3 정상 attach 3구 유지", play?.pitches?.length === 3, `pitches=${play?.pitches?.length}`);
  check(
    "T3 투구 순서 보존 (1→2→3)",
    play?.pitches?.[0]?.num === 1 && play?.pitches?.[2]?.num === 3,
    JSON.stringify(play?.pitches?.map((p) => p.num)),
  );
}

// ── T4: 빈 batter terminal(구분자는 있으나 batter 공백) 뒤 정상 타석 오염 방지 ──
{
  const relaysEmptyBatter: NaverTextRelay[] = [
    inningHeader,
    {
      title: "6번타자 박찬호",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "6번타자 박찬호" },
        { seqno: 2, type: 1, text: "1구 파울", pitchNum: 1, stuff: "직구", speed: "147" },
        { seqno: 3, type: 1, text: "2구 파울", pitchNum: 2, stuff: "직구", speed: "146" },
        // 빈 batter: parts[0] 이 공백 → !batterName → continue (reset 은 이미 됨)
        { seqno: 4, type: 13, text: " : 우익수 뜬공 아웃" },
      ],
    },
    {
      title: "7번타자 오지환",
      titleStyle: "8",
      textOptions: [
        { seqno: 5, type: 8, text: "7번타자 오지환" },
        { seqno: 6, type: 1, text: "1구 볼", pitchNum: 1, stuff: "커브", speed: "120" },
        { seqno: 7, type: 13, text: "오지환 : 유격수 땅볼 아웃" },
      ],
    },
  ];
  const innings = parse(relaysEmptyBatter);
  const oh = innings[0]?.plays.find((p) => p.batterName === "오지환");
  check("T4 빈 batter terminal 뒤 정상 타석 확정", !!oh);
  check("T4 빈 batter 앞 타석 투구 미오염 (오지환 pitches=1)", oh?.pitches?.length === 1, JSON.stringify(oh?.pitches?.map((p) => p.num)));
}

// ── T5: 진행 중 타석 계약 — terminal 전 type:8 + pitches 를 currentAtBat 으로 반환 ──
{
  const innings = parse([
    inningHeader,
    {
      title: "4번타자 오스틴",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "4번타자 오스틴" },
        {
          seqno: 2,
          type: 1,
          text: "1구 스트라이크",
          pitchNum: 1,
          stuff: "직구",
          speed: "149",
          currentGameState: { ball: "0", strike: "1", out: "1" },
        },
        {
          seqno: 3,
          type: 1,
          text: "2구 볼",
          pitchNum: 2,
          stuff: "커브",
          speed: "126",
          currentGameState: { ball: "1", strike: "1", out: "1" },
        },
      ],
    },
  ]);
  const current = innings[0]?.currentAtBat;
  check("T5 진행 중 타자명 반환", current?.batterName === "오스틴", JSON.stringify(current));
  check("T5 진행 중 타순 반환", current?.batOrder === 4, JSON.stringify(current));
  check("T5 진행 중 투구 2개 순서 보존", current?.pitches.length === 2 && current.pitches[1]?.num === 2, JSON.stringify(current?.pitches));
  check("T5 최신 투구 후 B/S/O 보존", current?.pitches[1]?.count?.ball === 1 && current.pitches[1]?.count?.strike === 1 && current.pitches[1]?.count?.out === 1);
}

// ── T6: terminal 도달 시 currentAtBat 제거 + 완료 타석으로 단일 이동 ──
{
  const innings = parse([
    inningHeader,
    {
      title: "5번타자 문보경",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "5번타자 문보경" },
        { seqno: 2, type: 1, text: "1구 타격", pitchNum: 1, stuff: "직구", speed: "151" },
        { seqno: 3, type: 13, text: "문보경 : 우익수 앞 1루타" },
      ],
    },
  ]);
  check("T6 완료 후 currentAtBat 제거", innings[0]?.currentAtBat == null, JSON.stringify(innings[0]?.currentAtBat));
  check("T6 완료 타석 pitches 단일 귀속", innings[0]?.plays[0]?.pitches?.length === 1, JSON.stringify(innings[0]?.plays));
  check("T6 완료 타석 타순 유지", innings[0]?.plays[0]?.batOrder === 5, JSON.stringify(innings[0]?.plays[0]));
}

// ── T7: 새 type:8 경계가 진행 중 타석 identity/pitches 를 함께 교체 ──
{
  const innings = parse([
    inningHeader,
    {
      title: "6번타자 박동원",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "6번타자 박동원" },
        { seqno: 2, type: 1, text: "1구 파울", pitchNum: 1, stuff: "직구", speed: "147" },
      ],
    },
    {
      title: "대타 김현수",
      titleStyle: "8",
      textOptions: [
        { seqno: 3, type: 8, text: "대타 김현수", batterRecord: batterRecord("김현수", 6) },
        { seqno: 4, type: 1, text: "1구 볼", pitchNum: 1, stuff: "포크", speed: "132" },
      ],
    },
  ]);
  const current = innings[0]?.currentAtBat;
  check("T7 새 타자 identity로 교체", current?.batterName === "김현수", JSON.stringify(current));
  check("T7 대타가 원 batting-order slot 유지", current?.batOrder === 6, JSON.stringify(current));
  check("T7 앞 타석 투구 미오염", current?.pitches.length === 1 && current.pitches[0]?.stuff === "포크", JSON.stringify(current?.pitches));
}

// ── T8: 타순 미확정/비정상 값은 직전 타순을 오염시키지 않고 숨김 ──
{
  const innings = parse([
    inningHeader,
    {
      title: "9번타자 박해민",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "9번타자 박해민" },
        { seqno: 2, type: 1, text: "1구 파울", pitchNum: 1, stuff: "직구", speed: "146" },
      ],
    },
    {
      title: "대타 미확정선수",
      titleStyle: "8",
      textOptions: [
        { seqno: 3, type: 8, text: "대타 미확정선수", batterRecord: batterRecord("미확정선수", 10) },
        { seqno: 4, type: 1, text: "1구 볼", pitchNum: 1, stuff: "커브", speed: "121" },
      ],
    },
  ]);
  const current = innings[0]?.currentAtBat;
  check("T8 타순 미확정 타자 identity 유지", current?.batterName === "미확정선수", JSON.stringify(current));
  check("T8 비정상 타순 숨김", current?.batOrder == null, JSON.stringify(current));
}

// ── T9: 대타 완료 타석도 교체된 batting-order slot 유지 ──
{
  const innings = parse([
    inningHeader,
    {
      title: "대타 이천웅",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "대타 이천웅", batterRecord: batterRecord("이천웅", 7) },
        { seqno: 2, type: 1, text: "1구 타격", pitchNum: 1, stuff: "직구", speed: "145" },
        { seqno: 3, type: 13, text: "이천웅 : 중견수 앞 1루타" },
      ],
    },
  ]);
  const play = innings[0]?.plays[0];
  check("T9 대타 완료 타석 identity 유지", play?.batterName === "이천웅", JSON.stringify(play));
  check("T9 대타 완료 타석 slot 유지", play?.batOrder === 7, JSON.stringify(play));
}

console.log(`\npitch-inning-parser-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
