/**
 * 구단 귀속(`team`) held-out 게이트 — 어휘 목록 없이 LLM 판정이 서는가.
 *
 * ## 왜 이 게이트가 필요한가
 *
 * 하린아빠 2026-08-31 지시로 `TEAM_ALIASES.assets`(마스코트·구장시설 **어휘 목록**)를
 * 삭제하고, "무엇이 그 구단의 것인가" 판정을 분류기에 위임했다. 코드는 **출력만**
 * 구단 10개 폐쇄집합으로 닫는다(`KBO_TEAM_CANONICALS`).
 *
 * 그러면 검증 책임이 옮겨온다 — 어휘 목록은 눈으로 읽으면 커버리지를 알 수 있지만,
 * LLM 판정은 **재보지 않으면 모른다**. 프롬프트를 고치거나 모델이 바뀌면 조용히 퇴행한다.
 *
 * ## 축
 *
 *   P. 양성 — 구단의 것을 묻는 질문에 **그 구단**이 나온다
 *   N. 음성 — 구단과 무관한 규칙·용어 질문에 **null** 이 나온다
 *   X. 오결속 — 다른 구단으로 귀속되는 일이 **0건**
 *   S. 안정성 — 같은 질문을 reps 회 반복해 **판정이 흔들리지 않는다**
 *
 * ⚠️ **X(오결속)가 P(양성)보다 엄격하다.** 미탐(null)은 종전 동작으로 떨어질 뿐이지만,
 *   오결속은 엉뚱한 구단 문서를 근거로 답하게 만드는 **새 결함**이다. 그래서 P 는 임계를
 *   두고 X 는 0 을 요구한다.
 *
 * ## held-out 인 이유
 *
 * 여기 문항은 라우팅 게이트(`genius-intent-routing-smoke.ts`) 코호트와 **겹치지 않는다.**
 * 개발 중 보던 예제로 검증하면 그건 재현이지 일반화가 아니다. 구단명이 문장에 없는
 * 표현(마스코트·구장 별칭·지역)을 일부러 섞었다 — 어휘 목록이 있었다면 못 맞혔을 것들이다.
 *
 * ## 실행
 *
 *   npm run qa:genius-team-binding            # reps=2
 *   npm run qa:genius-team-binding -- --reps 4
 *   npm run qa:genius-team-binding -- --selftest   # 임계 반전(검증력 자기점검)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { classifyIntent } from "../../src/lib/baseball-qa/server";
import { parseIntentResponse, KBO_TEAM_CANONICALS } from "../../src/lib/baseball-qa/intent";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
}
const REPS = Math.max(1, Number(arg("reps", "2")));
const SELFTEST = process.argv.includes("--selftest");
const EVIDENCE = arg(
  "out",
  "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/team-binding-heldout.json",
);

/**
 * 양성 — 구단의 것을 묻지만 **구단명이 문장에 없는** 표현 위주.
 *
 * 어휘 목록으로는 원리적으로 감당이 안 되는 축(마스코트·구장 별칭·지역·시설)을 고른다.
 * 여기서 통과한다는 것은 "목록 없이도 귀속이 선다" 는 뜻이다.
 */
const POSITIVE: ReadonlyArray<readonly [string, string]> = [
  ["챔피언스필드 이름 유래가 뭐야?", "KIA"],
  ["곰돌이 마스코트 이름이 뭐였지?", "두산"],
  ["사직구장 응원 문화가 왜 유명해?", "롯데"],
  ["라이온즈파크 좌석은 어떻게 나뉘어?", "삼성"],
  ["대전 신구장 이름이 뭐야?", "한화"],
  ["고척돔은 왜 실내야?", "키움"],
  ["수원 위즈파크 굿즈샵 어디 있어?", "KT"],
  ["랜더스필드 바비큐존이 뭐야?", "SSG"],
  ["창원 신축구장 특징이 뭐야?", "NC"],
  ["트윈스 응원가 중에 유명한 거 뭐야?", "LG"],
];

/**
 * 음성 — 구단과 무관한 규칙·용어. **null** 이어야 한다.
 *
 * 여기에 구단이 붙으면 그 질문은 엉뚱한 구단 문서를 근거로 받게 된다.
 */
const NEGATIVE: readonly string[] = [
  "인필드 플라이 규칙이 뭐야?",
  "낫아웃은 언제 성립해?",
  "타율은 어떻게 계산해?",
  "야구 경기는 몇 이닝이야?",
  "지명타자 제도가 뭐야?",
  "보크가 뭐야?",
];

/** 양성 최소 통과율 — 미탐은 종전 동작이라 1건은 허용하되 그 이상은 퇴행으로 본다. */
const POSITIVE_MIN = 0.8;

async function verdictFor(question: string): Promise<string | null> {
  const raw = await classifyIntent(question);
  return parseIntentResponse(raw.text, { question }).team;
}

