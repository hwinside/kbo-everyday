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

// ── T5: 진행 중 타석(terminal 없이 투구만 누적) → in-progress play 로 노출 ──
// 마지막 타석이 type:8 소개 + 투구 2개 뒤 terminal 없이 스트림 종료(라이브 현재 타석).
// parseInningRelays 는 이 타석을 inProgress:true 로 마지막 이닝에 노출해야 한다.
{
  const relaysLive: NaverTextRelay[] = [
    inningHeader,
    {
      title: "1번타자 최원준",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "1번타자 최원준", batterRecord: { name: "최원준" } as never },
        { seqno: 2, type: 1, text: "1구 헛스윙", pitchNum: 1, stuff: "직구", speed: "149", currentGameState: { ball: "0", strike: "1", out: "0" } },
        { seqno: 3, type: 1, text: "2구 볼", pitchNum: 2, stuff: "슬라이더", speed: "136", currentGameState: { ball: "1", strike: "1", out: "0" } },
        // terminal 없음 — 현재 진행 중 타석.
      ],
    },
  ];
  const innings = parse(relaysLive);
  const plays = innings[innings.length - 1]?.plays ?? [];
  const live = plays.find((p) => p.inProgress);
  check("T5 진행 중 타석 in-progress 노출", !!live && live.batterName === "최원준", JSON.stringify(plays.map((p) => ({ n: p.batterName, ip: p.inProgress }))));
  check("T5 진행 중 타석 투구 2구 누적", live?.pitches?.length === 2, `pitches=${live?.pitches?.length}`);
  check(
    "T5 진행 중 타석 마지막 투구 볼카운트 스냅샷(1-1)",
    live?.pitches?.[1]?.count?.ball === 1 && live?.pitches?.[1]?.count?.strike === 1,
    JSON.stringify(live?.pitches?.[1]?.count),
  );
}

// ── T6: 완료 타석(terminal 소비) 뒤엔 in-progress 잔여 없음 ──
{
  const relaysDone: NaverTextRelay[] = [
    inningHeader,
    {
      title: "2번타자 김도영",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "2번타자 김도영", batterRecord: { name: "김도영" } as never },
        { seqno: 2, type: 1, text: "1구 타격", pitchNum: 1, stuff: "포크", speed: "132", currentGameState: { ball: "0", strike: "0", out: "0" } },
        { seqno: 3, type: 13, text: "김도영 : 중견수 앞 안타" },
      ],
    },
  ];
  const innings = parse(relaysDone);
  const plays = innings[innings.length - 1]?.plays ?? [];
  check("T6 완료 타석 뒤 in-progress 잔여 0", plays.every((p) => !p.inProgress), JSON.stringify(plays.map((p) => p.inProgress)));
  check("T6 완료 타석은 정상 result 유지", plays[0]?.result === "중견수 앞 안타", plays[0]?.result);
}

// ── T7: 이닝 헤더가 pending 리셋 → 앞 이닝 잔여가 다음 이닝 in-progress 로 새지 않음 ──
{
  const relaysCross: NaverTextRelay[] = [
    { title: "1회초 LG 공격", titleStyle: "0" },
    {
      title: "9번타자 박동원",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "9번타자 박동원", batterRecord: { name: "박동원" } as never },
        { seqno: 2, type: 1, text: "1구 볼", pitchNum: 1, stuff: "직구", speed: "148", currentGameState: { ball: "1", strike: "0", out: "0" } },
        // terminal 없이 이닝 종료(스키마 변형) → 다음 이닝 헤더가 리셋해야.
      ],
    },
    { title: "1회말 KIA 공격", titleStyle: "0" },
    {
      title: "1번타자 최원준",
      titleStyle: "8",
      textOptions: [
        { seqno: 3, type: 8, text: "1번타자 최원준", batterRecord: { name: "최원준" } as never },
        { seqno: 4, type: 1, text: "1구 헛스윙", pitchNum: 1, stuff: "슬라이더", speed: "137", currentGameState: { ball: "0", strike: "1", out: "0" } },
      ],
    },
  ];
  const innings = parse(relaysCross);
  const last = innings[innings.length - 1];
  const live = last?.plays.find((p) => p.inProgress);
  check("T7 마지막 이닝 in-progress 는 현재 이닝 타자(최원준)", live?.batterName === "최원준", JSON.stringify(innings.map((i) => ({ inn: i.inning, half: i.half, live: i.plays.filter((p) => p.inProgress).map((p) => p.batterName) }))));
  const firstInnLive = innings[0]?.plays.some((p) => p.inProgress);
  check("T7 앞 이닝(박동원)은 in-progress 로 새지 않음", firstInnLive === false, `firstInnLive=${firstInnLive}`);
}

// ── T8: 새 타자 소개 직후 투구 0구면 in-progress 미노출(다음 폴링 대기) ──
{
  const relaysZero: NaverTextRelay[] = [
    inningHeader,
    {
      title: "3번타자 나성범",
      titleStyle: "8",
      textOptions: [
        { seqno: 1, type: 8, text: "3번타자 나성범", batterRecord: { name: "나성범" } as never },
        // 아직 투구 없음(방금 타석 진입).
      ],
    },
  ];
  const innings = parse(relaysZero);
  const plays = innings[innings.length - 1]?.plays ?? [];
  check("T8 0구 진입 타석은 in-progress 미노출", plays.every((p) => !p.inProgress) && plays.length === 0, JSON.stringify(plays.map((p) => p.batterName)));
}

console.log(`\npitch-inning-parser-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
