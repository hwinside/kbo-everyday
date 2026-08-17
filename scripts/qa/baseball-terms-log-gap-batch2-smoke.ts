/**
 * 검수 사전 2차 로그 기반 확장 게이트 (2026-08-17).
 *
 * 무엇을 증명하는가:
 *  ① migration 을 **실제로 실행**해 행 수가 163 → 176 로 늘어나는지 (PGlite, production 스키마)
 *  ② 신규 13항목이 `answerQuestion` **종단**에서 실제 답변으로 나오는지 — 운영 로그 원문 그대로
 *  ③ 신규 전건이 **회수 가능**한지 — production `matchGlossary` 로 exact 또는 어절 매칭
 *  ④ 답변 톤이 합니다체 SSOT 를 지키는지 (`isBaseballGeniusToneCompliant`)
 *  ⑤ 근거 분류 계약(official ↔ source_url ↔ rule_version)
 *  ⑥ 멱등 — 두 번 실행해도 행 수·내용이 변하지 않는지
 *  ⑦ 정규화 키 충돌 0 — 신규 term/alias 가 **기존 항목의 키를 가로채지 않는지**
 *  ⑧ 신규 13항목 전부 운영 로그 근거 보유 — 게이트가 fixture 원문을 **다시 세어** 판정
 *  ⑨ alias 보강이 기존 `answer` 를 한 글자도 바꾸지 않는지 (톤 migration CAS 보호)
 *
 * ⚠️ 이 게이트는 사전 **행 데이터**를 검증한다. 룰(코드) 추가가 아니므로 파서·정규식이 늘지 않는다.
 *
 * 🔴 근거의 자격 (1차 배치 교훈 그대로): 단순 substring 집계는 `돈내야만` 을 `내야수` 근거로
 *   세어버린다. 유효 근거 = production `matchGlossary` 가 **질문 전체 exact** 또는 **어절 하나**로
 *   그 term 을 실제로 회수하는 경우만. 게이트는 fixture 의 분류를 믿지 않고 같은 판정을 재실행한다.
 *
 * `--selftest` 는 배치를 빼는 결함 주입으로 검출력을 증명한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import {
  answerQuestion,
  matchGlossary,
  type GlossaryEntry,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { normalizeKey, normalizeQuestion } from "../../src/lib/baseball-qa/normalize";
import { isBaseballGeniusToneCompliant } from "../../src/lib/baseball-qa/tone";

const ROOT = process.cwd();
const SELFTEST = process.argv.includes("--selftest");

const seedSql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260730_baseball_qa_seed.sql"), "utf8");
const clubSql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260730_baseball_qa.sql"), "utf8");
const batch1Sql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260816010000_baseball_terms_log_gap_batch.sql"),
  "utf8",
);
const batch2Sql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260817090000_baseball_terms_log_gap_batch2.sql"),
  "utf8",
);

/**
 * 행 수 SSOT.
 *   재구축본  132(seed) + 4(1차 정본화) + 27(1차 신규) = 163 → + 13(이번) = 176
 *   production 163 → + 13 = 176
 */
const ROWS_AFTER_BATCH1 = 163;
const BATCH2_ROWS = 13;
const FINAL_ROWS = ROWS_AFTER_BATCH1 + BATCH2_ROWS;

/**
 * 2026-08-17 실측 운영 로그 근거 — fixture 원문에서 읽는다.
 *
 * 🔴 개수를 소스에 자가 기입하지 않는다. fixture 에는 **질문 원문 + match_path** 만 담고,
 *   게이트가 그것을 세고 `matchGlossary` 로 회수 가능성을 재판정한다.
 */
const logEvidence = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-log-evidence-20260817.json"), "utf8"),
) as {
  captured_at: string;
  window: string;
  total_rows: number;
  terms: Array<{ term: string; pattern: string; hits: Array<{ question: string; matchPath: string }> }>;
};

/** 실패 종결로 세는 match_path — 이 배치가 겨냥한 결손이다. */
const FAIL_PATHS = new Set(["unsure", "blocked", "scope_guide", "stat_clarify"]);

/**
 * 종단 케이스 — **운영 로그에 실제로 있던 질문 원문 그대로**. 지어낸 문장이 아니다.
 * 각 신규 term 이 `answerQuestion` 에서 `dictionary` 로 종결되는지 본다.
 */
