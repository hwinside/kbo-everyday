/**
 * `stat_clarify` 오발동 회귀 게이트 — 2026-08-22 48h 운영 로그 전수 실측 기반.
 *
 * ── 무엇을 막는가 ────────────────────────────────────────────────────────────
 * 운영 로그 867건 중 `match_path=stat_clarify` 11건을 전수 재현해보니, **11건 전부가
 * 질문에 사람 이름이 아예 없는데 "앞말이 선수 이름인지 확인하지 못했습니다" 를 받았다.**
 * 원인은 두 축이다:
 *
 *   ① `NAMED_STAT_HEAD` 가 지표어 **바로 앞 토큰**을 엔티티 후보로 뽑는다. 그래서
 *      `31호 홈런`·`4점차면 세이브`·`3루카 홈런` 에서 head 가 `31호`·`4점차면`·`3루카`
 *      가 되고, 로스터·사전 어디에도 없어 미결속(`ambiguous`)으로 떨어진다.
 *      → 수정: **숫자로 시작하는 head 는 엔티티가 아니다**(닫힌 집합, 열거 성장 없음).
 *
 *   ② 가드가 소유하면 LLM 은 `RECORD`/`NARRATIVE` 토큰만 낼 수 있었는데, 실 provider 는
 *      룰 질문(`무사 1루 4점차면 세이브 조건인가요?`)에 **정상 룰 답변**을 냈다. 코드는
 *      그 답을 토큰이 아니라는 이유로 버리고 되묻기로 종결했다 — 답을 만들어놓고 버린 것.
 *      → 수정: 토큰에 `RULE_TERM` 추가. 그 토큰은 **가드 소유 부정** 신호이고, 호출측이
 *        일반 프롬프트로 **재질의**해 `validateLlmResponse` 전수 검증을 그대로 통과시킨다.
 *
 * ── 왜 룰이 아니라 이 형태인가 ───────────────────────────────────────────────
 * ①은 닫힌 집합이다(KBO 등록 선수명·구단명·별칭은 숫자로 시작하지 않는다). ②는 열린
 * 자연어(룰 질문인가 기록 요구인가)라 룰로 닫히지 않으므로 판정 주체를 LLM 으로 옮기되
 * **유저 노출 문구는 코드가 정한다**(`open_language_never_closes_with_rules` 계약 유지).
 *
 * ── 검증력 ──────────────────────────────────────────────────────────────────
 * 이 게이트는 `answerQuestion` **종단**을 태운다(라우터 단면이 아니다). 결함주입은
 * `stat-clarify-misfire-mutations.mjs` 가 담당하며, 이 파일 단독 PASS 는 검증력을
 * 증명하지 않는다 — 두 개가 한 묶음이다.
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
  parseStatIntentToken,
  statGuardOwnsQuestion,
  STAT_CLARIFY_ANSWER,
  STAT_NARRATIVE_ANSWER,
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

/**
 * 48h 운영 로그 `match_path=stat_clarify` **전수 11건**(2026-08-22 21:04 KST 기준).
 *
 * ⚠️ 이 목록은 임의 샘플이 아니라 **그 창의 전수**다. 줄이면 분모가 절단된다
 *   (`truncated_denominator` 교훈) — 새 사례를 추가하는 것만 허용한다.
 *
 * `numericHead` : 수정 ①(숫자 head)로 가드 소유가 풀려야 하는 케이스
 * `ruleIntent`  : 수정 ②(RULE_TERM 재질의)로 답이 나가야 하는 룰·용어 질문
 */
const LOG_CASES: Array<{
  question: string;
  numericHead: boolean;
  ruleIntent: boolean;
}> = [
  { question: "오늘 롯데 경기 누가 안타쳐서 7점 득점 낸거야", numericHead: false, ruleIntent: false },
  { question: "아니 KBO 오고 나서 친 모든 홈런의 갯수", numericHead: false, ruleIntent: false },
  { question: "인사이드 더 파크 홈런이 므ㅏ야?", numericHead: false, ruleIntent: true },
  { question: "점수차가 많이 날때 점수 많은 쪽 팀이 도루를 하면 안되는 이유가 뭐야?", numericHead: false, ruleIntent: true },
  { question: "점수 차가 많이 날때 도루를 왜 하면 안되냐고", numericHead: false, ruleIntent: true },
  { question: "그럼 안타를 치고 1루를 밟든 2루를 밟든 3루를 밟든 하나의 도루로 인정되는 거야?", numericHead: false, ruleIntent: true },
  { question: "무사 주자1루 4점차면 세이브 조건인가요?", numericHead: true, ruleIntent: true },
  { question: "몇호 홈런 그런거 뜻이 뭐야", numericHead: false, ruleIntent: true },
  { question: "31호 홈런", numericHead: true, ruleIntent: false },
  { question: "1루타 2루타 3루카 홈런 다치는거 뭐야?", numericHead: true, ruleIntent: true },
  { question: "직관기록", numericHead: false, ruleIntent: false },
];

