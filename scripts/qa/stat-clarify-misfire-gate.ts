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
  statGuardOwnsQuestion,
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
 */
const LOG_CASES: Array<{
  question: string;
  guard: boolean;
  probedIntent?: "record" | "narrative" | "rule_term";
  expect: MatchPath;
  /** 그 종단이 왜 옳은지 — 리뷰어가 기대값 자체를 검증할 수 있게 남긴다. */
  why: string;
  llmCalls: number;
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
    expect: "llm",
    why: "`<X> <지표>` 매치 자체가 없다 — 가드 대상이 아니다",
    llmCalls: 1,
  },
];

// ── 결정론 stub deps ────────────────────────────────────────────────────────
interface StubState {
  llmTexts: string[];
  llmCalls: number;
  guardModes: Array<boolean | undefined>;
  logs: Array<{ matchPath: MatchPath; answer: string | null; inputTokens: number | null; outputTokens: number | null }>;
  cache: Map<string, string>;
  stored: LlmResult | null;
  storeCalls: number;
  /** n 번째(0-base) callLlm 에서 throw — 재질의 실패 축 재현용 */
  throwAtCall?: number;
  /** storeLlm 직후 crash 모사 — log 를 못 쓰게 한다 */
  crashAfterStore?: boolean;
}
function freshState(...llmTexts: string[]): StubState {
  return { llmTexts, llmCalls: 0, guardModes: [], logs: [], cache: new Map(), stored: null, storeCalls: 0 };
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
      });
    },
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
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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

  const total = 2 + LOG_CASES.length + 1 + 5 + 4 + 5;
  console.log(`\n총 ${total}축 검사 · 실패 ${failures}`);
  if (failures > 0) process.exit(1);
  console.log("✅ stat-clarify 오발동 게이트 PASS");
}

main().catch((e) => {
  console.error(`[SCM-FAIL] 게이트 실행 실패: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
