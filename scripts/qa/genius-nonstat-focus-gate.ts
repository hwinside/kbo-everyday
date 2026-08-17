/**
 * 동문서답 방지 가드 게이트 (kbo_structured 스탯 경로 의도 가로채기).
 *
 * 배경: 2026-08-17 72h 로그 동문서답 전수조사 — "엔티티 + 지표어"만 보고 시즌 누적을
 * 던지는 케이스가 답변건의 7.6%. 그중 kbo_structured 축 7건은 질문 초점이 비(非)스탯인데
 * (세레머니·순위·어제/특정경기·방법/추세) 스탯 경로가 가로채 동문서답이 됐다.
 *
 * 이 게이트는 `resolveSeasonRecordIntent`(선수 축)·`resolveTeamRecordIntent`(팀 축)이
 * 그 4신호에서 `kind:"none"` 으로 양보(→ LLM/RAG 위임)하는지 종단 함수로 검증한다.
 * 정상 스탯 질문(시즌 스코프·bare 지표·팀 순위)은 절대 양보하지 않아야 한다(false-close 방지).
 *
 * 실행:  npx tsx scripts/qa/genius-nonstat-focus-gate.ts
 * selftest(닫힌 신호 정밀도 결함주입):  npx tsx scripts/qa/genius-nonstat-focus-gate.ts --selftest
 */
import { resolveSeasonRecordIntent, hasNonStatFocus } from "../../src/lib/baseball-qa/stats/season-record";
import { resolveTeamRecordIntent } from "../../src/lib/baseball-qa/stats/team-record";

type Axis = "season" | "team";
interface Case {
  q: string;
  axis: Axis;
  /** true = 스탯 경로가 양보(none)해야 함(동문서답 방지). false = 정상 스탯 → 양보 금지. */
  divert: boolean;
  note: string;
}

// 72h 로그 실제 동문서답 케이스(양보해야 함) + 정상 케이스(양보 금지).
const CASES: Case[] = [
  // ── 선수 축: 동문서답 → 양보 ──
  { q: "김재윤 세이브 순위", axis: "season", divert: true, note: "순위 물었는데 개수" },
  { q: "김도영 타율 3할 되려면 어떻게 해야할까", axis: "season", divert: true, note: "방법" },
  { q: "박동원의 최근 타율 변화는 어때?", axis: "season", divert: true, note: "추세" },
  { q: "그니까 오늘 기아랑 두산 경기에서 이의리가 세이브를 했잖아", axis: "season", divert: true, note: "오늘/특정경기" },
  { q: "네이버에 보면 경기정보에 고승민 4타수 3안타 이렇게되어잇던데", axis: "season", divert: true, note: "경기정보" },
  // ── 팀 축: 동문서답 → 양보 ──
  { q: "안타를 쳤을때 기아타이거즈만에 세레머니거 있어?", axis: "team", divert: true, note: "조건절 내 지표+세레머니" },
  { q: "어제 롯데 홈런 몇번 쳣어", axis: "team", divert: true, note: "어제(시즌누적 아님)" },
  // ── 선수 축: 정상 → 양보 금지 ──
  { q: "김도영 타율", axis: "season", divert: false, note: "bare 지표" },
  { q: "이승민 평균자책점", axis: "season", divert: false, note: "bare 지표" },
  { q: "구자욱 통산타율", axis: "season", divert: false, note: "통산=시즌스코프" },
  { q: "레이예스 안타 몇번 쳤어", axis: "season", divert: false, note: "쳤어(때/면 아님)" },
  { q: "김도영 올해 홈런 몇개", axis: "season", divert: false, note: "올해=시즌스코프" },
  // ── 팀 축: 정상 → 양보 금지 ──
  { q: "케이티 순위", axis: "team", divert: false, note: "팀 순위=서빙 지표" },
  { q: "롯데 팀 홈런 몇개", axis: "team", divert: false, note: "bare 팀 지표" },
];

function diverted(axis: Axis, q: string): boolean {
  const intent = axis === "season" ? resolveSeasonRecordIntent(q) : resolveTeamRecordIntent(q);
  return intent.kind === "none";
}

function runFixtures(): number {
  let fail = 0;
  for (const c of CASES) {
    const got = diverted(c.axis, c.q);
    // divert=false 인 정상 케이스는 "none 이 아니어야" 통과 — 단, 정상 케이스가 애초에
    // 스탯 매칭이 안 돼 none 이 나오면 이 게이트 범위 밖(다른 이유의 none)이므로,
    // 정상 케이스는 "가드 때문에 none 이 된 것은 아니다"만 본다.
    const byGuard = hasNonStatFocus(c.q, { rankIsMismatch: c.axis === "season" });
    let ok: boolean;
    if (c.divert) ok = got === true && byGuard === true;
    else ok = byGuard === false; // 정상 케이스: 가드가 잡지 않아야 한다
    if (!ok) {
      fail++;
      console.error(`FAIL [${c.axis}] divert=${c.divert} got(none)=${got} byGuard=${byGuard}  "${c.q}"  (${c.note})`);
    }
  }
  return fail;
}

// 닫힌 신호 정밀도: 각 신호가 대표 양성에서 켜지고 대표 음성(시즌스코프·구종 등)에서 꺼지는가.
function runSelftest(): number {
  let fail = 0;
  const check = (q: string, opts: { rankIsMismatch: boolean }, expect: boolean, label: string) => {
    const got = hasNonStatFocus(q, opts);
    if (got !== expect) {
      fail++;
      console.error(`SELFTEST FAIL [${label}] expect=${expect} got=${got}  "${q}"`);
    }
  };
  const S = { rankIsMismatch: true } as const;
  const T = { rankIsMismatch: false } as const;
  // 양성(잡아야 함)
  check("어제 홈런", S, true, "day+");
  check("경기정보에 4타수 3안타", S, true, "day+ 경기정보");
  check("타율 3할 되려면", S, true, "method+");
  check("타율 변화 어때", S, true, "trend+");
  check("안타를 쳤을때 세레머니", T, true, "subordinate+");
  check("세이브 순위", S, true, "rank+ (season)");
  // 음성(잡으면 안 됨) — 정밀도
  check("올해 홈런 몇개", S, false, "올해=시즌스코프");
  check("이번 시즌 타율", S, false, "이번시즌=시즌스코프");
  check("통산 안타", S, false, "통산=시즌스코프");
  check("변화구 몇개 던졌어", S, false, "변화구=구종(변화 오탐 금지)");
  check("레이예스 안타 몇번 쳤어", S, false, "쳤어(때/면 아님)");
  check("케이티 순위", T, false, "팀 순위=서빙(rankIsMismatch=false)");
  return fail;
}

const selftest = process.argv.includes("--selftest");
const fail = selftest ? runSelftest() : runFixtures();
if (fail > 0) {
  console.error(`\n❌ ${selftest ? "selftest" : "fixtures"} 실패 ${fail}건`);
  process.exit(1);
}
console.log(`✅ ${selftest ? "selftest" : "fixtures"} 통과 (${selftest ? "정밀도 12축" : CASES.length + "케이스"})`);
