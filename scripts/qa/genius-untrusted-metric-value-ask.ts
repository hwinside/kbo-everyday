/**
 * **untrusted 지표 = 값 요구일 때만 차단** 게이트 (2026-09-04).
 *
 * ## 무엇을 지키는가
 *
 * `UNTRUSTED_METRIC_ALIASES`(타석·희생번트·사사구…)는 "값은 있는데 믿을 수 없다"는
 * 집합이라 **값 요청**을 거절하는 게 맞다. 그런데 종전 판정은 그 지표어가 **글자로
 * 있기만 하면** 차단해서, 뜻을 물은 질문에도 "그 기록은 아직 정확하게 안내할 수
 * 없습니다"가 나갔다(실측: 정의 질문 8/8 차단). 검수 사전에 용어가 있어도 이 판정이
 * 사전보다 **앞**이라 못 갔다.
 *
 * ## 계약 (삼순 2026-09-04 조건부 GO 문면 그대로)
 *
 * ```
 * 차단 = untrusted 지표 AND ( 명시적 값 요구  OR  선수+지표 bare query )
 * 양보 = 정의 술어가 붙고 값 요구가 없을 때 → none
 * 차단 = 혼합(`희생번트가 뭐야, 김도영은 몇 개야?`) — 값 요구가 이긴다
 * ```
 *
 * 🔴 **선수명만으로 값 요구로 보지 않는다.** 내가 처음 제안한 `수량 요구 ∪ 선수 결속`은
 *   합집합이라 `김도영 희생번트가 뭐야?`를 다시 막았다 — 정의 질문을 열어주려던 수정이
 *   정의 질문을 막는 꼴이었다(삼순 NO-GO 포인트). 선수 결속은 **정의 술어가 없을 때만**
 *   값 요구로 읽는다.
 *
 * ## 왜 이 방향인가 (룰 축적 방지)
 *
 * "정의 질문인가"를 맞히려 들면 반례마다 룰이 쌓인다(M90 `open_language_never_closes_with_rules`,
 * 8월에 세 번 겪음). 그래서 **반대를 닫는다**: 수량을 요구하는 표현은 폐쇄적이다.
 * 정의 술어는 보조 신호로만 쓰고, 놓쳐도 손해는 종전과 같은 "차단 안내"라 fail-safe다.
 *
 * ## 판정면
 *
 * 배포 코드가 실제로 부르는 `resolveSeasonRecordIntent`를 그대로 태운다(사본 없음).
 * provider·DB 호출 0회 — 순수 판정 함수다.
 *
 * 실행: npm run qa:genius-untrusted-metric
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveSeasonRecordIntentFor } from "../../src/lib/baseball-qa/pipeline";
import {
  resolveSeasonRecordIntent,
  untrustedValueAsk,
} from "../../src/lib/baseball-qa/stats/season-record";

/** 실패 줄에만 나오는 안정 ID — 통과 출력(✅)과 겹치지 않게 한다. */
const FAIL_ID = "[UMV-FAIL]";

interface Case {
  /** 축 이름 — 어느 계약이 깨졌는지 실패 줄에서 바로 보이게. */
  axis: string;
  question: string;
  /** 파이프라인이 계산해 넘기는 "로스터 선수 결속" 사실. */
  playerBound: boolean;
  want: "none" | "untrusted_metric" | "query";
}

/**
 * 🔴 분모가 곧 계약이다. 축이 하나라도 0건이면 그 축은 검사되지 않은 것이므로
 *   아래 `assertAxisCoverage`가 fail-close 한다(vacuous PASS 방지).
 */
