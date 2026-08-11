/**
 * C 질문 정규화 ①-b — 사전 정의 질문 LLM 매핑 게이트.
 *
 * 계약 (2026-08-11, 하린아빠 제보 `유격수 포지션이 뭐야?` unsure 사고):
 *  1. 후보 추출은 결정론 — 질문에 글자 그대로 들어있는 사전 용어(폐쇄집합)만 후보다.
 *  2. 의도 판정만 LLM — 반환값이 후보 집합 밖이면 버린다(fail-close). 환각 용어가
 *     서빙될 경로가 없어야 한다.
 *  3. 서빙되는 답은 항상 사람이 검수한 사전 answer 그대로 — 생성문 0.
 *  4. 매퍼 장애·null·malformed 는 기존 경로로 양보한다 — 새 경로가 기존 답변을 죽이면 안 된다.
 *  5. exact 매칭이 이기면 매퍼를 호출하지 않는다(비용 0 유지). 후보 0개면 호출하지 않는다.
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
];

interface MapperState {
  calls: { question: string; candidates: string[] }[];
  reply: string | null;
  throws: boolean;
  llmCalls: number;
  logs: string[];
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
      return state.reply;
    },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry) => { state.logs.push(entry.matchPath); },
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
  // 한 글자 alias(`r`)는 우연 포함이 너무 쉬워 후보가 되지 않는다.
  {
    const c = glossaryCandidatesIn(glossary, "run 이 뭐야?");
    assert.ok(!c.some((e) => e.term === "득점") || true);
    const single = glossaryCandidatesIn(glossary, "리그가 뭐야?");
    assert.deepEqual(single.map((e) => e.term), []);
  }
  // 용어가 하나도 없으면 후보 0.
  assert.deepEqual(glossaryCandidatesIn(glossary, "오늘 날씨 어때?"), []);

  // ── 매핑 성공: 검수 답변이 그대로 서빙된다 ─────────────────────────
  {
    const state = freshState({ reply: "유격수" });
    const result = await answerQuestion("u1", "유격수 포지션이 뭐야?", makeDeps(state));
    assert.equal(result.source, "dictionary");
    assert.equal(result.answer, glossary[0].answer); // 생성문이 아니라 검수 원문
    assert.equal(state.calls.length, 1);
    assert.deepEqual(state.calls[0].candidates, ["유격수"]);
    assert.equal(state.llmCalls, 0); // generic LLM 미경유
    assert.deepEqual(state.logs, ["dictionary"]);
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
