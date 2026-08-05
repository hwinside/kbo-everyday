/**
 * 실 Production corpus 기준 tier2 근거 선정 프로브 (수동 실행).
 *
 * 왜 CI 게이트가 아니라 프로브인가:
 *   실제 embedding(Gemini 유료 호출) + Production DB 가 있어야 하므로 CI 에서 돌릴 수 없다.
 *   그래서 PGlite 게이트(`qa:baseball-rag-serving`)가 계약·배선을 결정론적으로 잡고,
 *   이 프로브는 **실 corpus 에서 정말 그 근거가 뽑히는지**를 사람이 확인하는 용도다.
 *   삼순 P0-2(2026-08-05): "synthetic index60 chunk 로 .some() 만 보면 실제 답이 계속
 *   만루바보여도 GREEN 일 수 있다" → 실 133 chunk 로 확인하는 경로를 남긴다.
 *
 * 실행: `npm run qa:genius-rag-real-corpus`
 * 읽기 전용이다 — DB 를 쓰지 않는다.
 *
 * ⚠️ 이 프로브는 **migration 적용 후에만** 돌아간다(배포 RPC 를 직접 부른다).
 * 적용 전에는 `Could not find the function ...` 로 즉시 종료하는게 정상이다 —
 * SQL 재구현으로 우회하면 "배포되는 그 함수를 태운다"는 성질이 사라진다.
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

import { embedText } from "../../src/lib/baseball-qa/rag/embed";
import { rankEvidenceByQuery, RAG_CANDIDATE_LIMIT } from "../../src/lib/baseball-qa/rag/retrieve";
import { classifyTier2Intent, tier2SourceOf, tier2WeightForQuestion } from "../../src/lib/baseball-qa/rag/fetch-wikipedia";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** 문보경(69102) — 사고 당사자. namu 133 chunk, '문보물'은 chunk_index 51. */
const ENTITY_ID = "69102";

interface Case {
  question: string;
  expectSource: "namu" | "wikipedia";
  expectContains?: string;
  why: string;
}

const CASES: Case[] = [
  {
    question: "문보경 별명이 뭐야?",
    expectSource: "namu",
    expectContains: "문보물",
    why: "팬덤 축 — 위키피디아엔 별명 서술이 없다. 무순서 절단이면 chunk_index 51 이 탈락한다.",
  },
  {
    question: "문보경 소속팀이 어디야?",
    expectSource: "wikipedia",
    why: "프로필 축 — 공식 사실은 편집검증된 위키피디아가 앞서야 한다(전역 namu 우선의 회귀 검출).",
  },
];

async function fetchCandidates(sourceKind: string, vector: number[]) {
  // query-guard: bounded -- 배포 RPC 그대로 호출한다(상한은 함수 안에서 clamp).
  const { data, error } = await admin.rpc("search_baseball_genius_player_chunks", {
    p_entity_type: "player",
    p_entity_id: ENTITY_ID,
    p_source_kind: sourceKind,
    p_query_embedding: JSON.stringify(vector),
    p_limit: RAG_CANDIDATE_LIMIT,
  });
  if (error) throw new Error(`${sourceKind}: ${error.message}`);
  return ((data ?? []) as Record<string, string>[]).map((row) => ({
    content: row.content,
    pageTitle: row.page_title,
    canonicalUrl: row.canonical_url,
    revision: row.revision,
    sectionPath: row.section_path,
    asOf: row.as_of,
    sourceGrade: row.source_grade === "tier1" ? ("tier1" as const) : ("tier2" as const),
    embedding: row.embedding,
  }));
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("SUPABASE env 가 필요하다");
  let failures = 0;

  for (const testCase of CASES) {
    const embedded = await embedText(testCase.question, "query");
    if (!embedded.ok) throw new Error(`embed 실패: ${embedded.reason}`);
    const [wikipedia, namu] = await Promise.all([
      fetchCandidates("wikipedia_document", embedded.vector),
      fetchCandidates("namu_document", embedded.vector),
    ]);
    const evidence = rankEvidenceByQuery(
      [...wikipedia, ...namu],
      embedded.vector,
      tier2WeightForQuestion(testCase.question),
    );

    const topSource = evidence[0] ? tier2SourceOf(evidence[0].canonicalUrl) : null;
    const contains = testCase.expectContains
      ? evidence.some((row) => row.content.includes(testCase.expectContains!))
      : true;
    const ok = topSource === testCase.expectSource && contains;
    if (!ok) failures += 1;

    console.log(`\n${ok ? "PASS" : "FAIL"} [${testCase.question}]`);
    console.log(`  intent=${classifyTier2Intent(testCase.question)} 후보 wiki=${wikipedia.length} namu=${namu.length}`);
    console.log(`  기대 top=${testCase.expectSource} 실제 top=${topSource}`
      + (testCase.expectContains ? ` / '${testCase.expectContains}' 포함=${contains ? "YES" : "NO"}` : ""));
    console.log(`  근거: ${testCase.why}`);
    evidence.forEach((row, index) => {
      const source = tier2SourceOf(row.canonicalUrl);
      const marker = testCase.expectContains && row.content.includes(testCase.expectContains) ? " ★" : "";
      console.log(`   ${index + 1}. [${source}] ${row.sectionPath}${marker} :: ${row.content.replace(/\n+/g, " / ").slice(0, 90)}`);
    });
  }

  if (failures > 0) {
    console.error(`\n실 corpus 프로브 FAIL ${failures}건`);
    process.exit(1);
  }
  console.log(`\n✅ 실 corpus 프로브 ${CASES.length}건 PASS (읽기 전용)`);
}

main().catch((error) => {
  console.error("실 corpus 프로브 실패:", error instanceof Error ? error.message : JSON.stringify(error));
  process.exit(1);
});
