/**
 * 질문 1차 LLM 정규화 게이트 (2026-08-11 하린아빠 착수 지시).
 *
 * 계약:
 *  1. 발동은 residual(`llm_scope_gate`)뿐 — 전용 라우트(ack·사전·기록·차단…)가 확정한 질문은
 *     정규화가 아예 안 탄다(비용 0·회귀 0).
 *  2. `blocked` 는 발동 대상이 아니다 — 차단은 보안 fail-close 라 LLM 출력으로 열지 않는다.
 *  3. 수용은 폐쇄 가드 전부 통과할 때만: 비어있지 않음 · 길이 상한 · 숫자 시퀀스 보존 ·
 *     normalizeKey 기준 실변경 · 재라우팅 non-blocked.
 *  4. 장애·null·malformed·가드 탈락은 전부 원문 진행(fail-open) — 새 경로가 기존 답변을 죽이면 안 된다.
 *  5. 수용 시 로그의 question 은 **원문** 고정 + questionNormalized 에 교정문 — 오교정 감사 분모.
 *  6. 정규화 토큰은 수용 여부와 무관하게 최종 로그 행에 합산된다(관측 계약).
 *
 * 실-provider 교정 품질은 genius-question-normalize-live-smoke.ts (별도, 실 Gemini).
 *
 * 실행: npm run qa:genius-question-normalize
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  digitSequencesMatch,
  routeQuestion,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";

const glossary: GlossaryEntry[] = [
  { term: "보크", aliases: ["balk"], answer: "투수의 반칙 동작이에요." },
  { term: "도루", aliases: ["sb"], answer: "베이스를 훔치는 플레이예요." },
];
const players = [
  { kboId: "50001", name: "김도영", team: "KIA 타이거즈" },
] as unknown as PlayerRef[];

interface State {
  normCalls: string[];
  normReply: string | null;
  normThrows: boolean;
  llmCalls: number;
  logs: {
    question: string;
    questionNormalized: string | null | undefined;
    matchPath: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }[];
}

function freshState(overrides: Partial<State> = {}): State {
  return { normCalls: [], normReply: null, normThrows: false, llmCalls: 0, logs: [], ...overrides };
}

function makeDeps(state: State, withNormalizer = true): QaDeps {
  const deps: QaDeps = {
    loadGlossary: async () => glossary,
    loadPlayers: async () => players,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => {
      state.llmCalls++;
      return { text: '{"status":"UNSURE","answer":""}', inputTokens: 11, outputTokens: 3 };
    },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry) => {
      state.logs.push({
        question: entry.question,
        questionNormalized: entry.questionNormalized,
        matchPath: entry.matchPath,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      });
    },
  };
  if (withNormalizer) {
    deps.normalizeQuestionLlm = async (question) => {
      state.normCalls.push(question);
      if (state.normThrows) throw new Error("normalizer down");
      return { text: state.normReply, inputTokens: 23, outputTokens: 7 };
    };
  }
  return deps;
}

async function main() {
  // ── 픽스처 라우팅 전제(precondition) — 픽스처 drift 를 여기서 먼저 잡는다 ──
  assert.equal(routeQuestion("김도영홈런몇개", glossary, players, false), "llm_scope_gate");
  assert.equal(routeQuestion("보끄가모야", glossary, players, false), "llm_scope_gate");
  assert.equal(routeQuestion("수비시프트제한이언제부터였지", glossary, players, false), "llm_scope_gate");
  assert.equal(routeQuestion("보크가 뭐야?", glossary, players, false), "baseball_rule_term");
  assert.equal(routeQuestion("김도영 홈런 몇 개야?", glossary, players, false), "history_hold");
  assert.equal(routeQuestion("고마워", glossary, players, false), "ack");
  assert.equal(routeQuestion("오늘 날씨 알려줘", glossary, players, false), "blocked");

  // ── 1. 수용: 오탈자+붙여쓰기 → 사전 exact 로 도달 ─────────────────────────
  {
    const s = freshState({ normReply: "보크가 뭐야?" });
    const r = await answerQuestion("u1", "보끄가모야", makeDeps(s));
    assert.deepEqual(s.normCalls, ["보끄가모야"]);
    assert.equal(r.source, "dictionary");
    assert.equal(r.answer, "투수의 반칙 동작이에요.");
    assert.equal(s.llmCalls, 0); // 정규화 후 결정론 경로 — generic LLM 미호출
    const log = s.logs.at(-1)!;
    assert.equal(log.question, "보끄가모야"); // 원문 고정
    assert.equal(log.questionNormalized, "보크가 뭐야?");
    assert.equal(log.inputTokens, 23); // 사전 경로 토큰 null → 정규화 토큰만
    assert.equal(log.outputTokens, 7);
  }

  // ── 2. 수용: 붙여쓰기 → 기록계 전용 라우트(history_hold) 도달 ─────────────
  {
    const s = freshState({ normReply: "김도영 홈런 몇 개야?" });
    const r = await answerQuestion("u1", "김도영홈런몇개", makeDeps(s));
    assert.equal(s.normCalls.length, 1);
    assert.equal(r.source, "history_hold");
    const log = s.logs.at(-1)!;
    assert.equal(log.question, "김도영홈런몇개");
    assert.equal(log.questionNormalized, "김도영 홈런 몇 개야?");
  }

  // ── 3. 미발동: 전용 라우트 질문은 정규화가 아예 안 탄다 ──────────────────
  {
    for (const q of ["고마워", "오늘 날씨 알려줘", "보크가 뭐야?", "김도영 홈런 몇 개야?"]) {
      const s = freshState({ normReply: "무엇이든" });
      await answerQuestion("u1", q, makeDeps(s));
      assert.equal(s.normCalls.length, 0, `정규화가 전용 라우트 질문에 발동: ${q}`);
    }
  }

  // ── 4. 가드 탈락 → 원문 진행 + questionNormalized null + 토큰은 합산 ──────
  const rejectionCases: { name: string; question: string; reply: string }[] = [
    { name: "숫자 시퀀스 변경", question: "수비시프트제한이언제부터였지", reply: "2023년부터 수비 시프트 제한이 언제부터였지?" },
    { name: "길이 상한 초과", question: "보끄가모야", reply: "보크가 무엇인지 아주 자세하게 설명해 주실 수 있나요? 규칙과 사례를 포함해서 부탁드립니다." },
    { name: "재라우팅 blocked", question: "보끄가모야", reply: "오늘 날씨 알려줘" },
    { name: "동일 출력(무변경)", question: "보끄가모야", reply: "보끄가모야" },
  ];
  for (const c of rejectionCases) {
    const s = freshState({ normReply: c.reply });
    await answerQuestion("u1", c.question, makeDeps(s));
    assert.equal(s.normCalls.length, 1, c.name);
    assert.ok(s.llmCalls >= 1, `${c.name}: 원문 residual 경로 진행`);
    const log = s.logs.at(-1)!;
    assert.equal(log.question, c.question, c.name);
    assert.equal(log.questionNormalized ?? null, null, c.name);
    assert.equal(log.inputTokens, 11 + 23, `${c.name}: 토큰 합산`);
    assert.equal(log.outputTokens, 3 + 7, `${c.name}: 토큰 합산`);
  }

  // ── 5. null(교정 없음) → 원문 진행 + 토큰 합산 ────────────────────────────
  {
    const s = freshState({ normReply: null });
    await answerQuestion("u1", "보끄가모야", makeDeps(s));
    assert.equal(s.normCalls.length, 1);
    assert.ok(s.llmCalls >= 1);
    const log = s.logs.at(-1)!;
    assert.equal(log.questionNormalized ?? null, null);
    assert.equal(log.inputTokens, 11 + 23);
  }

  // ── 6. 정규화 장애 → fail-open 원문 진행 (토큰 없음 → 합산 래퍼 미적용) ──
  {
    const s = freshState({ normThrows: true });
    const r = await answerQuestion("u1", "보끄가모야", makeDeps(s));
    assert.equal(s.normCalls.length, 1);
    assert.ok(s.llmCalls >= 1);
    assert.ok(r.answer.length > 0);
    const log = s.logs.at(-1)!;
    assert.equal(log.inputTokens, 11); // 장애 시 정규화 토큰 없음 — generic 경로 토큰 그대로
  }

  // ── 7. 미주입이면 이 단계 자체가 비활성 (기존 동작) ───────────────────────
  {
    const s = freshState();
    const r = await answerQuestion("u1", "보끄가모야", makeDeps(s, false));
    assert.equal(s.normCalls.length, 0);
    assert.ok(r.answer.length > 0);
  }

  // ── 7-b. 띄어쓰기만 고친 교정도 수용된다 (실 provider 게이트가 잡은 결함의 회귀 방어) ──
  // normalizeKey 비교였다면 이 교정은 "무변경"으로 죽는다 — 라우팅은 공백에 민감하므로
  // 공백 교정이 이 기능의 주 사용사례다.
  {
    const s = freshState({ normReply: "김도영 홈런 몇 개" });
    const r = await answerQuestion("u1", "김도영홈런몇개", makeDeps(s));
    assert.equal(s.normCalls.length, 1);
    assert.equal(r.source, "history_hold"); // 공백 교정만으로 기록계 전용 라우트 도달
    const log = s.logs.at(-1)!;
    assert.equal(log.question, "김도영홈런몇개");
    assert.equal(log.questionNormalized, "김도영 홈런 몇 개");
  }

  // ── 8. digitSequencesMatch 단위 계약 ──────────────────────────────────────
  assert.ok(digitSequencesMatch("30-30 클럽이 뭐야", "30-30 클럽이 뭐야?"));
  assert.ok(digitSequencesMatch("숫자 없음", "숫자 없음!"));
  assert.ok(!digitSequencesMatch("30-30 클럽", "40-40 클럽"));
  assert.ok(!digitSequencesMatch("2011년 입단", "입단")); // 숫자 소실도 불일치다
  assert.ok(!digitSequencesMatch("3할", "3할 3푼")); // 숫자 추가도 불일치다

  console.log("genius-question-normalize-smoke: ALL PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
