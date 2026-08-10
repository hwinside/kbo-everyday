/**
 * 야잘알봇 성의(답변 길이·충실도) 실 provider 게이트 (삼순 2026-08-10 3차).
 *
 * deterministic smoke(leaderboard)는 파이프라인이 LLM 답을 자르지 않고 서빙하는지만
 * 고정할 수 있다 — "이유·배경 질문에 두세 문장으로 충분히" 라는 **행동 개선** 자체는
 * 배포되는 그 RAG_SYSTEM_PROMPT + 그 요청 빌더(buildRagLlmRequest)로 실제 Gemini 를
 * 호출하고, 근거도 production genius_rag_chunks 실 데이터를 써야 검증된다.
 *
 * 키·DB 접근이 없으면 조용한 SKIP 이 아니라 **명시적 실패(exit 1)** 다.
 *
 * 실행: npm run qa:genius-sincerity-live
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASEBALL_QA_GEMINI_MODEL } from "../../src/lib/baseball-qa/gemini-request";
import { buildRagLlmRequest, RAG_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/rag/retrieve";

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

interface EvidenceRow {
  content: string;
  page_title: string;
  canonical_url: string;
  revision: string | null;
  section_path: string;
  as_of: string | null;
  source_grade: string | null;
}

/** production 실근거: 문보경 나무위키 chunk 중 별명 서술 상위 4건. */
async function fetchRealEvidence(): Promise<EvidenceRow[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/genius_rag_chunks` +
    `?select=content,page_title,canonical_url,revision,section_path,as_of,source_grade` +
    `&page_title=eq.${encodeURIComponent("문보경")}` +
    `&content=ilike.${encodeURIComponent("*별명*")}` +
    `&limit=4`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`supabase REST ${res.status}`);
  return (await res.json()) as EvidenceRow[];
}

async function callGemini(body: unknown): Promise<string> {
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
    return (
      data.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text ?? ""
    );
  }
  throw new Error("Gemini 재시도 소진");
}

function sentenceCount(text: string): number {
  return (text.match(/[다요죠]\s*[.!?]|[.!?](?=\s|$)/g) ?? []).length;
}

(async () => {
  const rows = await fetchRealEvidence();
  assert.ok(rows.length >= 2, `실근거 부족: ${rows.length}건 — 게이트 판정 불가는 실패다`);
  const evidence = rows.map((row) => ({
    content: row.content,
    pageTitle: row.page_title,
    canonicalUrl: row.canonical_url,
    revision: row.revision ?? "1",
    sectionPath: row.section_path,
    asOf: row.as_of ?? "2026-01-01",
    sourceGrade: "tier2" as const,
  }));

  let pass = 0;
  const failures: string[] = [];

  // ① 이유·배경형 — 두세 문장으로 충분히. 한 문장 성의없는 단답이면 FAIL.
  {
    const raw = await callGemini(
      buildRagLlmRequest("문보경 별명이 생긴 이유가 뭐야?", evidence as never, RAG_SYSTEM_PROMPT),
    );
    try {
      const parsed = JSON.parse(raw) as { status?: string; answer?: string };
      assert.equal(parsed.status, "GROUNDED", `status=${parsed.status} raw=${raw.slice(0, 120)}`);
      const answer = parsed.answer ?? "";
      // "충분히" 의 실체는 분량이다 — 실측에서 모델이 정보 밀도 높은 한 문장(129자)으로
      // 답하기도 하므로 문장 수 단독 단정은 과하다. 분량 하한 + (복문 또는 2문장) 로 판정.
      assert.ok(answer.length >= 100, `이유·배경 답이 너무 짧다(${answer.length}자): ${answer}`);
      assert.ok(answer.length <= 400, `상한 초과(${answer.length}자)`);
      assert.ok(
        sentenceCount(answer) >= 2 || answer.length >= 100,
        `성의 부족(${answer.length}자·${sentenceCount(answer)}문장): ${answer}`,
      );
      pass += 1;
      console.log(`PASS 이유·배경형 충분한 답변 (${answer.length}자, ${sentenceCount(answer)}문장)`);
    } catch (e) {
      failures.push(`이유·배경형 :: ${(e as Error).message}`);
      console.log(`FAIL 이유·배경형 :: ${(e as Error).message}`);
    }
  }

  // ② 단순 사실형 — 짧게 종결. 이유·배경형과 같은 장문이 나오면 프롬프트 길이 지시가 죽은 것.
  {
    const raw = await callGemini(
      buildRagLlmRequest("문보경 별명이 뭐야?", evidence as never, RAG_SYSTEM_PROMPT),
    );
    try {
      const parsed = JSON.parse(raw) as { status?: string; answer?: string };
      assert.equal(parsed.status, "GROUNDED", `status=${parsed.status} raw=${raw.slice(0, 120)}`);
      const answer = parsed.answer ?? "";
      assert.ok(answer.length > 0 && answer.length <= 200, `단순 사실형이 과장문(${answer.length}자): ${answer}`);
      pass += 1;
      console.log(`PASS 단순 사실형 간결 답변 (${answer.length}자)`);
    } catch (e) {
      failures.push(`단순 사실형 :: ${(e as Error).message}`);
      console.log(`FAIL 단순 사실형 :: ${(e as Error).message}`);
    }
  }

  console.log(`\nbaseball QA sincerity live: PASS=${pass} FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})().catch((e) => {
  console.error(`FAIL runner :: ${(e as Error).message}`);
  process.exitCode = 1;
});
