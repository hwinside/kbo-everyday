/**
 * 검수 사전 1차 로그 기반 확장 게이트 (2026-08-16).
 *
 * 무엇을 증명하는가:
 *  ① migration 을 **실제로 실행**해 사전이 136 → 164 로 늘어나는지 (PGlite, production 스키마)
 *  ② 늘어난 항목이 `matchGlossary` 로 **실제로 조회되는지** — 운영 로그 원문 질문을 그대로 넣는다
 *  ③ 답변 톤이 합니다체 SSOT 를 지키는지 (`isBaseballGeniusToneCompliant`)
 *  ④ 근거 분류 계약(official ↔ source_url ↔ rule_version) 이 기존 132항목과 같은지
 *  ⑤ 멱등 — 두 번 실행해도 행 수·내용이 변하지 않는지
 *  ⑥ alias 보강 UPDATE 가 기존 `answer` 를 **한 글자도 바꾸지 않는지** (톤 migration CAS 보호)
 *
 * ⚠️ 이 게이트는 사전 **행 데이터**를 검증한다. 룰(코드) 추가가 아니므로 파서·정규식이 늘지 않는다.
 *
 * `--selftest` 는 기대를 반전시켜 검출력을 증명한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { glossaryCandidatesIn, matchGlossary, type GlossaryEntry } from "../../src/lib/baseball-qa/pipeline";
import { isBaseballGeniusToneCompliant } from "../../src/lib/baseball-qa/tone";

const ROOT = process.cwd();
const SELFTEST = process.argv.includes("--selftest");

const seedSql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260730_baseball_qa_seed.sql"), "utf8");
const clubSql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260730_baseball_qa.sql"), "utf8");
const batchSql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260816010000_baseball_terms_log_gap_batch.sql"),
  "utf8",
);

const SEED_ROWS = 132;
const BATCH_ROWS = 28;

/**
 * 운영 로그 원문 → 기대 term.
 *
 * ⚠️ 지어낸 문자열이 아니라 `genius_question_logs` 72시간 전수조사에서 **그대로 복사한** 질문이다
 *   (2026-08-09 `#1137` 에서 fixture 를 지어내 "실측"이라 보고한 사고의 재발 방지).
 * 이 질문들은 전부 `unsure`/`blocked`/`stat_clarify` 로 종결돼 유저가 답을 못 받았다.
 *
 * ⚠️ 두 축으로 나눈 이유 — 사전은 **서빙 경로가 둘**이다.
 *   `EXACT` : ① `matchGlossary` 정규화 exact 매칭. LLM 0콜로 즉시 `dictionary`.
 *   `MAPPER`: ①-b `glossaryCandidatesIn` 이 후보를 만들고 LLM 매퍼가 그 중 하나를 고른다
 *             (`mapGlossaryDefinition`, fail-close: 후보 밖 문자열은 서빙 안 됨).
 *   `잔루가 뭐얌`·`와인드업이 뭐냐고` 같은 표현은 정규화 어미 목록에 없어 exact 는 미스지만,
 *   **후보 집합에는 정답이 들어가므로** 매퍼가 해결한다. 여기서 어미(`뭐얌`·`뭐냐고`·`뜻`)를
 *   목록에 추가하는 것은 반례마다 어휘가 쌓이는 축이라(`open_language_never_closes_with_rules`)
 *   하지 않는다 — 열린 표현 판정은 이미 매퍼(LLM)에 위임돼 있고, 이 배치가 하는 일은
 *   **그 매퍼가 고를 수 있는 후보를 존재하게 만드는 것**이다.
 *
 * 두 축 모두 "이 배치 이전에는 후보조차 없었다"를 함께 검증한다 — 그래야 통과가 의미를 갖는다.
 */
const EXACT_CASES: Array<{ question: string; term: string }> = [
  { question: "내야수가 뭐야", term: "내야수" },
  { question: "1루수", term: "1루수" },
  { question: "2루수는", term: "2루수" },
  { question: "타수가 뭐야", term: "타수" },
  { question: "타수가 뭐야??", term: "타수" },
  { question: "타석", term: "타석" },
  { question: "잔루", term: "잔루" },
  { question: "잔루만루가 뭐야", term: "잔루" },
  { question: "실점이 뭐야", term: "실점" },
  { question: "피안타", term: "피안타" },
  { question: "사사구", term: "사사구" },
  { question: "바빕이 뭐야", term: "BABIP" },
  { question: "만루", term: "만루" },
  { question: "백투백", term: "백투백" },
  { question: "루킹삼진", term: "루킹삼진" },
  { question: "그라운드 홈런은?", term: "그라운드홈런" },
  { question: "와인드업", term: "와인드업" },
  { question: "와인드업이 뭐야", term: "와인드업" },
  { question: "3피트룰", term: "3피트룰" },
  { question: "영구결번", term: "영구결번" },
  { question: "상무", term: "상무" },
  { question: "커리어하이가 뭐야", term: "커리어하이" },
  { question: "RHEB 가 뭐야", term: "전광판" },
  { question: "전광판 보는법 알려줘", term: "전광판" },
  // alias 보강분 — 기존 항목이지만 로그의 표기로는 exact 미스였다.
  { question: "라인드라이브 아웃이 뭐야?", term: "직선타" },
  { question: "파울팁삼진이 뭐야?", term: "파울팁" },
  { question: "볼펜", term: "불펜" },
];

