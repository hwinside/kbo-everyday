/**
 * `stat_clarify` 오발동 회귀 게이트 — 2026-08-22 48h 운영 로그 전수 실측 기반.
 *
 * ── 무엇을 막는가 ────────────────────────────────────────────────────────────
 * 운영 로그 867건 중 `match_path=stat_clarify` 11건을 전수 재현해보니, **11건 전부가
 * 질문에 사람 이름이 없는데 "앞말이 선수 이름인지 확인하지 못했습니다" 를 받았다.**
 * 원인은 세 축이다:
 *
 *   ① `NAMED_STAT_HEAD` 가 지표어 **바로 앞 토큰**을 엔티티 후보로 뽑는다. 그래서
 *      `31호 홈런`·`4점차면 세이브`·`3루카 홈런` 에서 head 가 `31호`·`4점차면`·`3루카`
 *      가 되고, 로스터·사전 어디에도 없어 미결속(`ambiguous`)으로 떨어진다.
 *      → 수정: **숫자로 시작하는 head 는 엔티티가 아니다**(닫힌 집합).
 *
 *   ①-b `누가` 는 `누구+가` 의 축약형이라 조사 제거 후 `누` 만 남아 의문사 열거에서
 *      빠졌다. → 수정: `HEAD_NON_ENTITY_UNITS` 에 `누` 추가(문법적으로 닫힌 부류).
 *
 *   ② 가드가 소유하면 LLM 은 `RECORD`/`NARRATIVE` 토큰만 낼 수 있었는데, 실 provider 는
 *      룰 질문에 **정상 룰 답변**을 냈고 코드는 토큰이 아니라는 이유로 버렸다.
 *      → 수정: `RULE_TERM` 토큰 추가. **가드 소유 부정** 신호이고, 호출측이 일반
 *        프롬프트로 재질의해 `validateLlmResponse` 전수 검증을 통과시킨다.
 *
 * ── 왜 룰이 아니라 이 형태인가 ───────────────────────────────────────────────
 * ①·①-b 는 닫힌 집합이다(KBO 등록명은 숫자로 시작하지 않고, 의문사는 문법적으로 닫힌
 * 부류다). ②는 열린 자연어(룰 질문인가 기록 요구인가)라 룰로 닫히지 않으므로 판정
 * 주체를 LLM 으로 옮기되 **유저 노출 문구는 코드가 정한다**
 * (`open_language_never_closes_with_rules`).
 *
 * ── 검증력 ──────────────────────────────────────────────────────────────────
 * 로그 11건은 **각각 `answerQuestion` 종단을 실행**하고 `source`·`답변`·`LLM 호출 횟수`·
 * `프롬프트 모드`를 전부 고정한다(배열에 담아만 두면 GREEN 인 축 없음 — 삼순 P0①).
 * 결함주입은 `stat-clarify-misfire-mutations.mjs` 가 담당하며, 이 파일 단독 PASS 는
 * 검증력을 증명하지 않는다 — 두 개가 한 묶음이다.
 *
 * 실행: npm run qa:stat-clarify-misfire  (오프라인, 네트워크·DB 불필요)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerQuestion,
  classifyNamedStatMatches,
  mentionsTeamForGate,
  packStoredQaFinal,
  parseStatIntentToken,
  resolveProductFeature,
  routeQuestion,
  statGuardOwnsQuestion,
  PRODUCT_FEATURE_GUIDE_ANSWERS,
  unpackStoredQaFinal,
  BLOCKED_ANSWER,
  HISTORY_HOLD_ANSWER,
  STAT_CLARIFY_ANSWER,
  STAT_NARRATIVE_ANSWER,
  SYSTEM_ERROR_ANSWER,
  UNCLEAR_ANSWER,
  type GlossaryEntry,
  type LlmResult,
  type MatchPath,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { STAT_INTENT_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import playersRoster from "../../src/lib/constants/players-roster.json";

const SELFTEST = process.argv.includes("--selftest");

// ── 입력 SSOT: 실제 배포가 쓰는 시드 사전 + 로스터 JSON ──────────────────────
const seedSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260730_baseball_qa_seed.sql"),
  "utf8",
);
const glossary: GlossaryEntry[] = [
  ...seedSql.matchAll(/\('([^']+)',\s*ARRAY\[([^\]]*)\],\s*'([^']+)'/gs),
].map((match) => ({
  term: match[1],
  aliases: [...match[2].matchAll(/'([^']*)'/g)].map((alias) => alias[1]),
  answer: match[3],
}));
assert.ok(glossary.length >= 100, `시드 사전 로드 실패 (${glossary.length})`);
const players: PlayerRef[] = (playersRoster as Array<Record<string, unknown>>).map((p) => ({
  name: p.name as string,
  kboId: p.kboId as number,
  team: (p.team ?? null) as string | null,
  position: (p.position ?? null) as string | null,
  backNo: (p.backNo ?? null) as number | null,
}));
assert.ok(players.length > 0, "로스터 SSOT 비어 있음");

const INTENT = (token: string) => JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: token });
const RULE_ANSWER =
  "야구 규칙에 따르면 그 상황은 이렇게 처리합니다. 심판이 판단해 진루가 결정됩니다.";
const NORMAL_ANSWER = JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: RULE_ANSWER });

/**
 * 48h 운영 로그 `match_path=stat_clarify` **전수 11건**(2026-08-22 21:04 KST 기준).
 *
 * ⚠️ 임의 샘플이 아니라 **그 창의 전수**다. 줄이면 분모가 절단된다
 *   (`truncated_denominator` 교훈) — 새 사례 추가만 허용한다.
 *
 * `probedIntent` 는 **실 provider(Gemini) 를 이 11건으로 실제 호출해 받은 토큰**이다
 *   (2026-08-22 재프로브). 추측이 아니라 실측값이며, 가드가 소유하는 질문에만 있다.
 * `expect` 는 "이 질문에 무엇이 나가야 옳은가" 를 사람이 판정한 값이다 —
 *   현재 출력을 그대로 베끼지 않는다(틀린 종단을 정답으로 고정하는 사고 방지).
 *
 * 🔴 `normalizedObserved` — **이 게이트가 2026-08-23 에 놓친 것** (배포 후 end-user QA 실측).
 *
 *   배포 파이프라인은 residual 질문을 **LLM 표기 정규화**(`normalizeQuestionLlm`)에 먼저 태우고,
 *   수용(`accepted_surface`)되면 그 **정규화된 문자열로** 이후 판정을 한다. 그런데 이 게이트는
 *   원문만 태워서, 정규화가 라우팅을 뒤집는 케이스를 **구조적으로 볼 수 없었다**:
 *     `직관기록`  → 매치 없음(guard=false) → 게이트 GREEN
 *     `직관 기록`  → `<직관> <기록>` 매치(guard=true) → **유저는 되묻기를 받았다**(3/3 고정 재현)
 *   즉 28축 PASS · mutations 8/8 RED · CI 19 checks SUCCESS 를 전부 통과한 채 배포됐다.
 *   seam 동일성은 *함수*만의 속성이 아니라 **(함수, 입력) 쌍**의 속성이다.
 *
 *   값은 추측이 아니라 **프로덕션 로그 `question_normalized` 실측치**다
 *   (2026-08-23 06:1x 일회용 계정 종단 QA, 원장 `e2e-1286-repro-mt4vqarr.json`).
 *   정규화가 안 일어나거나 거절된 케이스는 이 필드가 없다 — **없다고 추측해 채우지 않는다**.
 */
