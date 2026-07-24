/**
 * Smoke/regression for standings AI 분석 streak 모순 가드
 * (hasStreakContradiction / stripContradictorySentences).
 *
 * Why
 * ---
 * 2026-07-25 하린아빠 prod 리포트: AI 순위 분석이 "롯데도 KT에 패했지만 3연승을
 * 이어갔다"라는 논리 모순 문장을 생성(Gemini 환각). 롯데는 KT에 패해 연승일 수 없고,
 * 데이터에도 3연승 근거가 없음. 후처리(sanitizeCopy)는 시점어만 제거해 못 걸렀다.
 * → 데이터에 명시된 연승/연패만 허용하고, 근거 없는 연승/연패 주장을 결정론적으로
 *   탐지·제거하는 가드를 추가. 이 스모크가 그 계약을 고정한다.
 *
 * 실행: npx tsx scripts/qa/standings-streak-guard-smoke.ts  (npm run qa:standings-streak-guard)
 */
import {
  hasStreakContradiction,
  stripContradictorySentences,
  sentenceFabricatesYears,
  renderStreakLabel,
} from "@/lib/analysis/streak-guard";
import type { StandingsSnapshot } from "@/lib/analysis/daily-delta";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// 팀 id → 짧은 이름
const teamNames = new Map<number, string>([
  [1, "삼성"],
  [2, "KT"],
  [3, "LG"],
  [4, "KIA"],
  [5, "두산"],
  [6, "한화"],
  [7, "NC"],
  [8, "SSG"],
  [9, "키움"],
  [10, "롯데"],
]);

// 7/24 경기 기준 실제 스냅샷(하린아빠 스크린샷 재현):
// 삼성 2연승, KT 8연승, LG 8연패, KIA 3연패, 두산 1연패, 한화 3연승, NC 1연패,
// SSG 3연승, 키움 1승(연승 끊고 시작), 롯데 1연패(KT에 5:4 패).
function snap(team_id: number, streak: string): StandingsSnapshot {
  return {
    date: "2026-07-25",
    team_id,
    rank: team_id,
    wins: 0,
    losses: 0,
    draws: 0,
    win_rate: 0,
    games_behind: 0,
    streak,
  } as StandingsSnapshot;
}

const snapshots: StandingsSnapshot[] = [
  snap(1, "2연승"),
  snap(2, "8연승"),
  snap(3, "8연패"),
  snap(4, "3연패"),
  snap(5, "1연패"),
  snap(6, "3연승"),
  snap(7, "1연패"),
  snap(8, "3연승"),
  snap(9, "1연승"),
  snap(10, "1연패"),
];

// === 모순 탐지: 반드시 true ===
ok(
  "repro: 롯데도 KT에 패했지만 3연승을 이어갔다 (모순)",
  hasStreakContradiction(
    "SSG는 NC를 7대3으로 제압하며 3연승을 달렸고, 롯데도 KT에 패했지만 3연승을 이어갔다.",
    snapshots,
    teamNames,
  ) === true,
);
ok(
  "패한 팀을 연승으로: 롯데가 4연승을 달렸다 (데이터=1연패)",
  hasStreakContradiction("롯데가 4연승을 달렸다.", snapshots, teamNames) === true,
);
ok(
  "이긴 팀을 연패로: KT가 3연패에 빠졌다 (데이터=8연승)",
  hasStreakContradiction("KT가 롯데를 꺾고 3연패에 빠졌다.", snapshots, teamNames) === true,
);
ok(
  "근거 없는 숫자: SSG가 5연승을 달렸다 (데이터=3연승, 카운트 불일치)",
  hasStreakContradiction("SSG가 5연승을 달렸다.", snapshots, teamNames) === true,
);

// === 정상 문장: 반드시 false ===
ok(
  "정상: KT가 8연승을 질주했다 (데이터 일치)",
  hasStreakContradiction("KT가 롯데를 5대4로 꺾고 8연승을 질주했다.", snapshots, teamNames) === false,
);
ok(
  "정상: LG가 8연패의 늪에 빠졌다 (데이터 일치)",
  hasStreakContradiction("LG는 한화에 4대8로 패하며 8연패의 늪에 빠졌다.", snapshots, teamNames) === false,
);
ok(
  "정상: SSG 3연승 + 한화 3연승 (둘 다 데이터 일치)",
  hasStreakContradiction(
    "SSG는 NC를 7대3으로 제압하며 3연승을 달렸고, 한화도 이 승리로 3연승을 달렸다.",
    snapshots,
    teamNames,
  ) === false,
);
ok(
  "정상: streak 언급 없는 문장",
  hasStreakContradiction("삼성은 두산을 15대4로 크게 이기며 1위 자리를 굳건히 지켰다.", snapshots, teamNames) === false,
);
ok(
  "정상: 같은 문장 두 팀 연승 모두 데이터 일치",
  hasStreakContradiction("KT가 8연승, LG가 8연패로 대비됐다.", snapshots, teamNames) === false,
);

