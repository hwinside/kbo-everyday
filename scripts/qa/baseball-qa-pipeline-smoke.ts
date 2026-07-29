// 야구 용어/룰 질문 파이프라인 스모크 (spec: specs/baseball-qa-mvp.md §10)
// DB/LLM 없이 mock deps로 검증: 정규화·사전/별칭 매칭·캐시 적중·LLM 폴백·
// NOT_BASEBALL 차단·UNSURE 보류·일일 한도. 시드 SQL도 파싱해 무결성 확인.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeQuestion, normalizeKey } from "../../src/lib/baseball-qa/normalize";
import {
  answerQuestion,
  matchGlossary,
  DAILY_LIMIT,
  BLOCKED_ANSWER,
  UNSURE_ANSWER,
  type GlossaryEntry,
  type QaDeps,
  type MatchPath,
} from "../../src/lib/baseball-qa/pipeline";

// ---------- 시드 SQL 파싱 (무결성 + 실데이터 매칭 검증) ----------
const seedSql = readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260730_baseball_qa_seed.sql"),
  "utf8",
);
const seedEntries: GlossaryEntry[] = [...seedSql.matchAll(/\('([^']+)',\s*ARRAY\[([^\]]*)\],\s*'([^']+)'/gs)].map((m) => ({
  term: m[1],
  aliases: [...m[2].matchAll(/'([^']*)'/g)].map((a) => a[1]),
  answer: m[3],
}));

assert.ok(seedEntries.length >= 100, `시드 용어 100개 이상이어야 함 (현재 ${seedEntries.length})`);

// 정규화 키 충돌: 서로 다른 term이 같은 키로 매칭되면 오답 위험
const keyOwner = new Map<string, string>();
for (const entry of seedEntries) {
  for (const name of [entry.term, ...entry.aliases]) {
    for (const key of [normalizeKey(name), normalizeQuestion(name)]) {
      const owner = keyOwner.get(key);
      assert.ok(!owner || owner === entry.term, `정규화 키 충돌: "${key}" → ${owner} vs ${entry.term}`);
      keyOwner.set(key, entry.term);
    }
  }
}

// 답변은 3줄 이하
for (const entry of seedEntries) {
  assert.ok(entry.answer.split("\n").length <= 3, `${entry.term} 답변이 3줄 초과`);
}

// ---------- 정규화 ----------
assert.equal(normalizeQuestion("ABS가 뭐예요?"), "abs");
assert.equal(normalizeQuestion("보크란 무엇인가요"), "보크");
// 후행 조사 제거로 끝 "이"가 줄어들 수 있지만, term 쪽도 같은 정규화로 인덱싱되어 매칭된다
assert.equal(normalizeQuestion("인필드 플라이가 뭐야?"), normalizeQuestion("인필드플라이"));
assert.equal(normalizeQuestion("희생플라이 뭔가요"), normalizeQuestion("희생플라이"));
assert.equal(normalizeQuestion("  퀄리티스타트  "), "퀄리티스타트");

// ---------- 사전/별칭 매칭 (실시드 데이터) ----------
assert.equal(matchGlossary(seedEntries, "보크가 뭐야?")?.term, "보크");
assert.equal(matchGlossary(seedEntries, "에이비에스가 뭐예요?")?.term, "ABS"); // 별칭
assert.equal(matchGlossary(seedEntries, "자동볼판정이 뭐야")?.term, "ABS"); // 별칭
assert.equal(matchGlossary(seedEntries, "폭투란?")?.term, "와일드피치"); // 별칭
assert.equal(matchGlossary(seedEntries, "QS가 뭐야")?.term, "퀄리티스타트");
assert.equal(matchGlossary(seedEntries, "오늘 저녁 뭐 먹지"), null); // 미매칭

// ---------- 파이프라인 (mock deps) ----------
interface MockState {
  cache: Map<string, string>;
  logs: MatchPath[];
  used: number;
  llmText: string;
  llmCalls: number;
  llmThrows: boolean;
}

function makeDeps(state: MockState): QaDeps {
  return {
    loadGlossary: async () => seedEntries,
    getCache: async (k) => state.cache.get(k) ?? null,
    setCache: async (k, v) => { state.cache.set(k, v); },
    callLlm: async () => {
      state.llmCalls++;
      if (state.llmThrows) throw new Error("llm down");
      return { text: state.llmText, inputTokens: 250, outputTokens: 100 };
    },
    countToday: async () => state.used,
    log: async (e) => { state.logs.push(e.matchPath); },
  };
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return { cache: new Map(), logs: [], used: 0, llmText: "답변", llmCalls: 0, llmThrows: false, ...overrides };
}

async function main() {
  // 1) 사전 매칭 → LLM 미호출, 토큰 0
  {
    const state = freshState();
    const r = await answerQuestion("u1", "보크가 뭐야?", makeDeps(state));
    assert.equal(r.status, 200);
    assert.equal(r.source, "dictionary");
    assert.equal(r.term, "보크");
    assert.equal(state.llmCalls, 0);
    assert.deepEqual(state.logs, ["dictionary"]);
  }

  // 2) 캐시 적중 → LLM 미호출
  {
    const state = freshState();
    state.cache.set(normalizeQuestion("체크스윙 판정 기준이 뭐야?"), "캐시된 답변");
    const r = await answerQuestion("u1", "체크스윙 판정 기준이 뭐야?", makeDeps(state));
    assert.equal(r.source, "cache");
    assert.equal(r.answer, "캐시된 답변");
    assert.equal(state.llmCalls, 0);
  }

  // 3) 미매칭 → LLM 폴백 + 캐시 저장 → 같은 질문 재호출 없음
  {
    const state = freshState({ llmText: "야구에서 그런 경우는 이렇게 처리돼요." });
    const q = "9회말 투아웃에 우천 중단되면 어떻게 돼?";
    const r1 = await answerQuestion("u1", q, makeDeps(state));
    assert.equal(r1.source, "llm");
    assert.equal(state.llmCalls, 1);
    const r2 = await answerQuestion("u1", q, makeDeps(state));
    assert.equal(r2.source, "cache");
    assert.equal(state.llmCalls, 1); // 재호출 없음
  }

  // 4) 야구 외 질문 → NOT_BASEBALL 차단 (LLM 원문 미노출, 캐시 미저장)
  {
    const state = freshState({ llmText: "NOT_BASEBALL" });
    const r = await answerQuestion("u1", "비트코인 지금 사도 돼?", makeDeps(state));
    assert.equal(r.source, "blocked");
    assert.equal(r.answer, BLOCKED_ANSWER);
    assert.equal(state.cache.size, 0);
  }

  // 5) 불확실 → UNSURE 보류 (추측 금지, 캐시 미저장)
  {
    const state = freshState({ llmText: "UNSURE" });
    const r = await answerQuestion("u1", "1982년 개막전 심판 이름이 뭐야?", makeDeps(state));
    assert.equal(r.source, "unsure");
    assert.equal(r.answer, UNSURE_ANSWER);
    assert.equal(state.cache.size, 0);
  }

  // 6) 일일 한도 → 429, LLM/사전 진입 전 차단
  {
    const state = freshState({ used: DAILY_LIMIT });
    const r = await answerQuestion("u1", "보크가 뭐야?", makeDeps(state));
    assert.equal(r.status, 429);
    assert.equal(r.source, "limited");
    assert.equal(r.remaining, 0);
    assert.equal(state.llmCalls, 0);
    assert.deepEqual(state.logs, ["limited"]);
  }

  // 7) LLM 장애 → 503, 사전/캐시 경로는 영향 없음
  {
    const state = freshState({ llmThrows: true });
    const r = await answerQuestion("u1", "잘 모르는 질문이야 이건", makeDeps(state));
    assert.equal(r.status, 503);
    assert.equal(r.source, "error");
    const r2 = await answerQuestion("u1", "보크가 뭐야?", makeDeps(state));
    assert.equal(r2.source, "dictionary"); // 사전은 정상
  }

  console.log(`✅ baseball-qa pipeline smoke PASS (시드 ${seedEntries.length}개 용어, 7개 시나리오)`);
}

main().catch((e) => {
  console.error("❌ baseball-qa smoke FAIL:", e.message);
  process.exit(1);
});