const CASES: Case[] = [
  // ── ① 정의 질문(선수 결속 없음) — 종전 8/8 차단됐다. 이제 양보해야 한다 ──────
  { axis: "definition", question: "희생번트는 타수에 들어가?", playerBound: false, want: "none" },
  { axis: "definition", question: "희생플라이는 타율에 영향 있어?", playerBound: false, want: "none" },
  { axis: "definition", question: "타석이랑 타수 차이가 뭐야?", playerBound: false, want: "none" },
  { axis: "definition", question: "사사구가 무슨 뜻이야?", playerBound: false, want: "none" },
  { axis: "definition", question: "희생타는 어떻게 기록돼?", playerBound: false, want: "none" },
  { axis: "definition", question: "번트타 뜻이 뭐야?", playerBound: false, want: "none" },
  { axis: "definition", question: "희생번트랑 희생플라이 차이 알려줘", playerBound: false, want: "none" },
  { axis: "definition", question: "타석은 어떻게 세는거야?", playerBound: false, want: "none" },

  // ── ② 선수 결속 정의 (삼순 2026-09-04 신규 2건) ─────────────────────────────
  //   🔴 여기가 삼순 NO-GO 포인트다. 선수명이 붙어도 **정의 술어가 있으면** 양보한다.
  { axis: "player_bound_definition", question: "김도영 희생번트가 뭐야?", playerBound: true, want: "none" },
  { axis: "player_bound_definition", question: "김도영 타석이 무슨 뜻이야?", playerBound: true, want: "none" },

  // ── ③ 선수+지표 bare query (삼순 신규 2건) ─────────────────────────────────
  //   의문사가 없어도 유저가 선수와 지표를 함께 적으면 그 값을 원한 것이다.
  { axis: "player_bound_bare", question: "김도영 희생번트", playerBound: true, want: "untrusted_metric" },
  { axis: "player_bound_bare", question: "김도영 타석", playerBound: true, want: "untrusted_metric" },

  // ── ③-b 카운트 명사 문법 (삼순 2026-09-04 2차 NO-GO 3건) ─────────────────────
  //
  // 🔴 1차 구현은 `수는`·`기록` 을 **단어 포함**으로 값 요구라 판정해 양쪽으로 샜다.
  //   `수`·`기록`·`횟수` 는 명사일 뿐이고 **뒤에 오는 술어**가 뜻을 정한다.
  //     · `수는 + 어떻게 세는`  → 정의 (종전엔 차단됐다)
  //     · `기록이 + 뭐야`       → 값 요구 (종전엔 `뭐` 가 이겨 샜다)
  {
    axis: "count_noun_grammar", question: "타석 수는 어떻게 세는 거야?",
    playerBound: false, want: "none",
  },
  {
    axis: "count_noun_grammar", question: "희생번트 수는 어떻게 계산해?",
    playerBound: false, want: "none",
  },
  {
    axis: "count_noun_grammar", question: "김도영 희생번트 기록이 뭐야?",
    playerBound: true, want: "untrusted_metric",
  },

  // ── ③-c 국소 결속 (삼순 2026-09-05 3차 NO-GO 2건) ────────────────────────────
  //
  // 🔴 2차 구현은 `COUNT_NOUN && VALUE_PREDICATE` 로 두 정규식을 따로 돌려 **문장 전체
  //   공존**이 됐다. `기록 규칙`·`기록 방식` 은 `기록` 이 뒤 명사를 수식하는 복합 명사구라
  //   술어(`알려`·`뭐`)는 `규칙`·`방식` 에 걸린 것인데, 공존 검사는 위치를 잃어 차단했다.
  //   값 술어는 카운트 명사 **바로 뒤**에만 결속한다 — 사이에 다른 명사가 끼면 양보.
  {
    axis: "count_noun_local_binding", question: "희생번트 기록 규칙 알려줘",
    playerBound: false, want: "none",
  },
  {
    axis: "count_noun_local_binding", question: "희생번트 기록 방식이 뭐야?",
    playerBound: false, want: "none",
  },
  // 선수 결속이 있어도 결속이 끊긴 채 정의 술어가 붙으면 양보다(bare query 가 아니다).
  {
    axis: "count_noun_local_binding", question: "김도영 희생번트 기록 규칙 알려줘",
    playerBound: true, want: "none",
  },
  // 🔴 반대 방향 — 국소 결속이 **살아있는** 값 요구는 여전히 차단이어야 한다.
  //   이 축이 없으면 "카운트 명사 축 통째로 제거" 가 위 3건을 GREEN 으로 통과한다.
  {
    axis: "count_noun_local_binding", question: "김도영 희생번트 성적 알려줘",
    playerBound: true, want: "untrusted_metric",
  },

  // ── ④ 혼합 (삼순 신규 1건) — 값 요구가 정의 술어를 이긴다 ────────────────────
  {
    axis: "mixed", question: "희생번트가 뭐야, 김도영은 몇 개야?",
    playerBound: true, want: "untrusted_metric",
  },

  // ── ⑤ 명시적 값 요구 — 종전 동작 그대로 차단되어야 한다(회귀 방지) ───────────
  { axis: "value_ask", question: "김도영 타석 몇 개야?", playerBound: true, want: "untrusted_metric" },
  { axis: "value_ask", question: "김도영 희생번트 몇 개야?", playerBound: true, want: "untrusted_metric" },
  { axis: "value_ask", question: "박찬호 희생플라이 개수 알려줘", playerBound: true, want: "untrusted_metric" },
  { axis: "value_ask", question: "김도영 사사구 몇 개", playerBound: true, want: "untrusted_metric" },
  // 🔴 선수 결속이 **없어도** 명시적 값 요구면 차단이다 — 이 축이 빠지면
  //   "선수 결속만이 차단 사유" 로 계약이 좁아진 것을 못 잡는다.
  { axis: "value_ask", question: "희생번트 몇 개가 최다 기록이야?", playerBound: false, want: "untrusted_metric" },

  // ── ⑥ 대조군 — untrusted 아닌 지표는 이 변경과 무관해야 한다 ────────────────
  { axis: "control", question: "김도영 홈런 몇 개야?", playerBound: true, want: "query" },
  { axis: "control", question: "김도영 타율 알려줘", playerBound: true, want: "query" },
  // ⚠️ `query` 가 맞다 — 내가 처음 `none` 으로 적었다가 이 게이트에 잡혔고,
  //   `git stash` 로 main 을 직접 태워 확인했다(변경 전에도 `query`).
  //   신뢰 지표의 정의 질문도 기록 경로로 판정되지만, `query` 는 **종결하지 않는다** —
  //   선수 후보가 없으면 사전·RAG 로 내려간다. 반면 `untrusted_metric` 은 그 자리에서
  //   고정 안내문으로 **닫는다**. 이 PR 이 그쪽만 건드리는 이유가 이것이다.
  { axis: "control", question: "홈런이 무슨 뜻이야?", playerBound: false, want: "query" },
];

