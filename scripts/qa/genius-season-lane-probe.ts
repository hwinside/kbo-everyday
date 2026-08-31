/**
 * 시즌 lane·시점 랭킹 실측 프로브 (수동 실행, 읽기 전용).
 *
 * 삼순 2026-08-28 요구: "실제 RPC 로 `롯데 가을야구/선발진/한화 감독` top6 전후 +
 * `2018/역대/2027` 반대축을 보여주세요."
 *
 * 🔴 무엇을 재고, 무엇을 못 재는가 (분모를 먼저 밝힌다):
 *   · **BEFORE** = 프로덕션에 배포된 5인자 RPC 의 순수 코사인 top40 → 종전 랭킹 top6.
 *   · **AFTER(app)** = 같은 top40 후보에 이번 PR 의 시점 재점수화만 적용한 top6.
 *   · **AFTER(lane)** = 새 오버로드(`p_season_mode`)로 lane 을 절단 전에 확보한 결과.
 *     ⚠️ 이건 migration 20260828060000 이 적용된 DB 에서만 돈다. 미적용이면
 *        PGRST202 로 즉시 표시하고 "측정 불가"로 남긴다 — SQL 재구현으로 흉내내면
 *        "배포되는 그 함수를 태운다"는 성질이 사라진다(rag-first 프로브와 같은 규칙).
 *
 * 실행: `npx tsx scripts/qa/genius-season-lane-probe.ts`
 * DB 를 쓰지 않는다. Gemini embedding 유료 호출이 질문 수만큼 발생한다.
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

import { embedText } from "../../src/lib/baseball-qa/rag/embed";
import {
  rankEvidenceByQuery,
  resolveSeasonTarget,
  seasonLanePlan,
  RAG_CANDIDATE_LIMIT,
  type RagEvidenceCandidate,
} from "../../src/lib/baseball-qa/rag/retrieve";
import { classifyTier2Intent, tier2WeightForQuestion } from "../../src/lib/baseball-qa/rag/fetch-wikipedia";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CURRENT_SEASON = 2026;
const RPC = "search_baseball_genius_player_chunks";

interface Row {
  content: string;
  page_title: string | null;
  section_path: string | null;
  canonical_url: string | null;
  source_kind: string;
  embedding: string | number[] | null;
}

async function fetchLane(
  entityId: string,
  sourceKind: string,
  vector: number[],
  lane?: { mode: string; year?: number },
): Promise<{ rows: Row[]; error: string | null }> {
  // query-guard: bounded -- RPC 가 1..50 으로 clamp 하는 정렬 조회이며 caller 는 RAG_CANDIDATE_LIMIT(40) 을 준다.
  const { data, error } = await admin.rpc(RPC, {
    p_entity_type: "team",
    p_entity_id: entityId,
    p_source_kind: sourceKind,
    p_query_embedding: JSON.stringify(vector),
    p_limit: RAG_CANDIDATE_LIMIT,
    ...(lane ? { p_season_mode: lane.mode, p_season_year: lane.year ?? null } : {}),
  });
  if (error) return { rows: [], error: `${error.code ?? ""} ${error.message}` };
  return { rows: (data ?? []) as Row[], error: null };
}

function toCandidates(rows: Row[]): RagEvidenceCandidate[] {
  return rows.map((r) => ({
    content: r.content,
    pageTitle: r.page_title ?? "",
    sectionPath: r.section_path ?? "",
    canonicalUrl: r.canonical_url ?? "",
    sourceKind: r.source_kind as RagEvidenceCandidate["sourceKind"],
    embedding: r.embedding,
  })) as RagEvidenceCandidate[];
}

function label(e: { pageTitle?: string; sectionPath?: string }): string {
  const parts = [e.pageTitle, e.sectionPath].filter(Boolean);
  return parts.join(" / ") || "(no path)";
}

const CASES: Array<{ q: string; team: string }> = [
  { q: "롯데 가을야구 갈 수 있을까?", team: "롯데" },
  { q: "롯데 투수 선발진을 알려줘", team: "롯데" },
  { q: "한화 감독이 누구야?", team: "한화" },
  // 반대축 — 시점 개입이 과거·역대·미래를 뒤집으면 안 된다.
  { q: "2018년 한화 어땠어?", team: "한화" },
  { q: "한화 역대 감독 알려줘", team: "한화" },
  { q: "2027 한화 전망 어때?", team: "한화" },
];

async function main() {
  // 🔴 `entity_id` 는 **구단명이 아니라 숫자 teamId** 다(실측: '1'..'10' 만 존재).
  //   처음엔 `"롯데"` 를 넣었다가 BEFORE 가 **전부 0행**으로 조용히 비었다 —
  //   빈 결과를 "변화 없음"으로 읽을 뻔했다. 그래서 프로덕션 SSOT(`teamIdOfCanonical`)를
  //   그대로 태우고, 후보 0건이면 명시적으로 측정 불가로 표시한다.
  const { teamIdOfCanonical } = await import("../../src/lib/baseball-qa/pipeline");

  for (const c of CASES) {
    const teamId = teamIdOfCanonical(c.team);
    if (teamId === null) { console.log(`\n[SKIP] ${c.q} — teamId 미해결(${c.team})`); continue; }
    const entityId = String(teamId);
    const target = resolveSeasonTarget(c.q, CURRENT_SEASON);
    const lanes = seasonLanePlan(target, CURRENT_SEASON);
    console.log(`\n${"═".repeat(78)}\nQ: ${c.q}`);
    console.log(`  entity_id=${entityId} · target=${JSON.stringify(target)} · lanes=${JSON.stringify(lanes)}`);

    const embedded = await embedText(c.q);
    const vector = embedded.vector;
    const intent = classifyTier2Intent(c.q);
    const weight = (sourceKind: string) => tier2WeightForQuestion(intent, sourceKind as never);

    // BEFORE — 배포된 5인자 RPC (lane 없음)
    const beforeBatches = await Promise.all([
      fetchLane(entityId, "wikipedia_document", vector),
      fetchLane(entityId, "namu_document", vector),
    ]);
    const beforeErr = beforeBatches.map((b) => b.error).filter(Boolean);
    if (beforeErr.length) { console.log(`  BEFORE 조회 실패: ${beforeErr.join(" | ")}`); continue; }
    const beforeRows = toCandidates(beforeBatches.flatMap((b) => b.rows));
    if (beforeRows.length === 0) {
      console.log(`  ⚠️ 후보 0건 — 측정 불가(entity_id=${entityId}). 빈 결과를 "변화 없음"으로 읽지 않는다.`);
      continue;
    }
    const before = rankEvidenceByQuery(beforeRows as never, vector, weight as never).slice(0, 6);
    console.log(`  ── BEFORE (배포된 순수 코사인, ${beforeRows.length}후보 → 종전 랭킹) ──`);
    before.forEach((e, i) => console.log(`   ${i + 1}. ${label(e)}`));

    // AFTER(app) — 같은 후보에 시점 재점수화만
    const afterApp = rankEvidenceByQuery(
      beforeRows as never, vector, weight as never, undefined, CURRENT_SEASON, target,
    ).slice(0, 6);
    console.log("  ── AFTER(app, 같은 후보 + 시점 재점수화) ──");
    afterApp.forEach((e, i) => console.log(`   ${i + 1}. ${label(e)}`));

    // AFTER(lane) — 새 오버로드. migration 미적용이면 여기서 드러난다.
    const laneBatches = await Promise.all(
      (["wikipedia_document", "namu_document"] as const).flatMap((sk) =>
        lanes.map((lane) => fetchLane(entityId, sk, vector, lane))),
    );
    const laneErr = [...new Set(laneBatches.map((b) => b.error).filter(Boolean))];
    if (laneErr.length) {
      console.log(`  ── AFTER(lane): 측정 불가 — ${laneErr.join(" | ")}`);
      console.log("     (migration 20260828060000 미적용. 운영 apply 는 머지 게이트 이후다.)");
      continue;
    }
    const seen = new Set<string>();
    const laneRows: RagEvidenceCandidate[] = [];
    for (const r of toCandidates(laneBatches.flatMap((b) => b.rows))) {
      const key = `${r.canonicalUrl}\u0000${r.sectionPath}\u0000${r.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      laneRows.push(r);
    }
    const afterLane = rankEvidenceByQuery(
      laneRows as never, vector, weight as never, undefined, CURRENT_SEASON, target,
    ).slice(0, 6);
    console.log(`  ── AFTER(lane, 절단 전 확보 ${laneRows.length}후보) ──`);
    afterLane.forEach((e, i) => console.log(`   ${i + 1}. ${label(e)}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