const END_TO_END: Array<{ term: string; question: string }> = [
  { term: "게임차", question: "게임 차는 뭐야?" },
  { term: "할푼리", question: "할,푼,리 가 무슨 뜻이야??" },
  { term: "투수", question: "투수는뭐야" },
  { term: "1군", question: "1군 2군이 뭐야" },
  { term: "퀄리티스타트플러스", question: "퀄리티 스타트 플러스" },
  { term: "필승조", question: "필승조" },
  { term: "와이어투와이어", question: "와이어 투 와이어" },
  { term: "가을야구", question: "가을야구" },
  { term: "타이틀홀더", question: "타이틀홀더" },
  { term: "주루", question: "주루기록이 뭐야" },
  { term: "플라잉캐치", question: "플라잉캐치는" },
  { term: "설욕", question: "설욕" },
  { term: "집관", question: "집관" },
];

interface TermRow {
  term: string;
  aliases: string[];
  answer: string;
  category: string;
  source_kind: string;
  source_url: string | null;
  rule_version: string;
  reviewed_at: string | Date | null;
}

async function loadDb(applyBatch2Times: number): Promise<PGlite> {
  const db = new PGlite();
  const createStmt = clubSql.match(/CREATE TABLE[\s\S]*?baseball_terms[\s\S]*?\);/i)?.[0];
  assert.ok(createStmt, "baseball_terms CREATE TABLE 을 찾지 못했다");
  await db.exec(createStmt.replace(/public\./g, ""));
  await db.exec(seedSql.replace(/public\./g, ""));
  await db.exec(batch1Sql.replace(/public\./g, ""));
  // 🔴 batch2 의 postcondition DO 블록은 `public.` 을 떼면 안 되는 게 아니라, 떼야 PGlite 에서 돈다.
  for (let i = 0; i < applyBatch2Times; i += 1) await db.exec(batch2Sql.replace(/public\./g, ""));
  return db;
}

async function readAll(db: PGlite): Promise<TermRow[]> {
  const res = await db.query<TermRow>(
    "SELECT term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at"
      + " FROM baseball_terms ORDER BY term",
  );
  return res.rows;
}

function toGlossary(rows: TermRow[]): GlossaryEntry[] {
  return rows.map((r) => ({ term: r.term, aliases: r.aliases, answer: r.answer }));
}

/** 사전 경로만 태우는 deps — LLM·RAG·캐시가 돌면 그 자체가 결함이다. */
function dictOnlyDeps(glossary: GlossaryEntry[], counters: { llm: number; cacheGet: number; cacheSet: number }): QaDeps {
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => [],
    getCache: async () => { counters.cacheGet += 1; return null; },
    setCache: async () => { counters.cacheSet += 1; },
    callLlm: async () => {
      counters.llm += 1;
      return { text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 };
    },
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async () => {},
  };
}

interface CheckResult { pass: number; fail: string[] }