/** 축 커버리지 — 분모 0 축이 있으면 그 축은 검사되지 않았다(fail-close). */
function assertAxisCoverage(): string[] {
  const required = [
    "definition", "player_bound_definition", "player_bound_bare",
    "count_noun_grammar", "count_noun_local_binding", "mixed", "value_ask", "control",
  ];
  return required.filter((axis) => !CASES.some((c) => c.axis === axis))
    .map((axis) => `${FAIL_ID} 분모 0 축: ${axis} — vacuous PASS 방지 fail-close`);
}

/**
 * 순수 술어 자체도 직접 태운다 — `resolveSeasonRecordIntent` 만 보면 다른 분기(시점·
 * 지표 매칭)가 결과를 덮어써서 이 계약이 실제로 성립하는지 흐려진다.
 */
function predicateChecks(): string[] {
  const out: string[] = [];
  const rows: Array<[string, boolean, boolean]> = [
    // [질문, playerBound, 기대(값 요구인가)]
    ["희생번트는 타수에 들어가?", false, false],
    ["김도영 희생번트가 뭐야?", true, false],
    ["김도영 희생번트", true, true],
    ["희생번트가 뭐야, 김도영은 몇 개야?", true, true],
    ["희생번트 몇 개야?", false, true],
    // 🔴 카운트 명사 문법 (삼순 2차 NO-GO) — 명사 존재가 아니라 술어가 뜻을 정한다.
    ["타석 수는 어떻게 세는 거야?", false, false],
    ["희생번트 수는 어떻게 계산해?", false, false],
    ["김도영 희생번트 기록이 뭐야?", true, true],
    // 명사만·술어만으로는 값 요구가 아니다 — 둘이 함께여야 한다.
    ["희생번트 기록", false, false],
    // 🔴 국소 결속 (삼순 3차 NO-GO) — 함께 있는 것으로도 부족하다. 술어가 명사 바로 뒤여야 한다.
    ["희생번트 기록 규칙 알려줘", false, false],
    ["희생번트 기록 방식이 뭐야?", false, false],
    ["희생번트 기록 계산 방법 알려줘", false, false],
    // 술어만 위치를 옮겨도 결속이 살면 값 요구다 — 위 셋과 짝이 되는 반대 방향.
    ["희생번트 기록 알려줘", false, true],
    ["김도영 희생번트 성적 어때?", true, true],
  ];
  for (const [q, pb, want] of rows) {
    const got = untrustedValueAsk(q, pb);
    if (got !== want) {
      out.push(`${FAIL_ID} untrustedValueAsk("${q}", playerBound=${pb}) = ${got}, 기대 ${want}`);
    }
  }
  return out;
}

