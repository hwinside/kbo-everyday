/**
 * C 질문 정규화 ①-b — 사전 정의 질문 LLM 매핑 게이트.
 *
 * 계약 (2026-08-11, 하린아빠 제보 `유격수 포지션이 뭐야?` unsure 사고):
 *  1. 후보 추출은 결정론 — 질문에 글자 그대로 들어있는 사전 용어(폐쇄집합)만 후보다.
 *  2. 의도 판정만 LLM — 반환값이 후보 집합 밖이면 버린다(fail-close). 환각 용어가
 *     서빙될 경로가 없어야 한다.
 *  3. 서빙되는 답은 항상 사람이 검수한 사전 answer 그대로 — 생성문 0.
 *  4. 매퍼 장애·null·malformed 는 기존 경로로 양보한다 — 새 경로가 기존 답변을 죽이면 안 된다.
 *  5. exact 매칭이 이기면 매퍼를 호출하지 않는다(비용 0 유지). 후보 0개·5개 초과면 호출하지 않는다.
 *  6. 선수 결속 질문(enabledPlayerCandidate)은 매퍼를 태우지 않는다 — 선수 경로가 근거 0으로
 *     양보해도 용어 정의로 오답하지 않는다 (삼순 2026-08-11 선점 반례 축).
 *  7. 매퍼 토큰은 로그에 기록된다 — 성공 시 그 행, 실패 시 후속 경로 행에 합산 (관측 계약).
 *
 * 실-provider 반복 양성·반대경로는 genius-glossary-map-live-smoke.ts (별도, 실 Gemini).
 *
 * 실행: npm run qa:genius-glossary-map
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  glossaryCandidatesIn,
  matchGlossary,
  type GlossaryEntry,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { UNSUPPORTED_SEASON_ANSWER } from "../../src/lib/baseball-qa/stats/season-record";

const glossary: GlossaryEntry[] = [
  { term: "유격수", aliases: ["ss", "숏스탑", "shortstop"], answer: "2루와 3루 사이를 지키는 내야 수비의 핵심이에요." },
  { term: "도루", aliases: ["stolen base", "sb"], answer: "주자가 투구 사이에 다음 베이스를 훔치는 플레이예요." },
  { term: "40-40 클럽", aliases: ["40-40", "40-40클럽", "포티포티클럽"], answer: "한 시즌에 홈런 40개와 도루 40개를 동시에 달성하는 기록이에요." },
  { term: "타율", aliases: ["batting average", "avg"], answer: "안타 ÷ 타수로 계산하는 타자의 기본 지표예요." },
  { term: "득점", aliases: ["run", "r"], answer: "주자가 홈을 밟아 팀 점수가 1점 올라가는 거예요." },
  { term: "20-20 클럽", aliases: ["20-20", "20-20클럽"], answer: "한 시즌에 홈런 20개와 도루 20개를 동시에 달성하는 기록이에요." },
];

interface MapperState {
  calls: { question: string; candidates: string[] }[];
  reply: string | null;
  throws: boolean;
  llmCalls: number;
  logs: { matchPath: string; inputTokens: number | null; outputTokens: number | null }[];
}

function freshState(overrides: Partial<MapperState> = {}): MapperState {
  return { calls: [], reply: null, throws: false, llmCalls: 0, logs: [], ...overrides };
}

function makeDeps(state: MapperState): QaDeps {
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => {
      state.llmCalls++;
      return { text: '{"status":"UNSURE","answer":""}', inputTokens: 1, outputTokens: 1 };
    },
    mapGlossaryDefinition: async (question, candidates) => {
      state.calls.push({ question, candidates });
      if (state.throws) throw new Error("mapper down");
      return { term: state.reply, inputTokens: 37, outputTokens: 5 };
    },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry) => {
      state.logs.push({
        matchPath: entry.matchPath,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      });
    },
  };
}

async function main() {
  // ── 결정론 후보 추출 ───────────────────────────────────────────────
  // 질문에 실제로 들어있는 용어만 후보다.
  {
    const c = glossaryCandidatesIn(glossary, "유격수 포지션이 뭐야?");
    assert.deepEqual(c.map((e) => e.term), ["유격수"]);
  }
  // alias 로도 잡되 정본 term 으로 수렴한다. 긴 매칭이 앞이다.
  {
    const c = glossaryCandidatesIn(glossary, "40-40 클럽이 뭐야?");
    assert.equal(c[0]?.term, "40-40 클럽");
  }
  // 한 글자 alias(`r`)는 우연 포함이 너무 쉬워 후보가 되지 않는다 (삼순: tautology 제거 — 직접 단정).
  {
    const c = glossaryCandidatesIn(glossary, "r 이 뭐야?");
    assert.ok(!c.some((e) => e.term === "득점"), "한 글자 alias가 후보로 잡혔다");
    const single = glossaryCandidatesIn(glossary, "리그가 뭐야?");
    assert.deepEqual(single.map((e) => e.term), []);
  }
  // 용어가 하나도 없으면 후보 0.
  assert.deepEqual(glossaryCandidatesIn(glossary, "오늘 날씨 어때?"), []);
  // 후보 5개 초과 = 단일 정의 질문 아님 → 빈 배열(매퍼 미호출). slice 위장 금지 (삼순 ③축).
  {
    const six = glossaryCandidatesIn(
      glossary,
      "유격수 도루 타율 득점 40-40 클럽 20-20 클럽 전부 설명해줘",
    );
    assert.deepEqual(six, [], "후보 초과 질문이 빈 배열이 아니다");
  }

  // ── 매핑 성공: 검수 답변이 그대로 서빙된다 ─────────────────────────
  {
    const state = freshState({ reply: "유격수" });
    const result = await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.equal(result.source, "dictionary");
    assert.equal(result.answer, glossary[0].answer); // 생성문이 아니라 검수 원문
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.calls[0].candidates, ["유격수"]);
    assert.equal(state.llmCalls, 0); // generic LLM 미경유
    // 관측 계약 (삼순 ④축): 매퍼 토큰이 dictionary 로그 행에 기록된다.
    assert.deepEqual(state.logs, [{ matchPath: "dictionary", inputTokens: 37, outputTokens: 5 }]);
  }

  // ── 관측 계약: 매핑 실패(null) 후 generic 까지 2콜이면 토큰이 합산되어 기록된다 ──
  {
    const state = freshState({ reply: null });
    await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.equal(state.calls.length, 1);
    const last = state.logs[state.logs.length - 1];
    // 매퍼 37/5 + generic LLM 1/1 = 38/6 — 비용 비가시 금지.
    assert.equal(last.inputTokens, 38, `매퍼 토큰 미합산: ${JSON.stringify(state.logs)}`);
    assert.equal(last.outputTokens, 6);
  }

  // ── 선수 결속 질문은 매퍼를 태우지 않는다 (삼순 선점 반례 축) ───────────────
  // `김도영 도루 몇 개야?` — 질문에 사전 용어(도루)가 있어도 선수가 결속되면
  // 선수 경로 소유다. 선수 경로가 근거 0으로 양보해도 용어 정의 오답이 나가면 안 된다.
  // ⚠️ 구성이 계약이다: 선수 경로가 **근거 0으로 양보(fall-through)** 하는 구성이어야 매퍼
  // 지점까지 실제로 내려온다. 선수 경로가 unsure 로 조기 return 하는 구성으로 만들면
  // 가드를 지워도 GREEN 이 된다 — 결함주입(M5)으로 검출력을 재확인했다.
  {
    const state = freshState({ reply: "도루" });
    const deps = makeDeps(state);
    deps.loadPlayers = async () => [
      { name: "김도영", kboId: "50558", team: "KIA", position: "내야수", backNo: "5" },
    ];
    deps.enablePlayerRag = true;
    deps.searchRag = async () => []; // 근거 0 → 선수 서술 경로가 양보하고 아래로 내려온다
    deps.callRagLlm = async () => ({ text: '{"status":"UNSURE","answer":""}', inputTokens: 1, outputTokens: 1 });
    // 질문은 **비수치 서술형**이어야 한다 — `도루 몇 개` 류는 선수 기록 경로가 hold 로
    // 조기 종결해 매퍼 지점에 도달하지 않는다(결함주입 M5 검출력 확보 과정에서 실측).
    state.reply = "유격수";
    const result = await answerQuestion("u1", "김도영 유격수 수비 장면 이야기해줘", deps);
    assert.notEqual(result.source, "dictionary", "선수 결속 질문이 사전 정의로 오답됐다");
    assert.equal(state.calls.length, 0, "선수 결속 질문에 매퍼가 호출됐다");
  }

  // ── fail-close: 후보 밖 반환(환각)은 버린다 ────────────────────────
  {
    const state = freshState({ reply: "삼진" }); // 후보에 없는 용어
    const result = await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.notEqual(result.source, "dictionary");
    assert.equal(state.calls.length, 1);
  }

  // ── 양보: null·장애는 기존 경로로 내려간다 (새 경로가 기존 답을 죽이지 않는다) ──
  {
    const state = freshState({ reply: null });
    const result = await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.notEqual(result.source, "dictionary");
  }
  {
    const state = freshState({ throws: true });
    const result = await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.notEqual(result.source, "dictionary"); // throw 가 500 으로 새지 않는다
    assert.equal(result.status, 200);
  }

  // ── 비용 0 계약: exact 매칭 승리 시·후보 0개 시 매퍼 미호출 ─────────
  {
    const state = freshState({ reply: "유격수" });
    const exact = await answerQuestion("u1", "유격수가 뭐야?", makeDeps(state));
    assert.equal(exact.source, "dictionary");
    assert.equal(state.calls.length, 0); // exact 가 이기면 매퍼는 안 탄다
    assert.ok(matchGlossary(glossary, "유격수가 뭐야?"));
  }
  {
    const state = freshState({ reply: "유격수" });
    await answerQuestion("u1", "9회말 승부치기 규칙 알려줘", makeDeps(state));
    assert.equal(state.calls.length, 0); // 후보 0 → 호출 0
  }

  // ── P1 거절 문구 갱신 계약 (#1143 지원 반영) ────────────────────────
  assert.ok(!UNSUPPORTED_SEASON_ANSWER.includes("아직 준비 중"), "낡은 미지원 안내가 남아있다");
  assert.ok(UNSUPPORTED_SEASON_ANSWER.includes("통산"), "통산 지원 안내 누락");
  assert.ok(UNSUPPORTED_SEASON_ANSWER.includes("연도별"), "연도별 지원 안내 누락");

  console.log("genius-glossary-map-smoke: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