async function runChecks(applyBatch2: boolean): Promise<CheckResult> {
  let pass = 0;
  const fail: string[] = [];
  const check = (ok: boolean, label: string) => { if (ok) pass += 1; else fail.push(label); };

  const db = await loadDb(applyBatch2 ? 1 : 0);
  const rows = await readAll(db);
  const glossary = toGlossary(rows);

  // base(이번 배치 미적용) — "이 배치 이전에는 못 걸렸음" 대조용.
  const baseDb = await loadDb(0);
  const baseRows = await readAll(baseDb);
  await baseDb.close();
  const baseTerms = new Set(baseRows.map((r) => r.term));
  const baseGlossary = toGlossary(baseRows);

  // 🔴 기대값은 **항상 적용 후 상태**로 고정한다 (검출력의 핵심).
  //   종전 판은 `applyBatch2 ? A : B` 로 기대까지 같이 바꿔서, 배치를 빼면 "안 들어간 상태"를
  //   기대하며 전부 GREEN 이 됐다 — 결함 주입으로 절대 RED 가 될 수 없는 게이트였다.
  //   (--selftest 가 RED 0건으로 그것을 먼저 반증했다.)

  // ① 행 수
  check(rows.length === FINAL_ROWS, `행 수 ${FINAL_ROWS} (실제 ${rows.length})`);

  const added = rows.filter((r) => !baseTerms.has(r.term));
  check(added.length === BATCH2_ROWS, `신규 ${BATCH2_ROWS}건 (실제 ${added.length})`);

  // ⑧ fixture 가 신규 전건을 덮는가 — 근거 없는 행이 하나도 없어야 한다.
  check(
    logEvidence.terms.length === BATCH2_ROWS,
    `근거 fixture 가 신규 전건을 덮는가 ${BATCH2_ROWS} (실제 ${logEvidence.terms.length})`,
  );

  // 🔴 유효 근거 재판정 — fixture 의 분류를 믿지 않고 production matchGlossary 로 다시 판정한다.
  const classify = (question: string, term: string) => {
    const exact = matchGlossary(glossary, question)?.term ?? null;
    const eojeol = question
      .split(/\s+/)
      .some((w) => w.length > 0 && matchGlossary(glossary, w)?.term === term);
    return { valid: exact === term || eojeol, exact };
  };

  {
    for (const entry of logEvidence.terms) {
      // 배치가 이 term 을 실제로 넣었는가
      check(added.some((r) => r.term === entry.term), `근거 fixture 의 term "${entry.term}" 이 배치에 없다`);

      const valid = entry.hits.filter((h) => classify(h.question, entry.term).valid);
      const validFails = valid.filter((h) => FAIL_PATHS.has(h.matchPath));
      // 유효 근거 ≥ 1 (회수 가능한 실제 질문이 있어야 사전에 넣을 자격이 있다)
      check(valid.length > 0, `유효 근거 0: "${entry.term}" — 회수 가능한 로그 질문이 없다`);
      // 그중 최소 1건은 **실패 종결**이어야 한다. 이미 잘 답하던 질문이면 이 배치의 근거가 아니다.
      check(
        validFails.length > 0,
        `실패 종결 근거 0: "${entry.term}" — 이미 답하던 질문뿐이면 이 배치의 근거가 아니다`,
      );
      // base(배치 이전)에서는 회수되지 않아야 한다 — 안 그러면 이 배치가 원인이 아니다.
      const recoveredBefore = validFails.filter((h) => {
        const exactBefore = matchGlossary(baseGlossary, h.question)?.term ?? null;
        const eojeolBefore = h.question
          .split(/\s+/)
          .some((w) => w.length > 0 && matchGlossary(baseGlossary, w)?.term === entry.term);
        return exactBefore === entry.term || eojeolBefore;
      });
      check(
        recoveredBefore.length === 0,
        `배치 이전에도 회수됨: "${entry.term}" — 이 배치의 근거가 아니다 (${recoveredBefore.length}건)`,
      );
    }

    // fixture 모집단이 절단되지 않았는지 — 1,000행 기본 상한에 걸린 채 비율을 말하지 않는다.
    check(
      logEvidence.total_rows > 1000,
      `근거 모집단이 절단됐다 (${logEvidence.total_rows}) — PostgREST 기본 상한 1000 그대로면 전수가 아니다`,
    );
  }

  // ③ 회수 가능성 + ② 종단 답변
  check(END_TO_END.length === BATCH2_ROWS, `종단 케이스가 신규 전건을 덮는가 ${BATCH2_ROWS} (실제 ${END_TO_END.length})`);
  for (const c of END_TO_END) {
    const counters = { llm: 0, cacheGet: 0, cacheSet: 0 };
    const result = await answerQuestion("terms-batch2-gate", c.question, dictOnlyDeps(glossary, counters));
    const row = rows.find((r) => r.term === c.term);
    check(result.source === "dictionary", `종단: "${c.question}" → dictionary (실제 ${result.source})`);
    check(!!row && result.answer === row.answer, `종단 답변이 사전 행과 일치: "${c.term}"`);
    check(counters.llm === 0, `사전 경로가 LLM 을 소비했다: "${c.question}"`);
  }

  // ④ 톤 SSOT
  for (const r of added) {
    check(isBaseballGeniusToneCompliant(r.answer), `톤 위반(합니다체 아님): ${r.term}`);
  }

  // ⑤ 근거 분류 계약
  for (const r of added) {
    const official = r.source_kind === "official_rule" || r.source_kind === "official_record";
    const ok = official
      ? r.source_url !== null && r.rule_version === "2026"
      : r.source_kind === "editorial_definition" && r.source_url === null && r.rule_version === "not_applicable";
    check(ok, `근거 분류: ${r.term} (${r.source_kind}/${r.source_url ?? "null"}/${r.rule_version})`);
  }
  // 새 출처를 조용히 들이지 않는다 — 1차 배치와 같은 5종 유지.
  const urls = new Set(rows.map((r) => r.source_url).filter((u): u is string => u !== null));
  check(urls.size === 5, `허용 근거 URL 5종 유지 (실제 ${urls.size}: ${JSON.stringify([...urls])})`);

  // ⑦ 정규화 키 충돌 0 — 신규 표면이 기존 항목의 키를 가로채면 기존 답변이 바뀐다.
  //   (적용 상태에서만 의미 있는 축 — 미적용이면 신규 표면 자체가 없다.)
  if (applyBatch2) {
    const baseIndex = new Map<string, string>();
    for (const r of baseRows) {
      for (const name of [r.term, ...r.aliases]) {
        baseIndex.set(normalizeKey(name), r.term);
        baseIndex.set(normalizeQuestion(name), r.term);
      }
    }
    for (const r of added) {
      for (const name of [r.term, ...r.aliases]) {
        for (const key of [normalizeKey(name), normalizeQuestion(name)]) {
          const owner = baseIndex.get(key);
          check(owner === undefined, `키 충돌: 신규 "${r.term}" 의 표면 "${name}" 이 기존 "${owner}" 를 가로챈다`);
        }
      }
    }
    // 기존 항목의 answer 가 한 글자도 안 바뀌었는가 (alias 보강은 answer 를 건드리지 않는다)
    for (const b of baseRows) {
      const now = rows.find((r) => r.term === b.term);
      check(!!now && now.answer === b.answer, `기존 answer 변경됨: ${b.term}`);
    }
    // alias 보강 — 야수선택 ← fc
    const fc = rows.find((r) => r.term === "야수선택");
    check(!!fc && fc.aliases.includes("fc"), "alias 보강 실패: 야수선택 ← fc");
  }

  // ⑥ 멱등 — 2회 적용이 1회와 같아야 한다.
  if (applyBatch2) {
    const twiceDb = await loadDb(2);
    const twice = await readAll(twiceDb);
    await twiceDb.close();
    const norm = (list: TermRow[]) => JSON.stringify(list.map((r) => [
      r.term, r.answer, r.aliases, r.category, r.source_kind, r.source_url, r.rule_version, String(r.reviewed_at ?? ""),
    ]));
    check(norm(twice) === norm(rows), "멱등 위반 — 2회 적용 결과가 1회와 다르다");
  }

  await db.close();
  return { pass, fail };
}

