/**
 * 야잘알봇 성의(답변 길이·충실도) 실 provider 게이트 (삼순 2026-08-10 4차 재작성).
 *
 * 3차 지적: raw Gemini 만 호출하면 `answerQuestion`/최종 서빙(320 상한·출처·검증 게이트)
 * 을 우회하고, 400자 상한·`문장≥2 || 길이≥100` 항진 단정은 계약이 아니다.
 *
 * 그래서 이 게이트는 **production 파이프라인에 실 provider 를 주입**한다:
 *  - `answerQuestion` 종단 실행 (검증·상한·출처 표기 전부 production 코드).
 *  - `callRagLlm` = 배포 코드와 동일한 `buildRagLlmRequest` + `RAG_SYSTEM_PROMPT` 로
 *    실제 Gemini 호출 (mock 답 주입 없음).
 *  - 근거 = production `genius_rag_chunks` 실 데이터 (문보경 별명 chunk).
 *  - 판정 = 최종 서빙 결과의 source·본문 길이(320 = BASEBALL_GENIUS_MAX_ANSWER_LENGTH)·
 *    출처 표기.
 *
 * 키·DB 접근이 없으면 조용한 SKIP 이 아니라 **명시적 실패(exit 1)** 다.
 * 실행: npm run qa:genius-sincerity-live (네트워크·시크릿 필요 — PR checks 밖 수동 게이트)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import { BASEBALL_QA_GEMINI_MODEL } from "../../src/lib/baseball-qa/gemini-request";
import { buildRagLlmRequest, RAG_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/rag/retrieve";
import { answerQuestion } from "../../src/lib/baseball-qa/pipeline";
import type { QaDeps, RagEvidence, RagLlmExtras } from "../../src/lib/baseball-qa/pipeline";
import type { PlayerRef } from "../../src/lib/baseball-qa/roster/load-roster-players";

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(resolve(process.cwd(), ".env.local"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!GEMINI_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("FAIL 필요 env 부재 (GEMINI_API_KEY / SUPABASE_URL / SERVICE_ROLE) — SKIP 아님, 실패");
  process.exit(1);
}

interface ChunkRow {
  content: string;
  page_title: string;
  canonical_url: string;
  revision: string | null;
  section_path: string;
  as_of: string | null;
}

/** production 실근거: 문보경 나무위키 chunk 중 별명 서술 상위 4건. */
async function fetchRealEvidence(): Promise<RagEvidence[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/genius_rag_chunks` +
    `?select=content,page_title,canonical_url,revision,section_path,as_of` +
    `&page_title=eq.${encodeURIComponent("문보경")}` +
    `&content=ilike.${encodeURIComponent("*별명*")}` +
    `&order=chunk_index.asc&limit=6`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`supabase REST ${res.status}`);
  const rows = (await res.json()) as ChunkRow[];
  return rows.map((row) => ({
    content: row.content,
    pageTitle: row.page_title,
    canonicalUrl: row.canonical_url,
    revision: row.revision ?? "1",
    sectionPath: row.section_path,
    asOf: row.as_of ?? "2026-01-01",
    sourceGrade: "tier2" as const,
    sourceKind: "namu_document",
  })) as unknown as RagEvidence[];
}

/** 배포 코드와 동일한 요청 빌더·프롬프트로 실제 Gemini 를 호출한다 (mock 없음). */
async function realCallRagLlm(question: string, evidence: RagEvidence[], extras?: RagLlmExtras) {
  const body = buildRagLlmRequest(question, evidence, RAG_SYSTEM_PROMPT, {
    context: extras?.context,
    rosterBlock: extras?.rosterBlock,
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const text: string =
      data.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text ?? "";
    return {
      text,
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
  throw new Error("Gemini 재시도 소진");
}

const PLAYERS = [
  { kboId: "51868", name: "문보경", team: "LG", position: "내야수" },
] as unknown as PlayerRef[];

function makeLiveDeps(evidence: RagEvidence[]): QaDeps {
  let stored: unknown = null;
  let started = false;
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: true,
    searchRag: async () => evidence,
    callRagLlm: realCallRagLlm,
    callLlm: async () => { throw new Error("선수 RAG 질문에서 generic LLM 금지"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
}

/** 최종 답에서 출처 표기를 뗀 본문 — production 상한(320)은 본문에 걸린다. */
function bodyOf(answer: string): string {
  const idx = answer.indexOf("\n\n📄");
  return idx >= 0 ? answer.slice(0, idx) : answer;
}

(async () => {
  const evidence = await fetchRealEvidence();
  assert.ok(evidence.length >= 2, `실근거 부족: ${evidence.length}건 — 게이트 판정 불가는 실패다`);

  let pass = 0;
  const failures: string[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
  }

  // ① 이유·배경형 — 최종 서빙 종단: RAG 로 답하고, 본문이 성의 하한(100자) 이상,
  //    production 상한(320) 이하, 출처 표기 포함. 실패 시 blocked/unsure 로 새는 것까지 잡힌다.
  await run("이유·배경형: answerQuestion 종단 — 성의 하한·320 상한·출처", async () => {
    const result = await answerQuestion("live-u1", "문보경 별명이 생긴 이유가 뭐야?", makeLiveDeps(evidence));
    assert.equal(result.status, 200);
    assert.equal(
      result.source, "rag",
      `RAG 실답이어야 한다 (삼순 5차: 배제 나열이 아니라 양성 고정): source=${result.source} answer=${result.answer.slice(0, 120)}`,
    );
    const body = bodyOf(result.answer);
    assert.ok(body.length >= 100, `이유·배경 답이 성의 하한(100자) 미만(${body.length}자): ${body}`);
    assert.ok(
      body.length <= BASEBALL_GENIUS_MAX_ANSWER_LENGTH,
      `본문이 production 상한(${BASEBALL_GENIUS_MAX_ANSWER_LENGTH}) 초과(${body.length}자)`,
    );
    assert.ok(result.answer.includes("출처"), `출처 표기 누락: ${result.answer.slice(-60)}`);
    console.log(`   ↳ source=${result.source} 본문 ${body.length}자`);
  });

  // ② 단순 사실형 — 같은 종단에서 과장문이 아니어야 한다 (길이 지시가 죽으면 여기가 잡는다).
  await run("단순 사실형: answerQuestion 종단 — 간결(≤200자)·320 상한", async () => {
    const result = await answerQuestion("live-u2", "문보경 별명이 뭐야?", makeLiveDeps(evidence));
    assert.equal(result.status, 200);
    assert.equal(
      result.source, "rag",
      `RAG 실답이어야 한다 (삼순 5차: 배제 나열이 아니라 양성 고정): source=${result.source} answer=${result.answer.slice(0, 120)}`,
    );
    const body = bodyOf(result.answer);
    assert.ok(body.length > 0 && body.length <= 200, `단순 사실형이 과장문(${body.length}자): ${body}`);
    console.log(`   ↳ source=${result.source} 본문 ${body.length}자`);
  });

  console.log(`\nbaseball QA sincerity live: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})().catch((e) => {
  console.error(`FAIL runner :: ${(e as Error).message}`);
  process.exitCode = 1;
});
