/**
 * 사전 2차 확장 — fuzzy mapper 선점 실 provider 게이트 (삼순 2026-08-17 2차 NO-GO P0).
 *
 * 왜 별도 게이트인가:
 *   오프라인 게이트(`qa:genius-terms-log-gap2`)는 mapper seam 을 **null 로 고정**해 종단을 본다.
 *   그 null 은 내가 정한 값이 아니라 **여기서 실측한 값**이어야 한다 — 안 그러면 "매퍼가 null 일
 *   것이다"라는 내 가정이 곧 판정이 되는 자기기입이다(삼순 2차 NO-GO P0 의 정확한 지적).
 *
 * 무엇을 증명하는가:
 *   batch2 적용 사전에서 **후보가 새로 생기거나 늘어난 선점 질문 전건**에 대해, 배포되는 그 함수
 *   (`server.ts mapGlossaryDefinition` — 그 프롬프트·요청 빌더·파서)가 실제 Gemini 로 3회 연속
 *   `null` 을 반환하는가. 하나라도 term 을 고르면 그 조회·예측 질문이 사전 정의문으로 선점된다.
 *
 * 후보 추출도 배포 함수(`glossaryCandidatesIn`)를 쓰고, 사전은 migration 을 실제로 실행해 만든다
 * (production 스키마 + seed + batch1 + batch2). 손으로 적은 후보 목록이 아니다.
 *
 * ⚠️ 결정론 가드와의 관계 — 이 게이트가 덮는 범위를 과장하지 않는다:
 *   pipeline 은 구단 언급·로스터 선수·오늘 선발·statNumericGuard 질문을 **결정론으로** 매퍼에서
 *   제외한다. 그 축은 프롬프트와 무관하게 닫혀 있다. 여기서 실측하는 것은 **그 가드 밖에 남는**
 *   질문들이고, 그 축의 방어는 provider 프롬프트라 확률적이다. 그래서 반복 호출로 실측한다.
 *   이 성질은 이 배치가 만든 것이 아니라 기존 사전에도 있던 구조다(오프라인 게이트가 `타율`
 *   같은 기존 항목으로 그 사실을 함께 고정한다).
 *
 * 실행: npm run qa:genius-terms-log-gap2:mapper-live
 *   (네트워크 · GEMINI_API_KEY 필요, prebuild 밖. 키가 없으면 조용한 SKIP 이 아니라 실패한다.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** 배포 env 가 없을 때 로컬 .env.local 에서만 주입한다(시크릿은 출력하지 않는다). */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
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

const ROOT = process.cwd();
loadDotEnv(path.resolve(ROOT, ".env.local"));

/** 같은 질문을 몇 번 반복해 확인하는가 — 1회 null 은 우연일 수 있다. */
const REPEATS = 3;