const LOG_CASES: Array<{
  question: string;
  guard: boolean;
  probedIntent?: "record" | "narrative" | "rule_term";
  expect: MatchPath;
  /** 그 종단이 왜 옳은지 — 리뷰어가 기대값 자체를 검증할 수 있게 남긴다. */
  why: string;
  llmCalls: number;
  /**
   * 배포에서 정규화가 **수용**된 경우 그 결과 문자열(로그 `question_normalized` 실측치).
   * 있으면 이 문자열로도 종단을 한 번 더 태운다 — 유저가 실제로 받는 경로기 때문이다.
   */
  normalizedObserved?: string;
  /**
   * 그 정규화문을 **실 provider 에 그대로 태워 받은** 의도 토큰(2026-08-23 프로브 3/3).
   *
   * ⚠️ 이 필드가 있어야 정규화 축이 의미를 갖는다. stub 에 편의대로 `RULE_TERM` 을 주면
   *   게이트는 "provider 가 협조하면 잘 된다" 만 증명한다 — 실측은 그 반대였다
   *   (`직관 기록` → 3/3 `RECORD` → 되묻기). 가드 비소유면 이 필드는 불필요하다.
   */
  normalizedProbedIntent?: "record" | "narrative" | "rule_term";
}> = [
  {
    question: "오늘 롯데 경기 누가 안타쳐서 7점 득점 낸거야",
    guard: false,
    expect: "history_hold",
    why: "`누가`(의문사)는 엔티티가 아니다. 당일 경기 기록은 우리가 서빙하지 않으므로 '기록 준비 안 됨' 안내가 정답이고, '앞말이 선수 이름인지 모르겠다'는 오답이다",
    llmCalls: 0,
  },
  {
    question: "아니 KBO 오고 나서 친 모든 홈런의 갯수",
    guard: true,
    probedIntent: "record",
    expect: "stat_clarify",
    why: "대상이 특정되지 않은 채 통산 홈런 **값**을 요구한다 — 가드가 소유하는 게 맞고 되묻기가 정답이다(무회귀 축)",
    llmCalls: 1,
  },
  {
    question: "인사이드 더 파크 홈런이 므ㅏ야?",
    guard: true,
    probedIntent: "rule_term",
    expect: "llm",
    why: "용어 정의 질문이다. 값 요구가 아니므로 재질의 후 정상 답변이 나가야 한다",
    llmCalls: 2,
  },
  {
    question: "점수차가 많이 날때 점수 많은 쪽 팀이 도루를 하면 안되는 이유가 뭐야?",
    guard: true,
    probedIntent: "rule_term",
    expect: "llm",
    why: "불문율(룰·관습) 질문이다",
    llmCalls: 2,
  },
  {
    question: "점수 차가 많이 날때 도루를 왜 하면 안되냐고",
    guard: true,
    probedIntent: "rule_term",
    expect: "llm",
    why: "위와 같은 질문의 후속 재질문이다",
    llmCalls: 2,
  },
  {
    question: "그럼 안타를 치고 1루를 밟든 2루를 밟든 3루를 밟든 하나의 도루로 인정되는 거야?",
    guard: true,
    probedIntent: "rule_term",
    expect: "llm",
    why: "도루의 정의를 확인하는 룰 질문이다",
    llmCalls: 2,
  },
  {
    question: "무사 주자1루 4점차면 세이브 조건인가요?",
    guard: false,
    expect: "llm",
    why: "head `4점차면` 은 숫자로 시작해 엔티티가 아니다. 세이브 요건은 룰 질문이므로 일반 경로로 답해야 한다",
    llmCalls: 1,
  },
  {
    question: "몇호 홈런 그런거 뜻이 뭐야",
    guard: true,
    probedIntent: "rule_term",
    expect: "llm",
    why: "'몇호 홈런' 표기의 뜻을 묻는 용어 질문이다",
    llmCalls: 2,
  },
  {
    question: "31호 홈런",
    guard: false,
    expect: "llm",
    why: "head `31호` 는 숫자로 시작해 엔티티가 아니다",
    llmCalls: 1,
  },
  {
    question: "1루타 2루타 3루카 홈런 다치는거 뭐야?",
    guard: false,
    expect: "llm",
    why: "head `3루카`(3루타 오타) 는 숫자로 시작해 엔티티가 아니다. 안타 종류를 묻는 용어 질문이다",
    llmCalls: 1,
  },
  {
    question: "직관기록",
    guard: false,
    // 🔁 기대값 변경 이력 (2026-08-23) — 종전 `llm` → 현 `product_feature_guide`.
    //
    //   #1288 까지는 `llm` 을 기대했는데, 그건 **stub 답변에 결속된 값**이었다.
    //   배포 후 종단 QA 실측에서 실 provider 는 `직관 기록` 을 3/3 **범위 밖(BLOCKED)**
    //   으로 판정해 "제가 확인할 수 있는 범위는 …" 를 내보냈다. 즉 `llm` 은 달성 불가능한
    //   기대였고, 삼순가 2차 리뷰에서 "#11 기대를 `llm` 인지 제품의 직관기록 서비스
    //   경로인지 먼저 확정하라" 고 지적한 지점이 바로 이것이다.
    //
    //   하린아빠가 2026-08-23 에 **서비스 경로 안내**로 확정했다 — `직관 기록` 은
    //   우리 앱의 기능(마이페이지)이므로 "범위 밖" 이 아니라 그 경로를 알려줌다.
    //
    // ⚠️ 기대값을 현재 출력에 맞춰 베낀 것이 아니라 **제품 결정이 먼저 났고** 그것을
    //   반영한 것이다. 그 순서가 지켜지지 않으면 게이트는 틀린 종단을 정답으로 고정하는 도구가 된다.
    expect: "product_feature_guide",
    why: "우리 앱에 실재하는 기능(마이페이지 > 직관 기록)을 물었다 — 범위 밖이라 말하거나 이름을 되묻는 것이 아니라 그 경로를 안내해야 한다",
    llmCalls: 0,
    // 🔴 배포 정규화가 띄어쓰기를 넣어 `직관 기록` 으로 바꾸지만, 이제 둘 다
    //   같은 종단으로 간다(공백 제거 후 비교 + 문법 꾸리 허용). 정규화가 라우팅을
    //   뒤집지 않는 것 자체가 #1288 이 고친 결함의 재발 방지다.
    normalizedObserved: "직관 기록",
  },
];