/**
 * **파이프라인 진입점**을 직접 태운다 (2026-09-04).
 *
 * 🔴 순수 술어만 검사하면 wiring 결함을 못 잡는다 — 실제로 `resolveSeasonRecordIntentFor`
 *   의 결속 계산을 지우는 mutation 2종이 살아남았다(측정함). 공용 함수가 멀쩡해도
 *   호출부가 결속 사실을 안 넘기면 결과는 종전 결함과 같으므로, **wiring 도 계약**이다.
 *
 * ⚠️ 로스터는 최소 픽스처만 쓴다 — 이 게이트가 검사하는 건 결속 *전달*이지
 *   이름 매칭 품질이 아니다(그건 `mentionsAnyRosterName` 소관).
 */
function pipelineEntryChecks(): string[] {
  const out: string[] = [];
  const players = [{ kboId: 1, name: "김도영", position: "내야수" }] as unknown as
    Parameters<typeof resolveSeasonRecordIntentFor>[1];

  // ① 질문에 로스터 이름이 있으면 진입점이 스스로 결속을 계산해야 한다.
  const bare = resolveSeasonRecordIntentFor("김도영 희생번트", players).kind;
  if (bare !== "untrusted_metric") {
    out.push(`${FAIL_ID} [entry_binding] "김도영 희생번트" → ${bare}, 기대 untrusted_metric`);
  }
  // ② 같은 결속이어도 정의 술어가 붙으면 양보한다(삼순 NO-GO 축).
  const def = resolveSeasonRecordIntentFor("김도영 희생번트가 뭐야?", players).kind;
  if (def !== "none") {
    out.push(`${FAIL_ID} [entry_binding] "김도영 희생번트가 뭐야?" → ${def}, 기대 none`);
  }
  // ③ 🔴 선수가 **확정된** 경로(picker 등)는 질문에 이름이 없어도 결속이다.
  //   `forcePlayerBound` 를 안 넘기면 이름 재매칭에만 기대게 되어 이 축이 죽는다.
  const forced = resolveSeasonRecordIntentFor("희생번트", players, undefined, true).kind;
  if (forced !== "untrusted_metric") {
    out.push(`${FAIL_ID} [entry_forced_bound] "희생번트"(확정 경로) → ${forced}, 기대 untrusted_metric`);
  }
  // ④ 확정 경로여도 정의 술어면 양보 — force 가 정의를 덮어쓰면 안 된다.
  const forcedDef = resolveSeasonRecordIntentFor("희생번트가 뭐야?", players, undefined, true).kind;
  if (forcedDef !== "none") {
    out.push(`${FAIL_ID} [entry_forced_bound] "희생번트가 뭐야?"(확정 경로) → ${forcedDef}, 기대 none`);
  }
  return out;
}

/**
 * **배선 불변식** — 파이프라인이 wrapper 를 우회해 원함수를 부르지 못하게 한다
 * (삼순 2026-09-04 2차 NO-GO).
 *
 * 🔴 왜 소스를 읽는가. 앞의 검사들은 `resolveSeasonRecordIntentFor` 를 **직접** 부르므로,
 *   실제 파이프라인 호출부가 그 wrapper 를 통째로 우회해도 전부 GREEN 이다. 실제로
 *   mutation 3종(M7·M8·M9)이 그렇게 살아남았고, 그 설계 중에
 *   `answerSeasonRecordQuestion` 의 fallback 이 **정말로 결속 없이** 원함수를 부르고
 *   있던 것을 발견했다(코드도 같이 고침). 배선은 계약의 일부다.
 *
 * 계약: `resolveSeasonRecordIntent(` 직접 호출은 **두 곳만** 허용한다.
 *   ① wrapper 내부(`resolveSeasonRecordIntentFor`) — 여기가 결속을 계산한다
 *   ② `answerSeasonRecordQuestion` 의 override fallback — `playerBound` 를 명시해야 한다
 *   그 외 호출부는 전부 wrapper 를 거쳐야 한다.
 *
 * ⚠️ 주석·문자열 문면은 **blank 처리**하고 센다(오프셋 보존). 주석에 함수명을 적었다는
 *   이유로 RED 가 나면 게이트가 자기 문서를 검사하는 꼴이다(M90 2026-08-19 사고).
 */