/**
 * exact 는 미스하지만 ①-b 매퍼가 고를 수 있어야 하는 질문.
 * `maxCandidates` 는 `glossaryCandidatesIn` 의 상한(5 초과면 빈 배열)을 넘지 않는지도 함께 본다.
 */
const MAPPER_CASES: Array<{ question: string; term: string }> = [
  { question: "잔루가 뭐얌", term: "잔루" },
  { question: "사사구 뜻", term: "사사구" },
  { question: "와인드업이 뭐냐고", term: "와인드업" },
  { question: "1루타랑 안타랑 같은 뜻이야?", term: "1루타" },
];

type TermRow = {
  term: string;
  aliases: string[];
  answer: string;
  category: string;
  source_kind: string;
  source_url: string | null;
  rule_version: string;
};

async function loadDb(applyBatchTimes: number): Promise<PGlite> {
  const db = new PGlite();
  // production DDL 에서 baseball_terms 정의만 태운다 (RLS·다른 테이블은 이 게이트의 관심 밖).
  const createStmt = clubSql.match(/CREATE TABLE[\s\S]*?baseball_terms[\s\S]*?\);/i)?.[0];
  assert.ok(createStmt, "production DDL 에서 baseball_terms CREATE TABLE 을 찾지 못했다 — fail-close");
  await db.exec(createStmt.replace(/public\./g, ""));
  await db.exec(seedSql.replace(/public\./g, ""));
  for (let i = 0; i < applyBatchTimes; i += 1) await db.exec(batchSql.replace(/public\./g, ""));
  return db;
}

async function readAll(db: PGlite): Promise<TermRow[]> {
  const r = await db.query<TermRow>(
    "SELECT term, aliases, answer, category, source_kind, source_url, rule_version FROM baseball_terms ORDER BY term",
  );
  return r.rows;
}

function toGlossary(rows: TermRow[]): GlossaryEntry[] {
  return rows.map((r) => ({ term: r.term, aliases: r.aliases ?? [], answer: r.answer }));
}

type CheckResult = { pass: number; fail: string[] };

/**
 * 전 검증축을 한 번 실행한다.
 *
 * `applyBatch=false` 는 **결함 주입**이다 — 이 배치 migration 을 아예 적용하지 않은 상태.
 * 그 상태에서 게이트가 RED 로 떨어지지 않으면, 이 게이트는 배치가 있든 없든 통과하는
 * 무의미한 게이트다(`--selftest` 가 그것을 증명한다).
 */