// ── 결정론 stub deps ────────────────────────────────────────────────────────
interface StubState {
  llmTexts: string[];
  llmCalls: number;
  guardModes: Array<boolean | undefined>;
  logs: Array<{
    matchPath: MatchPath;
    answer: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    /** 배포가 `question_normalized` 칸에 적는 값 — 수용된 정규화문만 채워진다. */
    questionNormalized?: string | null;
    /** 미호출·수용·거절·오류를 구분하는 관측 상태. */
    normalizeStatus?: string | null;
    /** 로그에 남은 질문(원문이어야 한다 — 정규화문으로 덮이면 감사 분모가 깨진다). */
    question?: string;
  }>;
  /**
   * `normalizeQuestionLlm` seam stub (2026-08-23 삼순 NO-GO ①).
   * 지정하면 그 질문에 대해 이 문자열을 표기 교정 결과로 돌려준다 —
   * 정규화문을 **새 질문으로 직접 태우지 않고** 원문 1회 호출 안에서 seam 을 태우기 위함.
   */
  normalizeTo?: string | null;
  /** 정규화 seam 이 실제로 호출됐는지 — 미호출이면 그 축은 검증되지 않은 것이다. */
  normalizeCalls: number;
  cache: Map<string, string>;
  stored: LlmResult | null;
  storeCalls: number;
  /** n 번째(0-base) callLlm 에서 throw — 재질의 실패 축 재현용 */
  throwAtCall?: number;
  /** storeLlm 직후 crash 모사 — log 를 못 쓰게 한다 */
  crashAfterStore?: boolean;
}
function freshState(...llmTexts: string[]): StubState {
  return {
    llmTexts, llmCalls: 0, guardModes: [], logs: [], cache: new Map(),
    stored: null, storeCalls: 0, normalizeCalls: 0,
  };
}
function makeDeps(state: StubState): QaDeps {
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => players,
    getCache: async (key) => state.cache.get(key) ?? null,
    setCache: async (key, value) => { state.cache.set(key, value); },
    callLlm: async (_q, _ctx, _roster, statIntentMode): Promise<LlmResult> => {
      state.guardModes.push(statIntentMode);
      const idx = state.llmCalls;
      state.llmCalls += 1;
      if (state.throwAtCall === idx) throw new Error("provider down");
      const text = state.llmTexts[idx] ?? state.llmTexts[state.llmTexts.length - 1] ?? "";
      return { text, inputTokens: 100 + idx, outputTokens: 10 + idx };
    },
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async (entry) => {
      state.logs.push({
        matchPath: entry.matchPath,
        answer: entry.answer ?? null,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        questionNormalized: entry.questionNormalized ?? null,
        normalizeStatus: entry.normalizeStatus ?? null,
        question: entry.question,
      });
    },
    // ⚠️ 정규화 seam (삼순 2026-08-23 NO-GO ①). 미지정이면 주입하지 않아 종전 계약 그대로다
    //   — `normalizeQuestionLlm` 미주입 = 정규화 단계 비활성(배포도 같은 계약).
    ...(state.normalizeTo === undefined ? {} : {
      normalizeQuestionLlm: async (_q: string) => {
        state.normalizeCalls += 1;
        return { text: state.normalizeTo ?? null, inputTokens: 7, outputTokens: 3 };
      },
    }),
    storeLlm: async (result) => {
      state.storeCalls += 1;
      state.stored = result;
      if (state.crashAfterStore) throw new Error("crash after store");
    },
    getLlmState: async () => ({ started: state.stored !== null, result: state.stored, ownerActive: false }),
    acquireLlmStart: async () => true,
  };
}