type Row = {
  question: string;
  expected: string | null;
  observed: string[];
  stable: boolean;
  hit: boolean;
  misbound: boolean;
};

async function measure(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [question, expected] of POSITIVE) {
    const observed: string[] = [];
    for (let i = 0; i < REPS; i += 1) observed.push((await verdictFor(question)) ?? "-");
    const uniq = new Set(observed);
    rows.push({
      question, expected, observed,
      stable: uniq.size === 1,
      // 전 회차가 기대 구단이어야 적중이다 — 한 번이라도 갈리면 안정성 축에서 잡힌다.
      hit: observed.every((t) => t === expected),
      // 오결속 = 다른 구단으로 귀속. null(미탐)은 오결속이 아니다.
      misbound: observed.some((t) => t !== "-" && t !== expected),
    });
  }
  for (const question of NEGATIVE) {
    const observed: string[] = [];
    for (let i = 0; i < REPS; i += 1) observed.push((await verdictFor(question)) ?? "-");
    const uniq = new Set(observed);
    rows.push({
      question, expected: null, observed,
      stable: uniq.size === 1,
      hit: observed.every((t) => t === "-"),
      // 규칙 질문에 구단이 붙는 건 전부 오결속이다.
      misbound: observed.some((t) => t !== "-"),
    });
  }
  return rows;
}

async function main(): Promise<void> {
  console.log(`[team-heldout] reps=${REPS} · 폐쇄집합 ${KBO_TEAM_CANONICALS.length}개${SELFTEST ? " · SELFTEST" : ""}`);
  const rows = await measure();

  const pos = rows.filter((r) => r.expected !== null);
  const neg = rows.filter((r) => r.expected === null);
  const posHit = pos.filter((r) => r.hit).length;
  const misbound = rows.filter((r) => r.misbound);
  const unstable = rows.filter((r) => !r.stable);
  const posRate = posHit / pos.length;

  for (const r of rows) {
    const mark = r.misbound ? "MISBIND" : r.hit ? "ok " : "MISS";
    console.log(`  ${mark.padEnd(8)} ${r.question.slice(0, 26).padEnd(28)} want=${r.expected ?? "-"} got=${[...new Set(r.observed)].join("/")}`);
  }

  const fails: string[] = [];
  // 🔴 X 축이 가장 엄격하다 — 오결속은 새 결함이고, 미탐은 종전 동작이다.
  if (misbound.length > 0) {
    fails.push(`오결속 ${misbound.length}건: ${misbound.slice(0, 3).map((r) => `${r.question.slice(0, 14)}→${r.observed.join("/")}`).join(", ")}`);
  }
  // S 축 — provider 비결정성이 이 PR 의 핵심 쟁점이라 안정성을 별도 축으로 잰다.
  if (REPS > 1 && unstable.length > 0) {
    fails.push(`판정 흔들림 ${unstable.length}건: ${unstable.slice(0, 3).map((r) => `${r.question.slice(0, 14)}(${[...new Set(r.observed)].join("/")})`).join(", ")}`);
  }
  // P 축 — 임계 미만이면 "목록 없이 선다" 는 주장이 무너진다.
  const posOk = SELFTEST ? posRate > 1 : posRate >= POSITIVE_MIN;
  if (!posOk) fails.push(`양성 적중률 ${(posRate * 100).toFixed(0)}% < ${(POSITIVE_MIN * 100).toFixed(0)}%`);

  const negHit = neg.filter((r) => r.hit).length;
  console.log(`\n양성 ${posHit}/${pos.length}(${(posRate * 100).toFixed(0)}%) · 음성 ${negHit}/${neg.length} · 오결속 ${misbound.length} · 흔들림 ${unstable.length}`);

  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify({
    at: new Date().toISOString(), reps: REPS,
    note: "구단 귀속 held-out — assets 어휘 목록 삭제 후 LLM 판정이 서는지(삼순 2026-08-31 ⓒ-team)",
    posHit, posTotal: pos.length, negHit, negTotal: neg.length,
    misbound: misbound.length, unstable: unstable.length, rows,
  }, null, 2));
  console.log(`[증거] ${EVIDENCE}`);

  if (SELFTEST) {
    // 임계를 도달 불가로 반전했다 — 반드시 FAIL 이어야 게이트에 판정력이 있다.
    if (fails.length === 0) {
      console.error("❌ SELFTEST: 반전 임계인데 통과했다 — 게이트가 판정을 안 한다");
      process.exit(1);
    }
    console.log(`✅ SELFTEST: 반전 임계에서 정상 FAIL (${fails.length}건)`);
    return;
  }
  if (fails.length > 0) {
    console.error(`\n❌ team-binding-heldout FAIL:\n  - ${fails.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\n✅ team-binding-heldout PASS (양성 임계·음성 null·오결속 0·판정 안정)");
}

main().catch((error) => {
  console.error("❌ team-binding-heldout 실행 실패:", error);
  process.exit(1);
});