// === strip fallback: 모순 문장만 제거, 정상 문장 보존 ===
const mixed =
  "삼성은 두산을 15대4로 크게 이기며 1위를 지켰다. 롯데도 KT에 패했지만 3연승을 이어갔다. SSG는 NC를 7대3으로 제압하며 3연승을 달렸다.";
const stripped = stripContradictorySentences(mixed, snapshots, teamNames);
ok("strip: 모순 문장(롯데 3연승) 제거됨", !stripped.includes("롯데도 KT에 패했지만"));
ok("strip: 정상 문장(삼성 1위) 보존됨", stripped.includes("삼성은 두산을 15대4로"));
ok("strip: 정상 문장(SSG 3연승) 보존됨", stripped.includes("SSG는 NC를 7대3으로"));
ok("strip: 결과에 모순 잔존 없음", !hasStreakContradiction(stripped, snapshots, teamNames));

// === 경계: '무'/'-' streak 팀은 연속기록 없음으로 취급 ===
const drawSnap = [snap(1, "무"), snap(2, "-"), snap(3, "8연패")];
ok(
  "경계: '무' 팀을 연승으로 주장하면 모순",
  hasStreakContradiction("삼성이 3연승을 달렸다.", drawSnap, teamNames) === true,
);

// === 삼순 NO-GO 반례: 주어 귀속 false-negative ===
// "롯데도 KT에 패했지만 8연승을 이어갔다" — KT=8연승(데이터)지만 주어는 롯데(=1연패).
// 절 안 KT streak가 매칭되더라도 주어(롯데도)로 귀속해 모순으로 잡아야 한다.
ok(
  "삼순 반례: 롯데도 KT에 패했지만 8연승을 이어갔다 (모순, 주어=롯데)",
  hasStreakContradiction("롯데도 KT에 패했지만 8연승을 이어갔다.", snapshots, teamNames) === true,
);
ok(
  "삼순 반례(콤마형): 삼성이 15대4로 이기며 1위, 롯데는 KT에 지고도 8연승 (모순)",
  hasStreakContradiction(
    "삼성이 15대4로 이기며 1위를 지켰고, 롯데는 KT에 지고도 8연승을 이어갔다.",
    snapshots,
    teamNames,
  ) === true,
);
ok(
  "정상(주어 귀속): 롯데를 꺾고 KT가 8연승 (KT=주어, 데이터 일치)",
  hasStreakContradiction("롯데를 5대4로 꺾고 KT가 8연승을 질주했다.", snapshots, teamNames) === false,
);

// === 삼순 NO-GO: 'N년 만' 다년 이력 환각 ===
ok(
  "환각: 롯데가 8년 만의 연승을 달렸다 (단일-delta 데이터엔 근거 없음)",
  hasStreakContradiction("롯데가 8년 만의 연승을 달렸다.", snapshots, teamNames) === true,
);
ok("환각 헬퍼: 'N년 만' 감지", sentenceFabricatesYears("8년 만의 홈승리다.") === true);
ok("환각 헬퍼: '몇 년만에' 감지", sentenceFabricatesYears("몇 년만에 가을야구를 노렸다.") === true);
ok("환각 헬퍼: 연도 주장 없으면 false", sentenceFabricatesYears("삼성이 1위를 지켰다.") === false);

// === 삼순 NO-GO: prompt 원천 방향 버그(parseInt 부호) 회귀 ===
// 프롬프트가 쓰는 순수 렌더 헬퍼 renderStreakLabel 직템(supabase 부수효 없이 격리 검증).
// 과거 버그: parseInt("8연패")=8(양수) → "8연승 중"으로 뒤집혀 거짓 데이터를 LLM에 먹임.
ok("prompt 렌더: '8연패' → '8연패 중'(부호 버그 회귀)", renderStreakLabel("8연패") === "8연패 중");
ok("prompt 렌더: '8연승' → '8연승 중'", renderStreakLabel("8연승") === "8연승 중");
ok("prompt 렌더: '2연패'은 3미만 → 미노출", renderStreakLabel("2연패") === "");
ok("prompt 렌더: '무'/'-'/null은 빈 라벨", renderStreakLabel("무") === "" && renderStreakLabel("-") === "" && renderStreakLabel(null) === "");

if (fail > 0) {
  console.error(`\n❌ ${fail} check(s) failed`);
  process.exit(1);
}
console.log("\n✅ standings streak guard smoke: all passed");