async function runChecks(applyBatch: boolean): Promise<CheckResult> {
  let pass = 0;
  const fail: string[] = [];
  const check = (ok: boolean, label: string) => {
    if (ok) pass += 1;
    else fail.push(label);
  };

  const db = await loadDb(applyBatch ? 1 : 0);
  const rows = await readAll(db);

  // base(배치 미적용) 사전 — "이 배치 이전에는 못 걸렸음" 대조용.
  const seedDbForBase = await loadDb(0);
  const baseRows = await readAll(seedDbForBase);
  await seedDbForBase.close();
  const baseGlossary = toGlossary(baseRows);
  const glossary = toGlossary(rows);

  // ① migration 실행 → 행 수
  check(rows.length === SEED_ROWS + BATCH_ROWS, `행 수 ${SEED_ROWS}+${BATCH_ROWS} (실제 ${rows.length})`);

  // ② 운영 로그 원문이 실제로 사전에 걸리는가 — 종단 매칭 함수를 직접 태운다.
  for (const c of EXACT_CASES) {
    const hit = matchGlossary(glossary, c.question);
    check(hit?.term === c.term, `EXACT 매칭 "${c.question}" → ${c.term} (실제 ${hit?.term ?? "MISS"})`);
    const baseHit = matchGlossary(baseGlossary, c.question);
    check(baseHit?.term !== c.term, `EXACT base 미해결 "${c.question}" (base 가 이미 ${baseHit?.term ?? "MISS"})`);
  }

  for (const c of MAPPER_CASES) {
    const cands = glossaryCandidatesIn(glossary, c.question);
    check(
      cands.some((e) => e.term === c.term),
      `MAPPER 후보 "${c.question}" ∋ ${c.term} (실제 ${JSON.stringify(cands.map((e) => e.term))})`,
    );
    // 후보가 0이면 매퍼가 아예 안 돌고, 5 초과면 `glossaryCandidatesIn` 이 빈 배열을 준다.
    check(cands.length > 0 && cands.length <= 5, `MAPPER 후보 수 1~5 "${c.question}" (실제 ${cands.length})`);
    const baseCands = glossaryCandidatesIn(baseGlossary, c.question);
    check(
      !baseCands.some((e) => e.term === c.term),
      `MAPPER base 후보 부재 "${c.question}" (base ${JSON.stringify(baseCands.map((e) => e.term))})`,
    );
  }

  // ③ 톤 — 신규 항목 전부 합니다체
  const seedTerms = new Set<string>(baseRows.map((r) => r.term));
  const added = rows.filter((r) => !seedTerms.has(r.term));
  check(added.length === BATCH_ROWS, `신규 항목 ${BATCH_ROWS}건 (실제 ${added.length})`);
  for (const r of added) {
    check(isBaseballGeniusToneCompliant(r.answer), `톤 합니다체: ${r.term}`);
  }

  // ④ 근거 분류 계약 — official 이면 URL+2026, editorial 이면 URL 없음+not_applicable
  for (const r of added) {
    const official = r.source_kind === "official_rule" || r.source_kind === "official_record";
    const ok = official
      ? r.source_url !== null && r.rule_version === "2026"
      : r.source_kind === "editorial_definition" && r.source_url === null && r.rule_version === "not_applicable";
    check(ok, `근거 분류: ${r.term} (${r.source_kind}/${r.source_url ?? "null"}/${r.rule_version})`);
  }
  // 근거 URL 집합이 기존 허용 5종을 넘지 않는지 — 새 출처를 조용히 들이지 않는다
  const urls = new Set(rows.map((r) => r.source_url).filter((u): u is string => u !== null));
  check(urls.size === 5, `허용 근거 URL 5종 유지 (실제 ${urls.size})`);

  // ⑤ 멱등 — 두 번 실행해도 동일
  const twice = await loadDb(applyBatch ? 2 : 0);
  const rowsTwice = await readAll(twice);
  check(JSON.stringify(rowsTwice) === JSON.stringify(rows), "멱등 — 2회 실행 결과가 1회와 완전 동일");
  await twice.close();

  // ⑥ alias 보강이 기존 answer 를 바꾸지 않는가 (2026-08-14 톤 migration CAS 보호)
  const before = new Map(baseRows.map((r) => [r.term, r.answer]));
  for (const r of rows) {
    if (!before.has(r.term)) continue;
    check(before.get(r.term) === r.answer, `기존 answer 불변: ${r.term}`);
  }
  const bullpen = rows.find((r) => r.term === "불펜");
  check(bullpen?.aliases.includes("볼펜") === true, "alias 보강: 불펜 ← 볼펜");
  const liner = rows.find((r) => r.term === "직선타");
  check(liner?.aliases.includes("라인드라이브아웃") === true, "alias 보강: 직선타 ← 라인드라이브아웃");

  await db.close();
  return { pass, fail };
}

async function main() {
  if (SELFTEST) {
    // 결함 주입: 배치 migration 을 적용하지 않는다. 게이트가 RED 가 되어야 검출력이 있다.
    const injected = await runChecks(false);
    // 최소 기대: 행 수 + 신규 항목 수 + EXACT 27건 + MAPPER 후보 4건 + 톤/근거/alias 축이 무너진다.
    const MIN_RED = EXACT_CASES.length + MAPPER_CASES.length;
    if (injected.fail.length < MIN_RED) {
      console.error(
        `❌ selftest: 배치를 빼도 RED 가 ${injected.fail.length}건뿐 (최소 ${MIN_RED} 기대) — 게이트 검출력 없음`,
      );
      process.exit(1);
    }
    // 그리고 정상 상태에서는 GREEN 이어야 한다 — 항상 RED 인 게이트도 무의미하다.
    const healthy = await runChecks(true);
    if (healthy.fail.length > 0) {
      console.error(`❌ selftest: 정상 상태인데 ${healthy.fail.length}건 RED — 게이트가 항상 실패한다`);
      for (const f of healthy.fail.slice(0, 5)) console.error("   ", f);
      process.exit(1);
    }
    console.log(
      `✅ selftest: 배치 제거 결함주입 → RED ${injected.fail.length}건 / 정상 → GREEN ${healthy.pass}건. 검출력 확인`,
    );
    return;
  }

  const { pass, fail } = await runChecks(true);
  if (fail.length > 0) {
    console.error(`❌ baseball_terms 로그 확장 배치: PASS=${pass} FAIL=${fail.length}`);
    for (const f of fail) console.error("   ", f);
    process.exit(1);
  }
  console.log(
    `✅ baseball_terms 로그 확장 배치: ${pass} PASS ` +
      `(migration 실행 ${SEED_ROWS}→${SEED_ROWS + BATCH_ROWS} / 운영 로그 원문 exact ${EXACT_CASES.length} + ` +
      `mapper ${MAPPER_CASES.length}건(base 미해결 대조) / 톤 SSOT / 근거 분류 / 멱등 2회 / 기존 answer 불변)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