async function main() {
  if (SELFTEST) {
    const injected = await runChecks(false);
    // 최소 기대: 행 수 1 + 신규 수 1 + 종단 13×3 + 근거 축 13×2 = 67 이상이 무너져야 한다.
    const MIN_RED = 2 + END_TO_END.length * 3 + logEvidence.terms.length * 2;
    if (injected.fail.length < MIN_RED) {
      console.error(`❌ selftest: 배치를 빼도 RED 가 ${injected.fail.length}건뿐 (최소 ${MIN_RED} 기대) — 검출력 없음`);
      process.exit(1);
    }
    const healthy = await runChecks(true);
    if (healthy.fail.length > 0) {
      console.error(`❌ selftest: 정상 상태인데 ${healthy.fail.length}건 RED — 게이트가 항상 실패한다`);
      for (const f of healthy.fail.slice(0, 8)) console.error("   ", f);
      process.exit(1);
    }
    console.log(`✅ selftest: 배치 제거 결함주입 → RED ${injected.fail.length}건 / 정상 → GREEN ${healthy.pass}건. 검출력 확인`);
    return;
  }

  const { pass, fail } = await runChecks(true);
  if (fail.length > 0) {
    console.error(`❌ baseball_terms 2차 로그 확장: PASS=${pass} FAIL=${fail.length}`);
    for (const f of fail) console.error("   ", f);
    process.exit(1);
  }
  console.log(
    `✅ baseball_terms 2차 로그 확장: ${pass} PASS `
      + `(migration 실행 ${ROWS_AFTER_BATCH1}→${FINAL_ROWS} / 종단 ${END_TO_END.length}건 dictionary / `
      + `유효 근거 재판정 / 톤 SSOT / 근거 분류 / 키 충돌 0 / 멱등 2회 / 기존 answer 불변)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