// ── 결정론 stub deps ────────────────────────────────────────────────────────
interface StubState {
  llmTexts: string[];
  llmCalls: number;
  guardModes: Array<boolean | undefined>;
  logs: MatchPath[];
  cache: Map<string, string>;
}
function freshState(...llmTexts: string[]): StubState {
  return { llmTexts, llmCalls: 0, guardModes: [], logs: [], cache: new Map() };
}
function makeDeps(state: StubState): QaDeps {
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => players,
    getCache: async (key) => state.cache.get(key) ?? null,
    setCache: async (key, value) => { state.cache.set(key, value); },
    callLlm: async (_q, _ctx, _roster, statIntentMode): Promise<LlmResult> => {
      state.guardModes.push(statIntentMode);
      const text = state.llmTexts[state.llmCalls] ?? state.llmTexts[state.llmTexts.length - 1] ?? "";
      state.llmCalls += 1;
      return { text, inputTokens: 250, outputTokens: 100 };
    },
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async (entry) => { state.logs.push(entry.matchPath); },
  };
}

const INTENT = (token: string) => JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: token });
const RULE_ANSWER = "세이브는 리드를 지킨 마지막 투수에게 주는 기록입니다. 3점 차 이내에서 등판하면 요건이 성립합니다.";
const NORMAL_ANSWER = JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: RULE_ANSWER });

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✅ ${name}`); })
    .catch((e: unknown) => {
      failures += 1;
      // ⚠️ 실패 줄에만 나타나는 안정 ID — 통과 출력(✅)과 겹치지 않게 한다.
      console.log(`  ❌ [SCM-FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
    });
}

