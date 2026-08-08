/**
 * 인입 질문 **전건 terminal 감사** — 라우팅 라벨이 아니라 `answerQuestion()` 이
 * 실제로 돌려준 결과를 판정한다.
 *
 * ⚠️ **왜 이 게이트가 생겼나** (삼순 2026-08-08, 하린아빠 18:49 지시).
 *
 * 종전 검수는 `routeQuestion()`·`classifyNamedStat()` 같은 **중간 판정**만 봤다.
 * 그래서 두 번 틀렸다:
 *   ① `llm_scope_gate` 를 "구제됨" 으로 셌는데, 그건 라우터가 안 막았다는 뜻일 뿐
 *      유저가 답을 받았다는 뜻이 아니다. 뒤에 validator·근거 검사가 더 있다.
 *   ② 반대로 `blocked` 를 결손으로 셌는데, production 은 선수 경로가 앞단에서
 *      가로채므로 유저는 이미 답을 받고 있었다(2026-08-04 실측).
 * 중간 단계는 유저 결과가 아니다. **종단만 사실이다.**
 *
 * ── 격리 설계 ────────────────────────────────────────────────────────────────
 * 실 provider·실 DB 를 태우지 않는다(과금·부작용·일일한도). 대신:
 *   · quota      항상 allowed (일일 5건 한도가 감사를 막지 못하게)
 *   · LLM        결정론 stub. **호출 여부를 센다** — 이게 이 감사의 핵심 신호다.
 *   · glossary   운영 DB 실제 사전 132항목 (읽기 전용)
 *   · roster     운영 로스터 실데이터 (읽기 전용)
 *   · RAG        결정론 stub. 근거 유무를 인자로 재현한다.
 *
 * 판정하는 것은 "무슨 답을 했나"(모델 출력은 stub 이므로 무의미)가 아니라
 * **어느 종단으로 끝났고, 그 과정에서 생성 경로에 내려갔는가** 이다.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(__dirname, "../../.env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

import { createClient } from "@supabase/supabase-js";
import {
  answerQuestion,
  type QaDeps,
  type MatchPath,
  type GlossaryEntry,
  type PlayerRef,
} from "../../src/lib/baseball-qa/pipeline";
import { ROSTER_PLAYERS } from "../../src/lib/baseball-qa/roster/load-roster-players";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(SUPABASE_URL && SERVICE_ROLE, "운영 사전·로그 조회에 service role 이 필요하다");
const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * `match_path` 를 **유저 관점 3분류**로 접는다.
 *
 * ⚠️ 이 표는 `MATCH_PATH_REPLY_KIND`(마스코트용)와 **다른 축**이다. 저건 화면 표정이고
 *   이건 감사 축이다 — 되묻기는 화면상 `unavailable` 이지만 감사에서는 "못 답함" 과
 *   구분해야 한다(그게 `stat_clarify` 를 따로 만든 이유다).
 */
type Outcome = "answered" | "clarify" | "unanswered";
const OUTCOME: Record<Exclude<MatchPath, "pending">, Outcome> = {
  dictionary: "answered",
  cache: "answered",
  llm: "answered",
  rag: "answered",
  team_rag: "answered",
  news_rag: "answered",
  kbo_structured: "answered",
  ack: "answered",
  // 되묻기 계열 — 답은 아니지만 대화가 이어진다. 과차단과 구분해서 센다.
  scope_guide: "clarify",
  stat_clarify: "clarify",
  player_picker: "clarify",
  context_missing: "clarify",
  // 못 답함
  blocked: "unanswered",
  unsure: "unanswered",
  limited: "unanswered",
  error: "unanswered",
  service_redirect: "unanswered",
  history_hold: "unanswered",
};

const STUB_LLM_ANSWER = '{"status":"ANSWER","answer":"야구 규칙 설명입니다."}';

interface Counters {
  llm: number;
  cacheGet: number;
  cacheSet: number;
  playerRag: number;
  teamRag: number;
  newsRag: number;
  officialRag: number;
}

function freshCounters(): Counters {
  return { llm: 0, cacheGet: 0, cacheSet: 0, playerRag: 0, teamRag: 0, newsRag: 0, officialRag: 0 };
}