function wiringInvariantChecks(): string[] {
  const out: string[] = [];
  const src = readFileSync(
    path.join(process.cwd(), "src/lib/baseball-qa/pipeline.ts"), "utf8",
  );
  // 주석을 공백으로 치환 — 길이는 보존해 줄 번호가 어긋나지 않게 한다.
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

  // `resolveSeasonRecordIntentFor` 는 이 정규식에 걸리지 않게 뒤에 `(` 를 요구한다.
  const direct = [...blanked.matchAll(/resolveSeasonRecordIntent\s*\(/g)];
  if (direct.length !== 2) {
    out.push(
      `${FAIL_ID} [wiring] resolveSeasonRecordIntent 직접 호출 ${direct.length}곳 — `
      + "허용은 wrapper 내부 1 + answerSeasonRecordQuestion fallback 1, 총 2곳뿐이다. "
      + "다른 호출부는 resolveSeasonRecordIntentFor 를 거쳐야 한다(wrapper 우회 금지)",
    );
  }
  // fallback 은 결속을 **명시**해야 한다 — 인자 없이 부르면 종단에서 다른 판정이 난다.
  if (!/\?\?\s*resolveSeasonRecordIntent\(\s*question,\s*undefined,\s*\{\s*playerBound:\s*true\s*\}\s*\)/.test(blanked)) {
    out.push(
      `${FAIL_ID} [wiring] answerSeasonRecordQuestion fallback 이 playerBound 를 명시하지 않는다 — `
      + "override 없이 들어오는 경로가 결속을 빠뜨리면 bare query 축이 죽는다",
    );
  }
  // wrapper 를 거치는 호출부가 실제로 존재해야 한다(둘 다 지워지면 위 카운트만으론 못 잡는다).
  const viaWrapper = [...blanked.matchAll(/resolveSeasonRecordIntentFor\s*\(/g)];
  // 정의 1 + 호출 2 = 3
  if (viaWrapper.length < 3) {
    out.push(
      `${FAIL_ID} [wiring] resolveSeasonRecordIntentFor 참조 ${viaWrapper.length}곳 — `
      + "정의 1 + 호출부 2 = 최소 3곳이어야 한다",
    );
  }
  return out;
}

function run(): string[] {
  const failures = [
    ...assertAxisCoverage(), ...predicateChecks(),
    ...pipelineEntryChecks(), ...wiringInvariantChecks(),
  ];
  for (const c of CASES) {
    const got = resolveSeasonRecordIntent(c.question, undefined, { playerBound: c.playerBound }).kind;
    if (got !== c.want) {
      failures.push(
        `${FAIL_ID} [${c.axis}] "${c.question}" (playerBound=${c.playerBound}) → ${got}, 기대 ${c.want}`,
      );
    }
  }
  return failures;
}

function main(): void {
  // `--selftest` 는 임계 반전이 아니라 **계약이 살아있는지**를 본다.
  //   ⚠️ selftest 통과는 검출력의 증거가 아니다 — 그건 mutations 게이트의 일이다.
  const failures = run();
  for (const f of failures) console.error(`  ❌ ${f}`);
  if (failures.length > 0) {
    console.error(`\n❌ qa:genius-untrusted-metric FAIL — ${failures.length}건`);
    process.exit(1);
  }
  const byAxis = new Map<string, number>();
  for (const c of CASES) byAxis.set(c.axis, (byAxis.get(c.axis) ?? 0) + 1);
  console.log(
    `✅ qa:genius-untrusted-metric: ${CASES.length}/${CASES.length} PASS `
    + `(${[...byAxis].map(([a, n]) => `${a} ${n}`).join(" · ")})`,
  );
}

main();