async function main() {
  console.log("── A. 프롬프트 계약: RULE_TERM 토큰이 실제 프롬프트에 있다 ──");
  await check("A1 STAT_INTENT_PROMPT 가 세 토큰을 각각 **정의**한다", () => {
    // ⚠️ `RULE_TERM` 문자열 포함만 보면 안 된다 — 예시 줄·출력형식 줄에도 그 단어가 있어서
    //   **정의 줄을 통째로 지워도 GREEN** 이 된다(2026-08-22 M7 실측 false-GREEN).
    //   그래서 `<TOKEN> — <설명>` 정의 형태를 토큰별로 각각 고정한다.
    for (const token of ["RECORD", "NARRATIVE", "RULE_TERM"]) {
      assert.match(
        STAT_INTENT_PROMPT,
        new RegExp(`(?:^|\\n)${token}\\s*—\\s*\\S`),
        `프롬프트에 ${token} 정의 줄이 없음`,
      );
    }
    assert.match(STAT_INTENT_PROMPT, /세 토큰/, "토큰 개수 문구가 갱신되지 않음");
    // 코드의 폐쇄집합과 프롬프트가 갈라지면 LLM 은 코드가 안 받는 토큰을 낸다.
    assert.match(STAT_INTENT_PROMPT, /RECORD 또는 NARRATIVE 또는 RULE_TERM/, "출력 형식 문구 미갱신");
  });
  await check("A2 parseStatIntentToken 폐쇄집합 3+거절", () => {
    assert.equal(parseStatIntentToken(INTENT("RECORD")), "record");
    assert.equal(parseStatIntentToken(INTENT("NARRATIVE")), "narrative");
    assert.equal(parseStatIntentToken(INTENT("RULE_TERM")), "rule_term");
    // 폐쇄집합 밖·자유문장·status 불일치는 전부 null (fail-close 불변)
    assert.equal(parseStatIntentToken(INTENT("RULE")), null);
    assert.equal(parseStatIntentToken(NORMAL_ANSWER), null, "자유문장이 토큰으로 인정되면 안 됨");
    assert.equal(parseStatIntentToken('{"status":"ANSWER","answer":"RULE_TERM"}'), null);
    assert.equal(parseStatIntentToken("not json"), null);
  });

  console.log("── B. 숫자 head 는 엔티티가 아니다 (수정 ①, 닫힌 집합) ──");
  for (const c of LOG_CASES.filter((x) => x.numericHead)) {
    await check(`B ${c.question}`, () => {
      assert.equal(
        statGuardOwnsQuestion(c.question, glossary, players),
        false,
        "숫자 head 인데 가드가 여전히 소유한다",
      );
    });
  }
  await check("B-neg 숫자 시작이 아닌 미결속은 그대로 가드 소유(과잉 완화 방지)", () => {
    assert.equal(statGuardOwnsQuestion("이대호 홈런 몇개", glossary, players), true);
  });
  await check("B-neg2 결속 선수는 가드 밖(기존 계약 무회귀)", () => {
    const bound = players[0].name;
    assert.equal(
      classifyNamedStatMatches(`${bound} 홈런`.normalize("NFKC").toLowerCase(), glossary, players)
        .includes("entity_stat"),
      true,
      `${bound} 결속 실패`,
    );
  });

  console.log("── C. 혼합형 앞단 fail-close 무회귀 ──");
  await check("C1 결속+미결속 혼합은 여전히 앞단 되묻기", () => {
    const q = `${players[0].name} 홈런과 이대호 홈런 몇개`;
    const kinds = classifyNamedStatMatches(q.normalize("NFKC").toLowerCase(), glossary, players);
    assert.ok(kinds.includes("ambiguous"), "미결속 절이 사라짐");
    assert.ok(kinds.includes("entity_stat") || mentionsTeamForGate(q), "결속 절이 사라짐");
  });

  console.log("── D. 종단(answerQuestion): RULE_TERM 재질의로 답이 나간다 (수정 ②) ──");
  await check("D1 RULE_TERM → 일반 경로 재질의 → 정상 답변 서빙", async () => {
    // 1차(가드 모드) RULE_TERM → 2차(일반 모드) 정상 답변
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    const r = await answerQuestion("u-ruleterm", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(r.source, "llm", `기대 llm, 실제 ${r.source}`);
    assert.equal(r.answer, RULE_ANSWER, "재질의 답변이 서빙되지 않음");
    assert.equal(state.llmCalls, 2, `재질의 1회 추가여야 함 (실제 ${state.llmCalls})`);
    assert.deepEqual(state.guardModes, [true, false], "재질의가 일반 프롬프트로 가지 않음");
    assert.deepEqual(state.logs, ["llm"], `로그 경로 불일치: ${state.logs.join(",")}`);
  });
  await check("D2 RECORD → 되묻기 (기존 계약 무회귀)", async () => {
    const state = freshState(INTENT("RECORD"));
    const r = await answerQuestion("u-record", "이대호 홈런 몇개", makeDeps(state));
    assert.equal(r.source, "stat_clarify");
    assert.equal(r.answer, STAT_CLARIFY_ANSWER);
    assert.equal(state.llmCalls, 1, "RECORD 는 재질의하지 않는다");
  });
  await check("D3 NARRATIVE → 고정 응대 (기존 계약 무회귀)", async () => {
    const state = freshState(INTENT("NARRATIVE"));
    const r = await answerQuestion("u-narr", "친구가 이대호 홈런 영상을 보내줬어", makeDeps(state));
    assert.equal(r.answer, STAT_NARRATIVE_ANSWER);
    assert.equal(state.llmCalls, 1, "NARRATIVE 는 재질의하지 않는다");
  });
  await check("D4 토큰 밖 자유문장 → 되묻기 fail-close (자유문장 서빙 0 불변)", async () => {
    const state = freshState(NORMAL_ANSWER);
    const r = await answerQuestion("u-free", "이대호 홈런 몇개", makeDeps(state));
    assert.equal(r.source, "stat_clarify", "가드 소유 경로가 자유문장을 서빙했다");
    assert.equal(state.llmCalls, 1);
  });
  await check("D5 RULE_TERM 인데 재질의 답이 검증 실패 → 되묻기 fail-close", async () => {
    const state = freshState(INTENT("RULE_TERM"), '{"status":"UNSURE"}');
    const r = await answerQuestion("u-refail", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(r.source, "stat_clarify", "재질의 실패가 되묻기로 닫히지 않음");
    assert.equal(state.llmCalls, 2);
  });
  await check("D6 RULE_TERM 재질의 답은 캐시에 쓰지 않는다", async () => {
    const state = freshState(INTENT("RULE_TERM"), NORMAL_ANSWER);
    await answerQuestion("u-nocache", "이대호 홈런 어떻게 기록되는거야", makeDeps(state));
    assert.equal(state.cache.size, 0, `가드 소유 답이 캐시됨 (${state.cache.size})`);
  });

  console.log("── E. 종단: 숫자 head 케이스가 되묻기로 끝나지 않는다 ──");
  for (const c of LOG_CASES.filter((x) => x.numericHead)) {
    await check(`E ${c.question}`, async () => {
      const state = freshState(NORMAL_ANSWER);
      const r = await answerQuestion("u-num", c.question, makeDeps(state));
      assert.notEqual(r.answer, STAT_CLARIFY_ANSWER, "여전히 '앞말이 선수 이름인지' 되묻기");
      assert.notEqual(r.source, "stat_clarify");
    });
  }

  // ── selftest: 임계 반전이 아니라 **판정 함수 자체**를 반전시켜 RED 를 확인한다 ──
  if (SELFTEST) {
    console.log("── SELFTEST: 계약 반전 시 RED 인지 ──");
    const before = failures;
    await check("S1 (의도적 RED) 숫자 head 가 가드 소유면 잡힌다", () => {
      assert.equal(statGuardOwnsQuestion("31호 홈런", glossary, players), true, "S1 기대 RED");
    });
    if (failures !== before + 1) {
      console.log("  ❌ [SCM-FAIL] selftest 가 RED 를 만들지 못했다 — 검증력 없음");
      process.exit(1);
    }
    failures = before;
    console.log("  ✅ selftest RED 확인");
  }

  const total = LOG_CASES.filter((c) => c.numericHead).length * 2 + 12;
  console.log(`\n총 ${total}축 검사 · 실패 ${failures}`);
  if (failures > 0) process.exit(1);
  console.log("✅ stat-clarify 오발동 게이트 PASS");
}

main().catch((e) => {
  console.error(`[SCM-FAIL] 게이트 실행 실패: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