/**
 * **production 형상** deps. 배선 플래그를 운영과 같게 켠다 — 그래야 앞단 가로채기가
 * 실제 순서대로 동작한다. 이걸 빼면 `blocked` 가 과다 계상돼 결손을 지어내게 된다.
 */
function prodShapedDeps(
  glossary: GlossaryEntry[],
  players: PlayerRef[],
  counters: Counters,
  logs: MatchPath[],
): QaDeps {
  const evidence = [{
    content: "해당 대상에 대한 근거 문장입니다.",
    pageTitle: "문서", canonicalUrl: "https://example.test/doc", revision: "1",
    sectionPath: "개요", asOf: "2026-01-01", sourceGrade: "tier2",
  }] as never;
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => players,
    getCache: async () => { counters.cacheGet++; return null; },
    setCache: async () => { counters.cacheSet++; },
    callLlm: async () => {
      counters.llm++;
      return { text: STUB_LLM_ANSWER, inputTokens: 1, outputTokens: 1 };
    },
    // ⚠️ 일일한도를 항상 열어둔다. 한도에 걸리면 그 뒤 전건이 `limited` 로 뭉개져
    //   감사 자체가 무의미해진다(격리의 이유).
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async (entry) => { logs.push(entry.matchPath as MatchPath); },
    now: () => Date.now(),
    // ── production 배선 플래그 ──
    enablePlayerRag: true,
    enableTeamRag: true,
    enableNewsRag: true,
    searchRag: async () => { counters.playerRag++; return evidence; },
    callRagLlm: async () => ({
      text: '{"status":"GROUNDED","answer":"근거 기반 답변입니다."}', inputTokens: 1, outputTokens: 1,
    }),
    callTeamRagLlm: async () => ({
      text: '{"status":"GROUNDED","answer":"구단 근거 기반 답변입니다."}', inputTokens: 1, outputTokens: 1,
    }),
    searchNewsRag: async () => { counters.newsRag++; return evidence; },
    callNewsRagLlm: async () => ({
      text: '{"status":"GROUNDED","answer":"기사 근거 기반 답변입니다."}', inputTokens: 1, outputTokens: 1,
    }),
    searchOfficialRag: async () => { counters.officialRag++; return []; },
  };
}

async function loadGlossaryFromDb(): Promise<GlossaryEntry[]> {
  const { data, error } = await admin
    .from("baseball_terms")
    .select("term,aliases,answer")
    .limit(2000);
  assert.ok(!error, `사전 조회 실패: ${error?.message}`);
  const rows = (data ?? []) as GlossaryEntry[];
  // ⚠️ 빈 사전으로 감사하면 전건이 되묻기로 떨어지고 그게 "결손 0" 처럼 보인다.
  assert.ok(rows.length >= 100, `사전이 비었다(${rows.length}). 감사 전제가 깨졌다`);
  return rows;
}

/** 한 번에 읽는 페이지 크기. */
const PAGE = 1000;
/**
 * 페이지 상한. 이 감사는 **끝까지 읽어야** 의미가 있지만(전건 감사), 무한 페이저는
 * 로그가 커지면 조용히 수십 분을 태운다. 상한을 두고, 상한에 닿으면 통과가 아니라
 * **실패**로 알린다 — 조용히 잘린 표본으로 "결손 0" 을 보고하는 것이 가장 나쁘다.
 */
const MAX_PAGES = 50;

/** 운영 로그의 인입 질문을 정규화 unique 로 뽑는다. */
async function loadUniqueQuestions(): Promise<string[]> {
  const seen = new Map<string, string>();
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    // query-guard: bounded-page -- 감사 표본을 MAX_PAGES(=5만행)로 상한하고,
    // 상한에 닿으면 아래에서 fail-close 한다(조용한 절단 금지).
    const { data, error } = await admin
      .from("genius_question_logs")
      .select("question")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    assert.ok(!error, `로그 조회 실패: ${error?.message}`);
    const rows = (data ?? []) as Array<{ question: string | null }>;
    for (const row of rows) {
      const q = (row.question ?? "").trim();
      if (!q) continue;
      const key = q.replace(/\s+/gu, " ").toLowerCase();
      if (!seen.has(key)) seen.set(key, q);
    }
    if (rows.length < PAGE) { exhausted = true; break; }
  }
  assert.ok(
    exhausted,
    `로그가 페이지 상한(${MAX_PAGES}×${PAGE}행)을 넘었다. 전건 감사가 아니므로 상한을 올리고 다시 돌려라`,
  );
  return [...seen.values()];
}