let failures = 0;
/**
 * 실제로 **실행된** 축 수. 하드코딩 합계를 쓰면 축을 늘리고 숫자를 안 고쳤을 때
 * 보고가 조용히 틀리고(2026-08-23 삼순 3차: 실제 33축인데 28로 표기), 더 나쁘게는
 * 축이 통째로 안 돌아도 숫자가 그대로라 **누락이 안 보인다**. 카운터가 유일한 SSOT다.
 */
let executed = 0;
/** 축 이름 중복 검출 — 같은 이름이 둘이면 어느 쪽이 돌았는지 로그로 특정할 수 없다. */
const seenNames = new Set<string>();
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (seenNames.has(name)) {
    failures += 1;
    console.log(`  ❌ [SCM-FAIL] 축 이름 중복: ${name}`);
    return;
  }
  seenNames.add(name);
  executed += 1;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures += 1;
    // ⚠️ 실패 줄에만 나타나는 안정 ID — 통과 출력(✅)과 겹치지 않는다.
    console.log(`  ❌ [SCM-FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  console.log("── A. 프롬프트·토큰 폐쇄집합 계약 ──");
  await check("A1 STAT_INTENT_PROMPT 가 세 토큰을 각각 **정의**한다", () => {
    // ⚠️ `RULE_TERM` 문자열 포함만 보면 안 된다 — 예시·출력형식 줄에도 그 단어가 있어
    //   **정의 줄을 통째로 지워도 GREEN** 이 된다(2026-08-22 M7 실측 false-GREEN).
    for (const token of ["RECORD", "NARRATIVE", "RULE_TERM"]) {
      assert.match(
        STAT_INTENT_PROMPT,
        new RegExp(`(?:^|\\n)${token}\\s*—\\s*\\S`),
        `프롬프트에 ${token} 정의 줄이 없음`,
      );
    }
    assert.match(STAT_INTENT_PROMPT, /세 토큰/, "토큰 개수 문구 미갱신");
    // 코드 폐쇄집합과 프롬프트가 갈라지면 LLM 이 코드가 안 받는 토큰을 낸다.
    assert.match(STAT_INTENT_PROMPT, /RECORD 또는 NARRATIVE 또는 RULE_TERM/, "출력 형식 문구 미갱신");
  });
  await check("A2 parseStatIntentToken 폐쇄집합 3 + 그 밖 전량 거절", () => {
    assert.equal(parseStatIntentToken(INTENT("RECORD")), "record");
    assert.equal(parseStatIntentToken(INTENT("NARRATIVE")), "narrative");
    assert.equal(parseStatIntentToken(INTENT("RULE_TERM")), "rule_term");
    assert.equal(parseStatIntentToken(INTENT("RULE")), null);
    assert.equal(parseStatIntentToken(NORMAL_ANSWER), null, "자유문장이 토큰으로 인정되면 안 됨");
    assert.equal(parseStatIntentToken('{"status":"ANSWER","answer":"RULE_TERM"}'), null);
    assert.equal(parseStatIntentToken("not json"), null);
  });

  console.log("── B. 로그 11건 **전수 종단 실행** (삼순 P0①) ──");
  assert.equal(LOG_CASES.length, 11, "로그 전수 11건이 아니다 — 분모 절단");
  for (const c of LOG_CASES) {
    await check(`B [${c.expect}] ${c.question.slice(0, 34)}`, async () => {
      // 가드 소유 여부부터 고정한다 — 종단만 보면 다른 이유로 같은 결과가 나올 수 있다.
      assert.equal(
        statGuardOwnsQuestion(c.question, glossary, players),
        c.guard,
        `가드 소유 판정 불일치 (기대 ${c.guard})`,
      );
      // 가드 소유면 1차는 **실 provider 실측 토큰**, 2차는 일반 답변.
      const texts = c.guard ? [INTENT(c.probedIntent!.toUpperCase()), NORMAL_ANSWER] : [NORMAL_ANSWER];
      const state = freshState(...texts);
      const r = await answerQuestion("u-log", c.question, makeDeps(state));

      assert.equal(r.source, c.expect, `source 불일치 — ${c.why}`);
      assert.equal(state.llmCalls, c.llmCalls, `LLM 호출 횟수 불일치 (실제 ${state.llmCalls})`);
      assert.deepEqual(
        state.logs.map((l) => l.matchPath), [c.expect],
        `로그 경로 불일치: ${state.logs.map((l) => l.matchPath).join(",")}`,
      );
      // 답변 문면까지 고정 — source 만 보면 "이름만 바뀐 되묻기"를 못 잡는다.
      if (c.expect === "stat_clarify") {
        assert.equal(r.answer, STAT_CLARIFY_ANSWER);
      } else if (c.expect === "history_hold") {
        assert.equal(r.answer, HISTORY_HOLD_ANSWER);
      } else if (c.expect === "product_feature_guide") {
        // 우리 앱 기능 안내 — 코드가 정한 고정문이고, 판정기와 **같은 함수**로 다시 푼다.
        //   게이트가 문구를 복제하면 상수가 바뀔 때 게이트만 낡는다(생성기 값을 읽는다).
        const feature = resolveProductFeature(c.question);
        assert.ok(feature, "판정기가 기능을 못 풀었다 — 라우팅과 문구가 갈라진다");
        assert.equal(r.answer, PRODUCT_FEATURE_GUIDE_ANSWERS.get(feature!), "기능 안내 문구 불일치");
        // 되묻기·범위 밖 안내로 새지 않는다 — 이 PR 이 고치는 두 오답 형태다.
        assert.notEqual(r.answer, STAT_CLARIFY_ANSWER, "되묻기로 끝났다");
        assert.notEqual(r.answer, BLOCKED_ANSWER, "범위 밖 안내로 끝났다");
      } else {
        assert.equal(r.answer, RULE_ANSWER, "정상 답변이 서빙되지 않음");
        assert.notEqual(r.answer, STAT_CLARIFY_ANSWER);
      }
      // 재질의는 반드시 **일반 프롬프트**로 간다(가드 모드로 되물으면 토큰만 또 온다).
      if (c.llmCalls === 2) assert.deepEqual(state.guardModes, [true, false], "재질의 프롬프트 모드 오류");
    });
  }
  await check("B-총계 되묻기로 끝나는 건 '값 요구' 1건뿐", () => {
    const clarify = LOG_CASES.filter((c) => c.expect === "stat_clarify");
    assert.equal(clarify.length, 1, `되묻기 종결이 ${clarify.length}건 — 11건 중 1건(값 요구)이어야 한다`);
  });

  console.log("── B2. **full normalization seam** — 원문 1회 호출 안에서 정규화까지 (삼순 NO-GO ①) ──");
  //
  // 왜 이 축이 필요한가 — 게이트가 원문만 태우면 정규화가 라우팅을 뒤집는 경우를 구조적으로
  // 볼 수 없다. `직관기록` 은 가드 비소유라 GREEN 이었지만, 배포가 실제로 판정하는
  // `직관 기록` 은 가드 소유라 유저가 되묻기를 받았다(프로덕션 3/3 고정 재현).
  //
  // ⚠️ **정규화문을 새 질문으로 직접 태우지 않는다** (삼순 2026-08-23 NO-GO ①).
  //   그건 여전히 prod seam 우회다 — `normalizeQuestionLlm → accepted_surface →
  //   question_normalized → 재라우팅` 이 한 흐름으로 이어지는지를 증명하지 못한다.
  //   여기서는 **원문을 1회 `answerQuestion` 에 넣고** normalizer seam 을 stub 으로 주입해
  //   ①정규화 호출 ②수용 판정 ③로그 필드 ④최종 source 를 한 흐름으로 고정한다.
  //
  // ⚠️ 정규화 산출물은 추측이 아니라 **프로덕션 로그 `question_normalized` 실측치**다.
  const normalizedCases = LOG_CASES.filter((c) => typeof c.normalizedObserved === "string");
  await check("B2-0 정규화 실측치가 있는 케이스가 최소 1건 존재한다", () => {
    // 0 건이면 아래 루프가 통째로 안 돌아 "PASS" 가 된다 — 빈 루프 false-GREEN 방지.
    assert.ok(normalizedCases.length >= 1, "normalizedObserved 케이스가 0 건 — 정규화 축이 검증되지 않는다");
  });
  for (const c of normalizedCases) {
    const normalized = c.normalizedObserved!;
    await check(`B2 [${c.expect}] "${c.question}" ―(정규화)→ "${normalized}" full seam`, async () => {
      // ⚠️ **축에 이빨이 있는지 먼저 증명한다** (2026-08-23 mutation 실측).
      //   처음엔 이 단언이 없었고, 산출물을 원문과 같게 바꾸는 mutation 을 넘겼다 —
      //   축이 무효화됐는데도 GREEN(바로 그 false-GREEN 형태).
      assert.notEqual(
        normalized, c.question,
        "정규화문이 원문과 같다 — 이 케이스는 정규화 축을 검증하지 못한다(무효 fixture)",
      );

      // 가드 소유 여부는 **정규화문 기준**으로 갈린다 — 실측 의도 토큰이 필요한지 그것으로 정한다.
      const normGuard = statGuardOwnsQuestion(normalized, glossary, players);
      if (normGuard) {
        // 여기서 `RULE_TERM` 을 임의로 주면 게이트가 현실이 아니라 희망을 검증한다
        //   — 실 provider 프로브 실측은 3/3 `RECORD` 였다.
        assert.ok(
          c.normalizedProbedIntent,
          "가드 소유 정규화문인데 실측 의도 토큰이 없다 — 추측 토큰으로 태우면 false-GREEN 이다",
        );
      }
      const texts = normGuard
        ? [INTENT(c.normalizedProbedIntent!.toUpperCase()), NORMAL_ANSWER]
        : [NORMAL_ANSWER];

      const state = freshState(...texts);
      state.normalizeTo = normalized;              // seam 주입 — 배포의 provider 자리에 앉는다
      const r = await answerQuestion("u-seam", c.question, makeDeps(state));  // ← **원문** 1회 호출

      // ⚠️ 정규화는 **residual(`llm_scope_gate`)** 에서만 발동한다(배포 계약).
      //   전용 라우트가 먼저 확정되면 정규화 자체가 안 타므로, 이 축은 두 경우를 나누어 본다:
      //     · residual 문장 → seam 호출·수용·로그 필드까지 전부 고정
      //     · 전용 라우트 문장 → 정규화 미발동이 정상이고, 대신 **원문·정규화문 둘 다**
      //       같은 종단으로 가는지를 본다(정규화가 라우팅을 뒤집지 못하는 것이 계약이다).
      const routedBeforeNormalize = routeQuestion(c.question, glossary, players, false);
      const log = state.logs.at(-1);
      assert.ok(log, "로그 없음");
      if (routedBeforeNormalize === "llm_scope_gate") {
        assert.equal(state.normalizeCalls, 1, `정규화 seam 미호출 (calls=${state.normalizeCalls})`);
        assert.equal(log!.normalizeStatus, "accepted_surface",
          `정규화가 수용되지 않았다 (status=${log!.normalizeStatus}) — 재라우팅 자체가 안 일어난다`);
        assert.equal(log!.questionNormalized, normalized,
          `question_normalized 불일치 (${log!.questionNormalized})`);
      } else {
        assert.equal(state.normalizeCalls, 0,
          `전용 라우트(${routedBeforeNormalize})인데 정규화가 발동했다 — residual 전용 계약 위반`);
        assert.equal(
          routeQuestion(normalized, glossary, players, false), routedBeforeNormalize,
          `정규화문의 라우팅이 원문과 다르다 — #1288 결함의 재발이다`);
      }
      // 로그 필드 계약: question 은 항상 **원문**이다.
      assert.equal(log!.question, c.question, "로그 question 이 원문이 아니다 — 감사 분모가 깨진다");
      // ④ 최종 종단 — 정규화를 거친 뒤에도 원문 기대와 같아야 한다.
      assert.equal(
        r.source, c.expect,
        `정규화 후 종단이 기대와 다르다 (기대 ${c.expect} ≠ 실제 ${r.source}) — ${c.why}`,
      );
      assert.notEqual(
        r.answer, STAT_CLARIFY_ANSWER,
        "정규화문이 되묻기로 끝난다 — 질문에 사람 이름이 없는데 이름을 되묻는 동문서답이다",
      );
      assert.deepEqual(
        state.logs.map((l) => l.matchPath), [c.expect],
        `로그 경로 불일치: ${state.logs.map((l) => l.matchPath).join(",")}`,
      );
    });
  }
  await check("B2-2 반대축 — 정규화가 라우팅을 **정당하게** 바꾸면 그 결과를 따른다", async () => {
    // ⚠️ 이 축이 없으면 M11(정규화 결과를 버리고 원문 진행)이 **무증상**이다
    //   (2026-08-23 mutation 실측: 게이트가 못 잡음). `직관기록` 은 수정 후 원문·정규화문이
    //   둘 다 `llm` 로 끝나서, 정규화를 버려도 종단이 같아 관측 자체가 불가능하다.
    //   관측 가능성은 mutation 의 1급 속성이다 — 무대가 없으면 결함이 아니라 무증상이 된다.
    //
    //   `오타니홈런몇개` 는 정반대 방향의 실제 케이스다:
    //     원문      `오타니홈런몇개`   → `<X> <지표>` 매치 없음(guard=false) → llm
    //     정규화문  `오타니 홈런 몇개` → 미결속 엔티티(guard=true)          → 되묻기
    //   여기서 되묻기는 **옳다** — 오타니는 로스터에 없는 실제 미결속 대상이라 값을 줄 수 없다.
    //   즉 정규화가 라우팅을 바꾸는 것이 정상 동작이며, 그 결과를 따라야 한다.
    //
    // ⚠️ 이 축은 삼순 2026-08-23 요구(`오타니홈런몇개` 무회귀)와 같은 대상이다 —
    //   폐기한 blanket route-invariance 안이 바로 이 정당한 교정을 막았다.
    const raw = "오타니홈런몇개";
    const corrected = "오타니 홈런 몇개";
    assert.equal(statGuardOwnsQuestion(raw, glossary, players), false, "원문이 이미 가드 소유 — 무대가 사라졌다");
    assert.equal(statGuardOwnsQuestion(corrected, glossary, players), true, "정규화문이 가드 비소유 — 무대가 사라졌다");

    const state = freshState(INTENT("RECORD"));
    state.normalizeTo = corrected;
    const r = await answerQuestion("u-seam2", raw, makeDeps(state));

    assert.equal(state.normalizeCalls, 1, "정규화 seam 미호출");
    const log = state.logs.at(-1)!;
    assert.equal(log.normalizeStatus, "accepted_surface", `수용되지 않음 (${log.normalizeStatus})`);
    assert.equal(log.questionNormalized, corrected, "question_normalized 불일치");
    assert.equal(log.question, raw, "로그 question 이 원문이 아니다");
    // 핵심: 정규화 결과를 버리면 여기가 `llm` 이 된다 — M11 이 잡히는 지점.
    assert.equal(r.source, "stat_clarify",
      `정규화 결과가 라우팅에 반영되지 않았다 (${r.source}) — 미결속 대상에 값을 줄 수 없으므로 되묻기가 정답이다`);
    assert.equal(r.answer, STAT_CLARIFY_ANSWER);
  });
  await check("C7 bare-head 과확장 반대축 — `직관 <지표>` 임의 결합은 열리지 않는다 (삼순 3차 NO-GO ②)", () => {
    // ⚠️ C6 은 **지표어가 없는 문장**만 봐서 bare-head 승격 위험을 못 잡는다
    //   (`내 직관이 맞아?` 는 `<X> <지표>` 매치 자체가 없어 어느 구현에서도 `[]`).
    //   실제 위험은 `직관` 이 전역 어휘집에 오르면 **`직관`+아무 지표어** 결합이
    //   검증 근거 없이 용어로 열리는 것이다. 그 차이가 관측되는 무대가 여기다:
    //
    //     구현            `직관 스탯` / `직관 타율`
    //     compound-only   ambiguous     (열리지 않음 — 계약)
    //     bare 승격       term_question (검증 근거 없이 열림 — M10 이 주입하는 결함)
    //
    //   `직관 기록` 만 열리는 이유는 그것이 **우리 앱에 실재하는 기능명**이기 때문이고,
    //   `직관 스탯`·`직관 타율` 은 실재하지 않으므로 근거가 없다.
    for (const q of ["직관 스탯", "직관 타율"]) {
      const kinds = classifyNamedStatMatches(q.normalize("NFKC").toLowerCase(), glossary, players);
      assert.ok(
        kinds.includes("ambiguous"),
        `bare-head 과확장: "${q}" 가 근거 없이 열렸다 → ${JSON.stringify(kinds)}`,
      );
      assert.ok(
        !kinds.includes("term_question"),
        `"${q}" 가 검증 근거 없이 용어로 판정됐다`,
      );
    }
    // 무회귀: 실재 기능명 결합형은 그대로 열려 있어야 한다(과잉 차단 방지).
    assert.ok(
      classifyNamedStatMatches("직관 기록".normalize("NFKC").toLowerCase(), glossary, players)
        .includes("term_question"),
      "제품 기능 결합형이 닫혔다",
    );
  });
  await check("C8 route 축 — bare 승격이 라우팅 판정을 바꾸지 않는다", () => {
    // classifier 뿐 아니라 **라우터**로도 본다 — 어휘집은 `routeQuestion` 의 범위 판정에도
    // 쓰이므로, 한 축만 보면 다른 축의 과확장을 놓친다(삼순 3차 NO-GO ② 'route/classifier').
    for (const q of ["내 직관이 맞아?", "직관은 논리와 달라?", "직관적으로 이해가 안 돼",
                     "직관력이 뭐야", "직관 가고싶다", "직관 승률"]) {
      assert.equal(
        routeQuestion(q, glossary, players, false), "llm_scope_gate",
        `다의어 문장의 라우팅이 바뀌었다: "${q}"`,
      );
      assert.equal(
        statGuardOwnsQuestion(q, glossary, players), false,
        `다의어 문장이 가드 소유가 됐다: "${q}"`,
      );
    }
  });
  await check("C6 다의어 반대축 — bare `직관`(intuition)은 야구 어휘가 아니다 (삼순 NO-GO ②)", () => {
    // 전역 `BASEBALL_WORDS` 에 bare `직관` 을 넣으면 일반어까지 라우터·validator 어휘로
    // 승격된다. 결합형 exact 폐쇄집합으로만 여는 계약을 여기서 못 박는다.
    for (const q of ["내 직관이 맞아?", "직관은 논리와 달라?", "직관적으로 이해가 안 돼", "직관력이 뭐야"]) {
      const kinds = classifyNamedStatMatches(q.normalize("NFKC").toLowerCase(), glossary, players);
      assert.deepEqual(kinds, [], `다의어 일반어가 야구 판정에 걸렸다: "${q}" → ${JSON.stringify(kinds)}`);
    }
    // 결합형만 열린다 — head 단독 승격이면 위 4건이 깨진다(M10 이 이 축을 태운다).
    assert.ok(
      classifyNamedStatMatches("직관 기록".normalize("NFKC").toLowerCase(), glossary, players)
        .includes("term_question"),
      "제품 기능 결합형이 안 열린다",
    );
  });
  await check("B2-1 정규화 seam 무회귀 — 미주입이면 정규화 단계 자체가 비활성", async () => {
    // 배포도 `normalizeQuestionLlm` 미주입이면 이 단계를 타지 않는다(기존 계약).
    const state = freshState(NORMAL_ANSWER);
    await answerQuestion("u-noseam", "직관기록", makeDeps(state));
    assert.equal(state.normalizeCalls, 0, "seam 미주입인데 정규화가 호출됐다");
    assert.equal(state.logs.at(-1)!.normalizeStatus, null, "미호출인데 normalizeStatus 가 채워졌다");
  });

  console.log("── C. 과잉 완화 방지 · 기존 계약 무회귀 ──");
  await check("C1 숫자 시작이 아닌 미결속은 그대로 가드 소유", () => {
    assert.equal(statGuardOwnsQuestion("이대호 홈런 몇개", glossary, players), true);
  });
  await check("C2 결속 선수는 여전히 entity_stat", () => {
    const bound = players[0].name;
    assert.ok(
      classifyNamedStatMatches(`${bound} 홈런`.normalize("NFKC").toLowerCase(), glossary, players)
        .includes("entity_stat"),
      `${bound} 결속 실패`,
    );
  });
  await check("C3 혼합형(결속+미결속)은 여전히 앞단 되묻기", () => {
    const q = `${players[0].name} 홈런과 이대호 홈런 몇개`;
    const kinds = classifyNamedStatMatches(q.normalize("NFKC").toLowerCase(), glossary, players);
    assert.ok(kinds.includes("ambiguous"), "미결속 절이 사라짐");
    assert.ok(kinds.includes("entity_stat") || mentionsTeamForGate(q), "결속 절이 사라짐");
  });
  await check("C4 RECORD → 되묻기 / NARRATIVE → 고정 응대 (재질의 없음)", async () => {
    const rec = freshState(INTENT("RECORD"));
    const r1 = await answerQuestion("u-rec", "이대호 홈런 몇개", makeDeps(rec));
    assert.equal(r1.answer, STAT_CLARIFY_ANSWER);
    assert.equal(rec.llmCalls, 1, "RECORD 는 재질의하지 않는다");
    const nar = freshState(INTENT("NARRATIVE"));
    const r2 = await answerQuestion("u-nar", "친구가 이대호 홈런 영상을 보내줬어", makeDeps(nar));
    assert.equal(r2.answer, STAT_NARRATIVE_ANSWER);
    assert.equal(nar.llmCalls, 1, "NARRATIVE 는 재질의하지 않는다");
  });
  await check("C5 토큰 밖 자유문장 → 되묻기 (자유문장 서빙 0 불변)", async () => {
    const state = freshState(NORMAL_ANSWER);
    const r = await answerQuestion("u-free", "이대호 홈런 몇개", makeDeps(state));
    assert.equal(r.source, "stat_clarify", "가드 소유 경로가 자유문장을 서빙했다");
    assert.equal(state.llmCalls, 1);
  });

  console.log("── D. durable store / replay (삼순 P0②) ──");
  await check("D1 재질의 성공답은 store-before-log 로 envelope 에 저장된다", async () => {
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    await answerQuestion("u-store", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.ok(state.stored, "재질의 성공답이 저장되지 않음 — crash 시 정상답 유실");
    const env = unpackStoredQaFinal(state.stored!.text);
    assert.ok(env, "envelope 파싱 실패");
    assert.equal(env!.source, "llm");
    assert.equal(env!.answer, RULE_ANSWER);
    assert.equal(env!.statRuleTermVerified, true, "검증 완료 표식 없음 — 재생이 되묻기로 덮어쓴다");
    assert.notEqual(env!.cacheable, true, "가드 소유 답에 cacheable 이 붙었다");
  });
  await check("D2 store 직후 crash → 재시도가 정상답을 그대로 복원한다", async () => {
    // 1차 시도: store 성공 직후 crash (log 미기록)
    const first = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    first.crashAfterStore = true;
    let crashed = false;
    try {
      await answerQuestion("u-replay", "이대호 홈런 어떻게 기록되는거야", makeDeps(first));
    } catch { crashed = true; }
    assert.ok(crashed, "crash 모사 실패");
    assert.ok(first.stored, "crash 전에 저장이 안 됨");
    assert.equal(first.logs.length, 0, "log 가 기록됐다 — crash 모사가 무의미");

    // 2차 시도(재시도): 저장된 envelope 을 읽어 재생
    const retry = freshState();
    retry.stored = first.stored;
    const r = await answerQuestion("u-replay", "이대호 홈런 어떻게 기록되는거야", makeDeps(retry));
    assert.equal(r.answer, RULE_ANSWER, "재생이 정상답을 복원하지 못함(되묻기로 덮어씀)");
    assert.equal(r.source, "llm");
    assert.equal(retry.llmCalls, 0, "재생인데 LLM 을 다시 태웠다 — 1회 소비 계약 위반");
  });
  await check("D3 표식 없는 자유문장 envelope 는 여전히 되묻기로 거절 (구버전·오염 방어)", async () => {
    const retry = freshState();
    retry.stored = packStoredQaFinal(
      { answer: "근거 없는 374개 단정 답변입니다.", source: "llm" },
      { text: "", inputTokens: null, outputTokens: null },
    );
    const r = await answerQuestion("u-legacy", "이대호 홈런 몇개", makeDeps(retry));
    assert.equal(r.source, "stat_clarify", "표식 없는 envelope 이 서빙됐다");
  });
  await check("D4 재질의 성공답은 global 캐시에 쓰지 않는다", async () => {
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    await answerQuestion("u-nocache", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(state.cache.size, 0, `가드 소유 답이 캐시됨 (${state.cache.size})`);
  });

  console.log("── E. 오류·판정 의미와 토큰 계측 (삼순 P0③) ──");
  await check("E1 재질의 provider 오류 → `error` (유저 질문 탓으로 돌리지 않는다)", async () => {
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    state.throwAtCall = 1; // 2번째 호출(재질의)에서 throw
    const r = await answerQuestion("u-err", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(r.source, "error", `기대 error, 실제 ${r.source}`);
    assert.equal(r.answer, SYSTEM_ERROR_ANSWER);
    assert.notEqual(r.answer, STAT_CLARIFY_ANSWER, "우리 고장을 '이름을 정확히 쓰라'로 돌렸다");
    assert.deepEqual(state.logs.map((l) => l.matchPath), ["error"]);
  });
  await check("E2 재질의 blocked → `blocked` (일반 경로 의미 그대로)", async () => {
    const state = freshState(INTENT("RULE_TERM"), '{"status":"NOT_BASEBALL"}');
    const r = await answerQuestion("u-blk", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(r.source, "blocked", `기대 blocked, 실제 ${r.source}`);
    assert.equal(r.answer, BLOCKED_ANSWER);
  });
  await check("E3 재질의 unsure → `unsure` (되묻기로 뭉개지 않는다)", async () => {
    const state = freshState(INTENT("RULE_TERM"), '{"status":"UNSURE"}');
    const r = await answerQuestion("u-uns", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(r.source, "unsure", `기대 unsure, 실제 ${r.source}`);
    assert.equal(r.answer, UNCLEAR_ANSWER);
  });
  await check("E4 두 호출 토큰 **합산** 계측 (한쪽만 적으면 과소계측)", async () => {
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    await answerQuestion("u-tok", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    const log = state.logs[0];
    // stub 은 호출 순서대로 input 100,101 / output 10,11 을 낸다.
    assert.equal(log.inputTokens, 201, `input 합산 오류 (${log.inputTokens})`);
    assert.equal(log.outputTokens, 21, `output 합산 오류 (${log.outputTokens})`);
  });
  await check("E5 blocked/unsure 도 토큰 합산", async () => {
    const state = freshState(INTENT("RULE_TERM"), '{"status":"UNSURE"}');
    await answerQuestion("u-tok2", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(state.logs[0].inputTokens, 201);
  });

  // ── selftest: 계약 자체를 반전시켜 RED 가 나오는지 확인 ──────────────────
  if (SELFTEST) {
    console.log("── SELFTEST: 계약 반전 시 RED 인지 ──");
    const before = failures;
    await check("S1 (의도적 RED) 숫자 head 가 가드 소유면 잡힌다", () => {
      assert.equal(statGuardOwnsQuestion("31호 홈런", glossary, players), true, "S1 기대 RED");
    });
    await check("S2 (의도적 RED) 재질의 답이 캐시되면 잡힌다", async () => {
      const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
      await answerQuestion("u-s2", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
      assert.ok(state.cache.size > 0, "S2 기대 RED");
    });
    if (failures !== before + 2) {
      console.log("  ❌ [SCM-FAIL] selftest 가 RED 2건을 만들지 못했다 — 검증력 없음");
      process.exit(1);
    }
    failures = before;
    console.log("  ✅ selftest RED 2/2 확인");
  }

  // ⚠️ 실행 카운터가 SSOT. 더불어 **하한**을 걸어 축이 통째로 빠지는 것을 막는다 —
  //   카운터만 쓰면 "0축 실행 · 실패 0" 도 PASS 로 보이기 때문이다(빈 실행 false-GREEN).
  //   하한은 구조에서 유도한다(고정축 + 로그 전수) — 손으로 적은 합계를 다시 만들지 않는다.
  const MIN_AXES = LOG_CASES.length + 20;
  console.log(`\n총 ${executed}축 실행 · 실패 ${failures}`);
  if (executed < MIN_AXES) {
    console.log(`  ❌ [SCM-FAIL] 실행 축이 하한 미만 (${executed} < ${MIN_AXES}) — 축이 누락됐다`);
    process.exit(1);
  }
  if (failures > 0) process.exit(1);
  console.log("✅ stat-clarify 오발동 게이트 PASS");
}

main().catch((e) => {
  console.error(`[SCM-FAIL] 게이트 실행 실패: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