async function main() {
  assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY 필요 — 이 게이트는 SKIP 하지 않는다");

  // env 주입 후에 로드해야 server.ts 모듈 초기화(GEMINI_URL 등)가 산다.
  const { mapGlossaryDefinition } = await import("../../src/lib/baseball-qa/server");
  const { answerQuestion, glossaryCandidatesIn } = await import("../../src/lib/baseball-qa/pipeline");
  const { PGlite } = await import("@electric-sql/pglite");

  const rd = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const clubSql = rd("supabase/migrations/20260730_baseball_qa.sql");
  const seedSql = rd("supabase/migrations/20260730_baseball_qa_seed.sql");
  const batch1Sql = rd("supabase/migrations/20260816010000_baseball_terms_log_gap_batch.sql");
  const batch2Sql = rd("supabase/migrations/20260817090000_baseball_terms_log_gap_batch2.sql");

  const load = async (applyBatch2: boolean) => {
    const db = new PGlite();
    const createStmt = clubSql.match(/CREATE TABLE[\s\S]*?baseball_terms[\s\S]*?\);/i)?.[0];
    assert.ok(createStmt, "baseball_terms CREATE TABLE 을 찾지 못했다");
    await db.exec(createStmt.replace(/public\./g, ""));
    await db.exec(seedSql.replace(/public\./g, ""));
    await db.exec(batch1Sql.replace(/public\./g, ""));
    if (applyBatch2) await db.exec(batch2Sql.replace(/public\./g, ""));
    const r = await db.query<{ term: string; aliases: string[]; answer: string }>(
      "SELECT term, aliases, answer FROM baseball_terms ORDER BY term",
    );
    await db.close();
    return r.rows;
  };

  const before = await load(false);
  const after = await load(true);

  const fixture = JSON.parse(
    rd("scripts/qa/fixtures/baseball-terms-log-evidence-20260817.json"),
  ) as {
    preemption: Array<{ question: string; reason: string; relatedTerm: string }>;
    mapper_live: { delta_questions: string[]; live_checked: number; live_skipped: number };
  };

  // 배치 이전에 없던 term 집합 — 신규 행이 소유자가 되면 안 된다는 판정에 쓴다.
  const beforeTerms = new Set(before.map((e) => e.term));
  const addedTerms = new Set(after.map((e) => e.term).filter((t) => !beforeTerms.has(t)));

  /** 사전 경로 + 실제 배포 mapper 를 물린 deps — 오프라인 게이트와 같은 형태, mapper 만 실 provider. */
  const liveDeps = (glossary: typeof after) => ({
    loadGlossary: async () => glossary,
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => ({ text: JSON.stringify({ status: "NOT_BASEBALL" }), inputTokens: 1, outputTokens: 1 }),
    reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    log: async () => {},
    mapGlossaryDefinition,
  });

  const failures: string[] = [];
  let checked = 0;
  let skipped = 0;

  for (const p of fixture.preemption) {
    const candsAfter = glossaryCandidatesIn(after, p.question).map((e) => e.term);
    const candsBefore = glossaryCandidatesIn(before, p.question).map((e) => e.term);

    if (candsAfter.length === 0) {
      // 후보 자체가 없으면 매퍼가 호출되지 않는다 — 이 축의 관심 밖이다.
      skipped += 1;
      console.log(`   ⏭  후보 0 (매퍼 미호출) | ${p.question}`);
      continue;
    }

    const results: Array<string | null> = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const r = await mapGlossaryDefinition(p.question, candsAfter);
      results.push(r.term);
      await new Promise((r2) => setTimeout(r2, 400));
    }
    checked += 1;

    const delta = candsAfter.length !== candsBefore.length ? " (후보 증가)" : "";
    if (results.every((r) => r === null)) {
      console.log(`   ✅ ${REPEATS}/${REPEATS} null  cand=${JSON.stringify(candsAfter)}${delta} | ${p.question}`);
    } else {
      failures.push(
        `[매퍼 선점] "${p.question}" → ${JSON.stringify(results)} (cand=${JSON.stringify(candsAfter)}) — ${p.reason}`,
      );
      console.log(`   ❌ ${JSON.stringify(results)}  cand=${JSON.stringify(candsAfter)}${delta} | ${p.question}`);
    }

    // 🔴 합성 종단 (삼순 3차 NO-GO P0) — component 호출만으로는 "후보 집합 → pipeline guard →
    //   mapper → source/term 소유권" 합성이 증명되지 않는다. 같은 질문을 배포 `answerQuestion`
    //   종단에 실제 mapper 를 물린 채 태워, before/after 소유권이 안 바뀌고 신규 행이
    //   소유자가 되지 않는 것까지 실 provider 로 고정한다.
    const e2eAfter = await answerQuestion("mapper-live-e2e", p.question, liveDeps(after));
    const e2eBefore = await answerQuestion("mapper-live-e2e", p.question, liveDeps(before));
    const termAfter = (e2eAfter as { term?: string }).term ?? null;
    const termBefore = (e2eBefore as { term?: string }).term ?? null;
    if (e2eAfter.source !== e2eBefore.source || termAfter !== termBefore) {
      failures.push(
        `[합성 종단] "${p.question}" 소유권이 배치로 바뀌었다 (${e2eBefore.source}/${termBefore ?? "-"} → ${e2eAfter.source}/${termAfter ?? "-"}) — ${p.reason}`,
      );
    }
    if (termAfter !== null && addedTerms.has(termAfter)) {
      failures.push(`[합성 종단] "${p.question}" 을 신규 행 "${termAfter}" 이 가져갔다 — ${p.reason}`);
    }
  }

  // 🔴 커버리지 결속 — batch2 로 **후보가 새로 생기거나 늘어난** 선점 질문이 전부 실측됐는가.
  //   오프라인 게이트가 같은 delta 집합을 계산해 fixture 와 대조하므로, 새 term 이 추가돼
  //   노출이 늘면 여기서도 자동으로 대상이 늘어난다(둘 중 하나만 고치면 어긋난다).
  const deltaQuestions = fixture.preemption.filter((p) => {
    const a = glossaryCandidatesIn(after, p.question).map((e) => e.term).join("|");
    const b = glossaryCandidatesIn(before, p.question).map((e) => e.term).join("|");
    return a !== b && a.length > 0;
  });
  console.log(`\n   후보 delta 질문 ${deltaQuestions.length}건: ${JSON.stringify(deltaQuestions.map((d) => d.question))}`);
  if (deltaQuestions.length === 0) {
    failures.push("후보 delta 질문이 0건 — batch2 가 매퍼 노출을 전혀 안 바꿨을 리 없다. fixture 가 낡았다");
  }
  // 🔴 커버리지 exact 결속 (삼순 3차 NO-GO P1) — `length === 0` 만으로는 위험 질문 10건이
  //   fixture 에서 빠져도 1건만 남으면 GREEN 이다. 계산된 delta 집합·checked·skipped 를 fixture
  //   선언값에 원소 단위로 묶는다(오프라인 게이트도 같은 선언을 대조 — 한쪽만 고치면 어긋난다).
  {
    const computed = [...deltaQuestions.map((d) => d.question)].sort();
    const declared = [...fixture.mapper_live.delta_questions].sort();
    if (JSON.stringify(computed) !== JSON.stringify(declared)) {
      failures.push(
        `delta 집합이 fixture 선언과 다르다 — 실측 ${computed.length}건 ${JSON.stringify(computed)} ≠ 선언 ${declared.length}건 ${JSON.stringify(declared)}`,
      );
    }
    if (checked !== fixture.mapper_live.live_checked) {
      failures.push(`live checked ${checked}건 ≠ 선언 ${fixture.mapper_live.live_checked}건 — 실측 범위가 계약과 어긋난다`);
    }
    if (skipped !== fixture.mapper_live.live_skipped) {
      failures.push(`live skipped ${skipped}건 ≠ 선언 ${fixture.mapper_live.live_skipped}건 — 매퍼 미호출 분방가 계약과 어긋난다`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ mapper live: ${failures.length}건 선점`);
    for (const f of failures) console.error("   ", f);
    process.exit(1);
  }
  console.log(
    `\n✅ mapper live: 선점 질문 ${checked}건 × ${REPEATS}회 전부 null `
      + `(후보 0 으로 매퍼 미호출 ${skipped}건 / 후보 delta ${deltaQuestions.length}건 포함). `
      + `배포 mapGlossaryDefinition 실호출 실측.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