interface AuditRow {
  question: string;
  source: MatchPath;
  outcome: Outcome;
  llmCalls: number;
  cacheWrites: number;
}

async function main() {
  const [glossary, questions] = await Promise.all([loadGlossaryFromDb(), loadUniqueQuestions()]);
  const players = ROSTER_PLAYERS as unknown as PlayerRef[];
  assert.ok(players.length >= 500, `로스터가 비었다(${players.length})`);
  console.log(`감사 대상 unique 질문 ${questions.length}건 · 사전 ${glossary.length} · 로스터 ${players.length}`);

  const rows: AuditRow[] = [];
  for (const question of questions) {
    const counters = freshCounters();
    const logs: MatchPath[] = [];
    let source: MatchPath;
    try {
      const result = await answerQuestion("audit-user", question, prodShapedDeps(glossary, players, counters, logs));
      source = result.source as MatchPath;
    } catch (err) {
      // 감사 자체가 죽으면 안 된다. 예외도 사실로 기록한다.
      source = "error";
      console.error(`  ⚠️ 예외: ${question} — ${(err as Error).message}`);
    }
    rows.push({
      question,
      source,
      outcome: OUTCOME[source as Exclude<MatchPath, "pending">] ?? "unanswered",
      llmCalls: counters.llm,
      cacheWrites: counters.cacheSet,
    });
  }

  // ── 집계 ──
  const byOutcome = new Map<Outcome, number>();
  const bySource = new Map<MatchPath, number>();
  for (const r of rows) {
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  }
  console.log("\n── 종단 분류 ──");
  for (const outcome of ["answered", "clarify", "unanswered"] as Outcome[]) {
    const n = byOutcome.get(outcome) ?? 0;
    console.log(`  ${outcome.padEnd(12)} ${String(n).padStart(5)}  ${((n / rows.length) * 100).toFixed(1)}%`);
  }
  console.log("\n── match_path 분포 ──");
  for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(18)} ${String(n).padStart(5)}`);
  }

  writeFileSync(
    "/tmp/genius-terminal-audit.json",
    JSON.stringify({ total: rows.length, rows }, null, 0),
  );

  // ── 계약 ──
  //
  // ⚠️ **이 감사의 핵심 계약**: 되묻기(`stat_clarify`)로 끝난 질문은 생성 경로에
  //   내려가면 안 된다. 내려갔다면 되묻기가 종결이 아니라 통과였다는 뜻이고,
  //   그건 존재를 확인 못 한 대상의 기록을 LLM 이 지어낼 수 있다는 뜻이다.
  const clarifyLeaks = rows.filter((r) => r.source === "stat_clarify" && (r.llmCalls > 0 || r.cacheWrites > 0));
  assert.deepEqual(
    clarifyLeaks.map((r) => r.question), [],
    `되묻기가 생성 경로에 내려갔다(${clarifyLeaks.length}건)`,
  );

  // 차단 계열도 마찬가지다.
  const blockedLeaks = rows.filter(
    (r) => (r.source === "blocked" || r.source === "history_hold") && (r.llmCalls > 0 || r.cacheWrites > 0),
  );
  assert.deepEqual(
    blockedLeaks.map((r) => r.question), [],
    `차단 경로가 생성 경로에 내려갔다(${blockedLeaks.length}건)`,
  );

  // 감사 자체가 빈 채로 통과하는 것을 막는다.
  assert.ok(rows.length >= 2000, `감사 표본이 너무 적다(${rows.length}) — 로그 조회가 끊겼을 수 있다`);

  console.log(`\n✅ genius terminal answer audit: ${rows.length}건 종단 실행 · 되묻기/차단 생성누수 0`);
  console.log("   상세: /tmp/genius-terminal-audit.json");
}

main().catch((err) => {
  console.error("❌ terminal audit FAIL:", err);
  process.exit(1);
});
