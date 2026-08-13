import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import snapshot from "../../data/baseball-qa/kbo-event-records-2026.json";
import {
  composeEventRecordAnswer,
  createEventRecordFetcher,
  resolveEventRecord,
  resolveEventRecordQuery,
} from "../../src/lib/baseball-qa/stats/event-records";
import { answerQuestion, routeQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name} :: ${(error as Error).message}`); }
}
const asyncChecks: Array<[string, () => Promise<void>]> = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push([name, fn]); }

const fetcher = createEventRecordFetcher(() => snapshot);
const PLAYER_NAMES = snapshot.events.map((event) => event.player);
function deps(overrides: Partial<QaDeps> = {}): QaDeps {
  let stored: unknown = null;
  let started = false;
  return {
    loadGlossary: async () => [], loadPlayers: async () => [] as never,
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => ({ text: JSON.stringify({ status: "OK", answer: "(generic LLM 답변)" }), inputTokens: 1, outputTokens: 1 }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (result: unknown) => { stored = result; },
    fetchEventRecord: fetcher,
    ...overrides,
  } as unknown as QaDeps;
}

check("스냅샷: 2026 레코드북 p.104 · 정규시즌 14건 · 제외 2건 · 해시 exact", () => {
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.throughSeason, 2025);
  assert.equal(snapshot.source.title, "2026 KBO 레코드북");
  assert.equal(snapshot.source.section, "노히트노런");
  assert.equal(snapshot.source.printedPage, 104);
  assert.equal(snapshot.events.length, 14);
  assert.deepEqual(snapshot.events.map((event) => event.ordinal), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.deepEqual(snapshot.excluded.map((event) => event.reason), ["6회 강우 콜드", "한국시리즈 4차전"]);
  const { sha256, ...unsigned } = snapshot;
  assert.equal(createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"), sha256);
});

check("해석: count/list/최초/최근/순번/선수는 닫힌 query로 변환", () => {
  assert.deepEqual(resolveEventRecordQuery("KBO 노히트노런 몇 번 나왔어?", PLAYER_NAMES), { kind: "count" });
  assert.deepEqual(resolveEventRecordQuery("역대 노히트 노런 알려줘", PLAYER_NAMES), { kind: "list" });
  assert.deepEqual(resolveEventRecordQuery("최초 노-히트-노-런 누구야?", PLAYER_NAMES), { kind: "first" });
  assert.deepEqual(resolveEventRecordQuery("가장 최근 노히트노런", PLAYER_NAMES), { kind: "latest" });
  assert.deepEqual(resolveEventRecordQuery("KBO 9번째 노히트노런", PLAYER_NAMES), { kind: "ordinal", ordinal: 9 });
  assert.deepEqual(resolveEventRecordQuery("양의지 노히트노런", PLAYER_NAMES), null, "포수 이름을 달성자로 추정하거나 전체 목록으로 바꾸지 않는다");
  assert.deepEqual(resolveEventRecordQuery("선동열 노히트노런", PLAYER_NAMES), { kind: "player", player: "선동열" });
});

check("해석 fail-close: 경쟁 intent를 우선순위로 하나만 골라 오결속하지 않는다", () => {
  for (const question of [
    "선동열 9번째 노히트노런",
    "최초 최근 노히트노런",
    "9번째 최초 노히트노런",
    "9번째 최근 노히트노런",
    "9번째 노히트노런 몇 번?",
    "9번째, 10번째 노히트노런 알려줘",
  ]) {
    assert.equal(resolveEventRecordQuery(question, PLAYER_NAMES), null, question);
  }
});

check("조회: 최초·최근·9번째·선수 exact, 범위 밖 순번은 null", () => {
  assert.equal(resolveEventRecord(snapshot, { kind: "first" })?.events[0].player, "방수원");
  assert.equal(resolveEventRecord(snapshot, { kind: "latest" })?.events[0].player, "맥과이어");
  assert.equal(resolveEventRecord(snapshot, { kind: "ordinal", ordinal: 9 })?.events[0].player, "정민철");
  assert.equal(resolveEventRecord(snapshot, { kind: "player", player: "양의지" }), null);
  assert.equal(resolveEventRecord(snapshot, { kind: "ordinal", ordinal: 15 }), null);
});

check("fail-close: 값/행/해시 변조는 전부 null", () => {
  for (const mutate of [
    (value: any) => { value.events[0].score = "9-0"; },
    (value: any) => {
      value.events.pop();
      const { sha256: _old, ...unsigned } = value;
      value.sha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    },
    (value: any) => { value.events[1].ordinal = 1; },
  ]) {
    const broken = structuredClone(snapshot) as any;
    mutate(broken);
    assert.equal(resolveEventRecord(broken, { kind: "count" }), null);
  }
});

check("렌더: 정규시즌·기준시즌·레코드북 페이지를 명시", () => {
  const count = composeEventRecordAnswer(resolveEventRecord(snapshot, { kind: "count" })!);
  assert.ok(count.includes("정규시즌 공식") && count.includes("14번") && count.includes("2025시즌까지"));
  assert.ok(count.includes("2026 KBO 레코드북 p.104"));
  const latest = composeEventRecordAnswer(resolveEventRecord(snapshot, { kind: "latest" })!);
  assert.ok(latest.includes("맥과이어") && latest.includes("2019년 4월 21일") && latest.includes("13탈삼진"));
});

check("라우터: 사건 질문만 event_record, 퍼펙트게임·완봉승은 추정 결속하지 않는다", () => {
  assert.equal(routeQuestion("KBO 노히트노런 몇 번 나왔어?"), "event_record");
  assert.notEqual(routeQuestion("KBO 퍼펙트게임 몇 번 나왔어?"), "event_record");
  assert.notEqual(routeQuestion("KBO 완봉승 기록 알려줘"), "event_record");
});

checkAsync("종단: 6개 질문형이 kbo_structured, LLM·RAG·cache 호출 0", async () => {
  let llm = 0; let cache = 0;
  const d = deps({
    callLlm: async () => { llm += 1; throw new Error("LLM called"); },
    getCache: async () => { cache += 1; return null; },
  });
  for (const question of [
    "KBO 노히트노런 몇 번 나왔어?", "노히트노런 총 몇 번 나왔어?", "역대 노히트노런 알려줘", "최초 노히트노런 누구야?",
    "가장 최근 노히트노런", "9번째 노히트노런", "선동열 노히트노런 기록",
  ]) {
    const result = await answerQuestion("u1", question, d);
    assert.equal(result.source, "kbo_structured", `${question} -> ${result.source} :: ${result.answer}`);
    assert.ok(result.answer.includes("KBO 레코드북"), question);
  }
  assert.equal(llm, 0);
  assert.equal(cache, 0);
});

checkAsync("종단 fail-close: 미배선·범위 밖 순번은 history_hold, 조회 예외는 error", async () => {
  const unbound = await answerQuestion("u1", "최근 노히트노런", deps({ fetchEventRecord: undefined }));
  assert.equal(unbound.source, "history_hold");
  const missing = await answerQuestion("u1", "15번째 노히트노런", deps());
  assert.equal(missing.source, "history_hold");
  const failed = await answerQuestion("u1", "최근 노히트노런", deps({ fetchEventRecord: async () => { throw new Error("boom"); } }));
  assert.equal(failed.source, "error");
});

checkAsync("종단 fail-close: 경쟁 intent를 우선순위로 하나만 골라 오결속하지 않는다", async () => {
  for (const question of [
    "선동열 9번째 노히트노런",
    "최초 최근 노히트노런",
    "9번째 최초 노히트노런",
    "9번째 최근 노히트노런",
    "9번째 노히트노런 몇 번?",
    "9번째, 10번째 노히트노런 알려줘",
  ]) {
    const result = await answerQuestion("u1", question, deps());
    assert.equal(result.source, "history_hold", `${question} -> ${result.source} :: ${result.answer}`);
    assert.ok(!result.answer.includes("선동열") && !result.answer.includes("정민철"), question);
  }
});

checkAsync("종단 fail-close: 미지원 한정어 5축을 버리고 정규시즌 14번으로 오결속하지 않는다", async () => {
  for (const question of [
    "한국시리즈 노히트노런 몇 번?",
    "강우콜드 노히트노런 몇 번?",
    "2010년 이후 노히트노런 몇 번?",
    "두산 노히트노런 몇 번?",
    "퍼펙트게임 노히트노런 몇 번?",
  ]) {
    const result = await answerQuestion("u1", question, deps());
    assert.equal(result.source, "history_hold", `${question} -> ${result.source} :: ${result.answer}`);
    assert.ok(!result.answer.includes("14번"), question);
  }
});

async function main() {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.log(`FAIL ${name} :: ${(error as Error).message}`); }
  }
  console.log(`\nevent records: PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) process.exit(1);
}
void main();
