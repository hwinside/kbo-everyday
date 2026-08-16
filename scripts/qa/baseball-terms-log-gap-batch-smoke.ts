/**
 * 검수 사전 1차 로그 기반 확장 게이트 (2026-08-16).
 *
 * 무엇을 증명하는가:
 *  ① migration 을 **실제로 실행**해 행 수가 계약대로 늘어나는지 (PGlite, production 스키마)
 *  ② 늘어난 항목이 `answerQuestion` **종단**에서 실제 답변으로 나오는지 — 운영 로그 원문 그대로
 *  ③ 답변 톤이 합니다체 SSOT 를 지키는지 (`isBaseballGeniusToneCompliant`)
 *  ④ 근거 분류 계약(official ↔ source_url ↔ rule_version) 이 기존 항목과 같은지
 *  ⑤ 멱등 — 두 번 실행해도 행 수·내용이 변하지 않는지
 *  ⑥ alias 보강 UPDATE 가 기존 `answer` 를 **한 글자도 바꾸지 않는지** (톤 migration CAS 보호)
 *  ⑦ 정규화 키 충돌 0 — 신규 term/alias 가 기존 항목의 키를 **가로채지 않는지**
 *  ⑧ Production inventory(136행) → 적용 후 postcondition 결속
 *  ⑨ 신규 28항목 **전부** 운영 로그 근거를 갖는지 (근거 없는 행 = 0)
 *
 * 🔴 2026-08-16 삼순 NO-GO 반영 (exact e0152ac5d):
 *   · 종전 게이트는 `matchGlossary`/`glossaryCandidatesIn` predicate 만 봐서 **종단 답변을
 *     증명하지 않았다**. `answerQuestion` 으로 source/term/answer 를 결속한다.
 *   · 수치가 136(production)/132(게이트)/164(파일 설명) 로 갈려 있었다. 근본 원인은
 *     **production 4행이 repo migration 어디에도 INSERT 가 없다**는 것이었다(아래 ⓐ 참조).
 *     이 배치가 그 4행을 정본화해 재구축본과 production 이 같은 수에 수렴한다.
 *   · 28항목 중 21항목만 실질 케이스였다 → 28/28 전수 근거·전수 종단으로 확대.
 *
 * ⚠️ 이 게이트는 사전 **행 데이터**를 검증한다. 룰(코드) 추가가 아니므로 파서·정규식이 늘지 않는다.
 *
 * `--selftest` 는 기대를 반전시켜 검출력을 증명한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import {
  answerQuestion,
  glossaryCandidatesIn,
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
const batchSql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260816010000_baseball_terms_log_gap_batch.sql"),
  "utf8",
);

/**
 * ⓐ 수치 SSOT — 삼순 NO-GO 의 핵심 지적(136/132/164 3중 불일치)을 여기서 닫는다.
 *
 * 🔴 실측으로 밝혀진 원인: production 136행 중 **4행(`10-10`~`40-40 클럽`)은 repo
 *   migration 어디에도 INSERT 가 없다.** `created_at = 2026-08-11 00:58:28+00` 로
 *   production 에 직접 들어갔고, repo 에는 `20260814121000_..._formal_tone.sql` 의
 *   **UPDATE 대상**으로만 등장한다(그 migration 은 INSERT 를 하지 않는다).
 *   → 신규 환경 재구축본은 132, production 은 136. 이 간극이 수치 혼선의 정체였다.
 *
 * 이 배치가 그 4행을 **production 현재 값 그대로** 정본화(ⓐ 블록)해서 양쪽이 수렴한다.
 *   재구축본: 132(seed) + 4(정본화) + 28(신규) = 164
 *   production: 136 + 0(정본화는 ON CONFLICT no-op) + 28(신규) = 164
 * 두 경로가 **같은 164** 로 만나는 것을 ⑧에서 결속한다.
 */
const SEED_ROWS = 132;
const RECONCILED_ROWS = 4;
const BATCH_ROWS = 28;
const FINAL_ROWS = SEED_ROWS + RECONCILED_ROWS + BATCH_ROWS;
const PRODUCTION_ROWS_BEFORE = 136;

/**
 * 2026-08-16 실측 production **전체 행** (Supabase Management API). 지어낸 값 아님.
 * term/count 만 비교하면 answer·aliases 가 달라도 GREEN 이므로 full-row 로 대조한다(삼순 ①).
 */
const productionClubRows = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-production-club-rows-20260816.json"), "utf8"),
) as {
  captured_at: string;
  rows: Array<{
    term: string; aliases: string[]; answer: string; category: string;
    source_kind: string; source_url: string | null; rule_version: string; reviewed_at: string;
  }>;
};

/** 2026-08-16 실측 production term 목록 (Supabase Management API). 지어낸 값 아님. */
const productionInventory = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-production-inventory-20260816.json"), "utf8"),
) as { captured_at: string; row_count: number; terms: string[] };

/**
 * 신규 28항목 **전부**의 운영 로그 근거 — fixture 원문에서 읽는다.
 *
 * 🔴 삼순 2차 NO-GO ③ 반영: 종전에는 hit/실패 **개수만 소스에 자가 기입**해 두고
 *   `hits > 0` 만 확인했다. 숫자를 내가 적었으니 그 검증은 아무 것도 증명하지 않는다.
 *   이제 fixture 에 **질문 원문 + match_path** 를 통째로 담고, 게이트가 그것을 세고
 *   판정한다(문자열 포함 검색은 코드가 재실행한다 — 아래 ⑨).
 */
const logEvidenceFixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-log-evidence-20260816.json"), "utf8"),
) as {
  captured_at: string;
  window_hours: number;
  source: string;
  terms: Array<{
    term: string;
    aliases: string[];
    hits: Array<{ question: string; matchPath: string; matchedKey: string }>;
  }>;
};

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

/**
 * ⓑ 신규 28항목 **전건** 종단 케이스 — fixture 에서 읽는다 (자가 기입 금지).
 *
 * 🔴 삼순 2차 NO-GO(exact 080a146d) 반영:
 *   · ② mapper stub 이 무조건 첫 후보를 골라 **다중 용어 질문**에 한 term 정의만 답한 것을
 *     성공으로 고정했었다(`…1,2,3루수 말고 또 무슨 포지션?` → 3루수 하나,
 *     `피안타·피OPS·탈삼진이 뭐야?` → 피OPS 하나). 둘 다 질문 전체에는 오답이다.
 *     → 케이스 선정을 **단일 용어·정의형 우선**으로 기계 재추출하고, 그래도 남는
 *       다중 용어 질문은 `multi_term` 으로 분리해 **사전 단독 회수 금지**를 고정한다.
 *   · ③ `unresolved` 를 source·answer·log·LLM 없이 통과시켰고 `loggedPath` 는 코드에서
 *     한 번도 읽지 않았다. → 분류별 종단 축을 전부 검증하고, `loggedPath` 는
 *     **"배치 이전 실패 종결"의 근거**로 실제로 쓴다.
 *
 * fixture(`baseball-terms-log-cases-20260816.json`)는 `genius_question_logs` 120시간에서
 * term/alias 포함 질문을 기계 추출한 것이다. 선정 규칙(코드로 실행됨):
 *   ① 다른 28 term 이 섞이지 않고 비교·열거 표지가 없는 **단일 용어** 질문 우선
 *   ② 그중 정의형 어미(`뭐야`·`뜻`·`~는?`·단문) 우선
 *   ③ 그중 실패 종결(unsure/blocked/stat_clarify) 우선, 마지막으로 최단
 * 지어낸 문장 0개.
 */
const logCasesFixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-log-cases-20260816.json"), "utf8"),
) as {
  captured_at: string;
  source: string;
  cases: Array<{
    term: string;
    question: string;
    /** 배치 이전 이 질문이 실제로 어떻게 종결됐는지 (운영 로그 실측) */
    loggedPath: string;
    /** 다른 28 term 이 섞이지 않았는가 */
    single: boolean;
    /** 정의형 어미인가 */
    defform: boolean;
    otherTerms: number;
    compare: boolean;
    /**
     * 배치 적용 후 종단 기대.
     *   `exact`       매퍼 없이 사전 exact 회수
     *   `mapper`      exact 미스 → ①-b 후보 진입 → 매퍼 회수
     *   `multi_term`  여러 용어를 한꺼번에 묻는다 — **사전 단독 정의문은 오답**
     *   `guard_owned` `statNumericGuard` 소유(룰 판정) — 사전 행과 무관한 축
     */
    expect: "exact" | "mapper" | "multi_term" | "guard_owned";
  }>;
};
const END_TO_END_CASES = logCasesFixture.cases;

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

  // ① migration 실행 → 행 수 (재구축 경로: seed 132 + 정본화 4 + 신규 28 = 164)
  check(
    rows.length === (applyBatch ? FINAL_ROWS : SEED_ROWS),
    `행 수 ${applyBatch ? FINAL_ROWS : SEED_ROWS} (실제 ${rows.length})`,
  );

  // ⑧ Production inventory → 적용 후 postcondition 결속 (삼순 NO-GO ③)
  //    production 은 136행에서 시작한다. 이 배치의 ⓐ 4행은 이미 있으므로 no-op,
  //    신규 28행만 들어가 **재구축본과 같은 164** 에 수렴한다. 두 경로가 만나는지 확인한다.
  {
    check(
      productionInventory.row_count === PRODUCTION_ROWS_BEFORE &&
        productionInventory.terms.length === PRODUCTION_ROWS_BEFORE,
      `production inventory ${PRODUCTION_ROWS_BEFORE}행 (실제 ${productionInventory.row_count}/${productionInventory.terms.length})`,
    );
    const prodTerms = new Set(productionInventory.terms);
    const seedTermSet = new Set(baseRows.map((r) => r.term));
    // production 에만 있고 seed 에 없는 행 = 정본화 대상. 정확히 RECONCILED_ROWS 개여야 한다.
    const prodOnly = productionInventory.terms.filter((t) => !seedTermSet.has(t));
    check(
      prodOnly.length === RECONCILED_ROWS,
      `production-only 행 ${RECONCILED_ROWS}건 (실제 ${prodOnly.length}: ${JSON.stringify(prodOnly)})`,
    );
    if (applyBatch) {
      // 정본화 블록이 그 4행을 **전부** 포함하는가 — 하나라도 빠지면 간극이 남는다.
      const afterTerms = new Set(rows.map((r) => r.term));
      for (const t of prodOnly) check(afterTerms.has(t), `정본화 누락: production-only 행 "${t}" 가 배치에 없다`);
      // production 적용 후 예상 행 수 = 136 + (배치 신규 중 production 에 없던 것)
      const addedToProd = rows.filter((r) => !prodTerms.has(r.term)).length;
      check(
        PRODUCTION_ROWS_BEFORE + addedToProd === FINAL_ROWS,
        `production postcondition ${PRODUCTION_ROWS_BEFORE}+${addedToProd}=${FINAL_ROWS} (실제 ${PRODUCTION_ROWS_BEFORE + addedToProd})`,
      );
    }
  }

  // ⑨ 신규 28항목 전부 운영 로그 근거 보유 — 근거 없는 행 0
  //
  //   🔴 삼순 2차 NO-GO ③: 종전에는 hit 개수를 **소스에 자가 기입**해 두고 `hits > 0` 만 봤다.
  //     숫자를 내가 적었으니 그 검증은 아무 것도 증명하지 않는다.
  //     이제 fixture 에 담긴 **질문 원문**을 게이트가 직접 재검증한다:
  //       · 그 질문이 정말 이 term/alias 를 포함하는가 (문자열 포함을 코드가 다시 계산)
  //       · fixture 가 기록한 `matchedKey` 가 실제 DB 행의 term/alias 안에 있는가
  //     즉 근거는 "내가 적은 숫자"가 아니라 "원문 + 실제 사전 행"의 관계로 성립한다.
  if (applyBatch) {
    const seedTermSet = new Set(baseRows.map((r) => r.term));
    const prodTerms = new Set(productionInventory.terms);
    const newRows = rows.filter((r) => !seedTermSet.has(r.term) && !prodTerms.has(r.term));
    check(newRows.length === BATCH_ROWS, `신규(정본화 제외) ${BATCH_ROWS}건 (실제 ${newRows.length})`);

    const evidenceByTerm = new Map(logEvidenceFixture.terms.map((t) => [t.term, t]));
    const squash = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    for (const r of newRows) {
      const ev = evidenceByTerm.get(r.term);
      check(ev !== undefined, `운영 로그 근거 fixture 존재: ${r.term}`);
      if (!ev) continue;
      check(ev.hits.length > 0, `운영 로그 근거 1건 이상: ${r.term} (실제 ${ev.hits.length})`);

      // fixture 의 alias 목록이 **실제 DB 행과 일치**하는가 — 낡은 fixture 차단.
      check(
        JSON.stringify(ev.aliases) === JSON.stringify(r.aliases ?? []),
        `근거 fixture alias 가 DB 행과 다르다: ${r.term} (fixture ${JSON.stringify(ev.aliases)} / DB ${JSON.stringify(r.aliases)})`,
      );

      // 각 hit 이 정말 이 term/alias 를 포함하는가 — 포함 판정을 **코드가 다시 실행**한다.
      const keys = [r.term, ...(r.aliases ?? [])].map(squash);
      for (const hit of ev.hits) {
        const q = squash(hit.question);
        check(
          keys.some((k) => k.length > 0 && q.includes(k)),
          `근거 불성립: "${hit.question}" 에 ${r.term} 의 term/alias 가 없다`,
        );
        check(
          keys.includes(squash(hit.matchedKey)),
          `근거 matchedKey 불일치: ${r.term} ← "${hit.matchedKey}" (현재 alias 밖)`,
        );
      }
    }
    check(
      logEvidenceFixture.terms.length === BATCH_ROWS,
      `근거 fixture 가 신규 전건을 덮는가 ${BATCH_ROWS} (실제 ${logEvidenceFixture.terms.length})`,
    );

    // 종단 케이스의 질문도 근거 fixture 안에 실재해야 한다 — 두 fixture 가 갈라지면 안 된다.
    for (const c of END_TO_END_CASES) {
      const ev = evidenceByTerm.get(c.term);
      check(
        ev !== undefined && ev.hits.some((h) => h.question === c.question && h.matchPath === c.loggedPath),
        `종단 케이스가 근거 로그에 없다: ${c.term} "${c.question}" (${c.loggedPath})`,
      );
    }
  }

  // ② 종단 결속 — `answerQuestion` 으로 28항목 전건 (삼순 NO-GO ①)
  //
  //   🔴 predicate(`matchGlossary`) 만 보면 "후보가 있다"까지만 증명된다. 유저가 실제로 받는
  //     것은 종단 답변이므로 `answerQuestion` 의 source/term/answer 를 직접 고정한다.
  //   매퍼 2형상을 모두 태운다 — production 매퍼는 후보 폐쇄집합 안에서만 고르므로
  //   "없음"은 최소 회수, "첫 후보 선택"은 최대 회수 상태다.
  if (applyBatch) {
    const answerFor = async (question: string, withMapper: boolean) => {
      let llmCalls = 0;
      let mapperCalls = 0;
      const logs: string[] = [];
      const deps = {
        loadGlossary: async () => glossary,
        loadPlayers: async () => [],
        getCache: async () => null,
        setCache: async () => {},
        callLlm: async () => {
          llmCalls += 1;
          // validator(`answerInQuestionScope`) 를 통과하는 문장을 준다 — 통과 못 하는 문장을 쓰면
          // "unsure 로 끝났다"가 코드 탓인지 stub 탓인지 구분되지 않는다.
          return {
            text: JSON.stringify({
              status: "ANSWER",
              answer: "감독이 퇴장되면 남은 이닝은 코치가 지휘하며 다음 경기 출장은 제한되지 않습니다.",
            }),
            inputTokens: 1,
            outputTokens: 1,
          };
        },
        reserveDaily: async () => ({ allowed: true, remaining: 9 }),
        log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
        ...(withMapper
          ? {
              // 🔴 삼순 2차 NO-GO ②: 종전 stub 은 **무조건 첫 후보**를 골라, 다중 용어 질문에
              //   한 term 정의만 답한 것을 성공으로 고정했다. production 매퍼의 계약은
              //   "그 용어 자체의 뜻을 묻는 것일 때만 고르고, 아니면 null" 이다.
              //   여기서는 그 계약을 재현한다 — 후보가 **정확히 1개**일 때만 고른다.
              //   후보가 여럿이면 어느 것을 골라도 질문 전체에는 답이 되지 않으므로 null 이다.
              mapGlossaryDefinition: async (_q: string, candidates: string[]) => {
                mapperCalls += 1;
                return {
                  term: candidates.length === 1 ? candidates[0] : null,
                  inputTokens: 1,
                  outputTokens: 1,
                };
              },
            }
          : {}),
      } as QaDeps;
      const res = await answerQuestion("u-terms-batch", question, deps);
      return {
        source: res.source,
        term: (res as { term?: string }).term ?? null,
        answer: res.answer ?? "",
        llmCalls,
        mapperCalls,
        logs,
      };
    };

    check(END_TO_END_CASES.length === BATCH_ROWS, `종단 케이스가 신규 전건을 덮는가 ${BATCH_ROWS} (실제 ${END_TO_END_CASES.length})`);

    for (const c of END_TO_END_CASES) {
      const plain = await answerFor(c.question, false);
      const mapped = await answerFor(c.question, true);
      const row = rows.find((r) => r.term === c.term);

      // 케이스 선정 규칙이 실제로 지켜졌는가 — fixture 를 코드가 **읽고 판정한다**.
      //   `single`/`defform` 은 선정기가 기록한 값이고, 이 값이 분류와 어긋나면 fixture 가
      //   낡은 것이다(삼순 ③: "loggedPath 도 코드에서 한 번도 읽지 않는다").
      if (c.expect === "exact" || c.expect === "mapper") {
        check(c.single === true, `[선정] "${c.question}" 는 단일 용어 질문이어야 한다 (otherTerms=${c.otherTerms}, compare=${c.compare})`);
      }
      if (c.expect === "multi_term") {
        check(
          c.single === false,
          `[선정] "${c.question}" 를 multi_term 으로 분류했는데 선정기는 단일 용어라고 판정했다`,
        );
      }

      // `loggedPath` 를 **실제로 쓴다** — 배치 이전 이 질문이 실패로 끝났다는 근거다.
      //   `llm` 은 답이 나가긴 했으나 사전 정의문이 아니었다는 뜻이므로 사전 회수 대상이다.
      check(
        ["unsure", "blocked", "stat_clarify", "service_redirect", "llm"].includes(c.loggedPath),
        `[선정] "${c.question}" loggedPath=${c.loggedPath} — 알 수 없는 종결 경로`,
      );

      if (c.expect === "exact") {
        // 매퍼 없이도 사전이 답한다 — LLM 0콜.
        check(plain.source === "dictionary", `[exact] "${c.question}" source=dictionary (실제 ${plain.source})`);
        check(plain.term === c.term, `[exact] "${c.question}" term=${c.term} (실제 ${plain.term ?? "-"})`);
        check(plain.llmCalls === 0, `[exact] "${c.question}" LLM 0콜 (실제 ${plain.llmCalls})`);
        check(plain.answer === row?.answer, `[exact] "${c.question}" 답변 본문이 사전 행과 exact 일치`);
        check(plain.logs.length === 1 && plain.logs[0] === "dictionary", `[exact] "${c.question}" log=${JSON.stringify(plain.logs)}`);
        // 매퍼가 붙어도 결과가 흔들리지 않는다.
        check(mapped.term === c.term, `[exact] "${c.question}" 매퍼 동반 시에도 term 불변 (실제 ${mapped.term ?? "-"})`);
      } else if (c.expect === "mapper") {
        // exact 는 미스여야 한다 — 미스가 아니면 이 분류 자체가 틀린 것이다(게이트 기대 오류).
        check(plain.term !== c.term, `[mapper] "${c.question}" 는 exact 미스여야 한다 (실제 ${plain.term ?? "-"})`);
        check(mapped.source === "dictionary", `[mapper] "${c.question}" source=dictionary (실제 ${mapped.source})`);
        check(mapped.term === c.term, `[mapper] "${c.question}" term=${c.term} (실제 ${mapped.term ?? "-"})`);
        check(mapped.mapperCalls >= 1, `[mapper] "${c.question}" ①-b 매퍼 호출됨 (실제 ${mapped.mapperCalls})`);
        check(mapped.llmCalls === 0, `[mapper] "${c.question}" 사전 회수인데 generic LLM 을 태웠다 (${mapped.llmCalls})`);
        check(mapped.answer === row?.answer, `[mapper] "${c.question}" 답변 본문이 사전 행과 exact 일치`);
        check(mapped.logs.length === 1 && mapped.logs[0] === "dictionary", `[mapper] "${c.question}" log=${JSON.stringify(mapped.logs)}`);
        // 후보가 **정확히 이 term 하나**여야 한다. 여럿이면 다중 용어 질문이므로 분류가 틀린 것이다.
        const cands = glossaryCandidatesIn(glossary, c.question).map((e) => e.term);
        check(
          cands.length === 1 && cands[0] === c.term,
          `[mapper] "${c.question}" 후보가 단일이어야 한다 (실제 ${JSON.stringify(cands)}) — 여럿이면 multi_term 이다`,
        );
      } else if (c.expect === "multi_term") {
        // 🔴 삼순 ②: 여러 용어를 한꺼번에 묻는 질문에 **한 term 의 정의문만** 답하면 오답이다.
        //   매퍼 stub 이 무조건 첫 후보를 고르던 종전 게이트는 이 오답을 성공으로 고정했다.
        //   여기서는 **사전 단독 회수를 금지**하고, 후보가 실제로 여럿임을 근거로 못 박는다.
        const cands = glossaryCandidatesIn(glossary, c.question).map((e) => e.term);
        check(
          cands.length >= 2,
          `[multi_term] "${c.question}" 후보가 2개 이상이어야 한다 (실제 ${JSON.stringify(cands)})`,
        );
        check(cands.includes(c.term), `[multi_term] "${c.question}" 후보에 ${c.term} 진입 (실제 ${JSON.stringify(cands)})`);
        // 매퍼가 계약을 지키면(=여러 용어 질문에 null) 사전이 단독으로 답하지 않는다.
        check(
          plain.source !== "dictionary",
          `[multi_term] "${c.question}" 매퍼 없이 사전이 단독 정의문을 냈다 (term=${plain.term ?? "-"}) — 질문 전체에는 오답`,
        );
        check(plain.llmCalls >= 1, `[multi_term] "${c.question}" 야구 답변 경로로 가지 않았다`);
      } else {
        // `guard_owned` — `statNumericGuard` 가 소유하는 룰 판정 질문. 사전 행 유무와 무관하다.
        //   회수되지 않는다는 사실 + **어떤 경로로 닫히는지**까지 고정한다(삼순 ③).
        check(
          plain.term !== c.term && mapped.term !== c.term,
          `[guard_owned] "${c.question}" 는 회수되지 않는다고 선언했는데 회수됐다 — 분류를 갱신하라`,
        );
        check(
          plain.source === c.loggedPath,
          `[guard_owned] "${c.question}" 배치 후에도 종결 경로가 같아야 한다 (로그 ${c.loggedPath} / 실제 ${plain.source})`,
        );
        check(
          plain.logs.length === 1 && plain.logs[0] === c.loggedPath,
          `[guard_owned] "${c.question}" log=${JSON.stringify(plain.logs)} (기대 ${c.loggedPath})`,
        );
        // 사전 행이 없어서가 아니라 **가드가 소유해서** 닫힌다는 근거 — 후보에는 들어간다.
        const cands = glossaryCandidatesIn(glossary, c.question).map((e) => e.term);
        check(cands.includes(c.term), `[guard_owned] "${c.question}" 후보에 ${c.term} 진입 (실제 ${JSON.stringify(cands)})`);
      }

      // base(배치 미적용) 에서는 어떤 형상으로도 이 term 이 나오지 않아야 한다 — 우연 통과 차단.
      const baseCands = glossaryCandidatesIn(baseGlossary, c.question).map((e) => e.term);
      check(!baseCands.includes(c.term), `[base] "${c.question}" 배치 이전엔 후보에 ${c.term} 이 없어야 한다`);
      check(
        matchGlossary(baseGlossary, c.question)?.term !== c.term,
        `[base] "${c.question}" 배치 이전엔 exact 로도 ${c.term} 이 나오면 안 된다`,
      );
    }
  }

  // ⑦ 정규화 키 충돌 0 — 신규 term/alias 가 기존 항목의 키를 가로채지 않는가 (삼순 NO-GO ②)
  //    사전 매칭은 정규화 키 exact 라, 신규 alias 가 기존 키와 같으면 **기존 답이 바뀐다**.
  if (applyBatch) {
    const keyOwner = new Map<string, string>();
    const dup: string[] = [];
    for (const r of rows) {
      for (const raw of [r.term, ...(r.aliases ?? [])]) {
        for (const key of [normalizeKey(raw), normalizeQuestion(raw)]) {
          if (!key) continue;
          const prev = keyOwner.get(key);
          if (prev && prev !== r.term) dup.push(`${key}: ${prev} ↔ ${r.term}`);
          else keyOwner.set(key, r.term);
        }
      }
    }
    check(dup.length === 0, `정규화 키 충돌 0 (실제 ${dup.length}: ${JSON.stringify(dup.slice(0, 6))})`);
  }

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

  // ③ 톤 — 이 배치가 새로 넣는 항목 전부 합니다체
  //    ⓐ 정본화 4행은 production 현재 값 그대로이므로 "이 배치가 만든 행"과 분리해서 센다.
  const seedTerms = new Set<string>(baseRows.map((r) => r.term));
  const prodTermSet = new Set<string>(productionInventory.terms);
  const reconciled = rows.filter((r) => !seedTerms.has(r.term) && prodTermSet.has(r.term));
  const added = rows.filter((r) => !seedTerms.has(r.term) && !prodTermSet.has(r.term));
  if (applyBatch) {
    check(added.length === BATCH_ROWS, `신규 항목 ${BATCH_ROWS}건 (실제 ${added.length})`);
    check(reconciled.length === RECONCILED_ROWS, `정본화 항목 ${RECONCILED_ROWS}건 (실제 ${reconciled.length})`);
  }
  for (const r of [...added, ...reconciled]) {
    check(isBaseballGeniusToneCompliant(r.answer), `톤 합니다체: ${r.term}`);
  }

  // ④-b ⓐ 정본화 4행은 **계약 준수값으로 교정**된다 (삼순 2026-08-16 2차 NO-GO).
  //
  //   🔴 1차 반영에서 나는 "지금 고치면 재구축본과 production 이 갈린다"며 위반값
  //     (`editorial_definition` + `rule_version='2026'`)을 그대로 넣었다. **그 전제가 틀렸다** —
  //     `ON CONFLICT DO NOTHING` 이면 production 은 손대지 않으니 오히려 영구히 갈린 채
  //     고정되고, 알려진 계약 위반을 fresh DB 에 새로 심는 꼴이었다.
  //   migration 을 `DO UPDATE ... WHERE`(CAS)로 바꿔 **양쪽을 동시에** `not_applicable` 로 옮긴다.
  if (applyBatch) {
    for (const r of reconciled) {
      check(
        r.source_kind === "editorial_definition" && r.source_url === null
          && r.rule_version === "not_applicable",
        `정본화 행 계약 준수: ${r.term} (${r.source_kind}/${r.source_url ?? "null"}/${r.rule_version})`,
      );
    }
    // full-row 대조 — term/count 만 보면 answer·aliases 가 달라도 GREEN 이다(삼순 ①).
    //   fixture 는 production 실측 전체 행이다. answer·aliases·category·source_kind·
    //   reviewed_at 이 **한 글자라도** 다르면 재구축본과 production 이 갈린 것이다.
    for (const fixtureRow of productionClubRows.rows) {
      const built = rows.find((r) => r.term === fixtureRow.term);
      check(built !== undefined, `정본화 행 존재: ${fixtureRow.term}`);
      if (!built) continue;
      check(built.answer === fixtureRow.answer, `정본화 answer exact: ${fixtureRow.term}`);
      check(
        JSON.stringify(built.aliases ?? []) === JSON.stringify(fixtureRow.aliases),
        `정본화 aliases exact: ${fixtureRow.term} (${JSON.stringify(built.aliases)})`,
      );
      check(built.category === fixtureRow.category, `정본화 category exact: ${fixtureRow.term}`);
      check(built.source_kind === fixtureRow.source_kind, `정본화 source_kind exact: ${fixtureRow.term}`);
      // rule_version 만 의도적으로 다르다(위반값 → 계약값). 그 사실 자체를 고정한다.
      check(
        fixtureRow.rule_version === "2026" && built.rule_version === "not_applicable",
        `정본화 rule_version 교정: ${fixtureRow.term} (${fixtureRow.rule_version} → ${built.rule_version})`,
      );
    }
  }

  // ④-c CAS 계약 — production 형상(위반값 선존재)에 배치를 적용하면 교정되는가.
  //     재구축본만 보면 "새로 넣을 때 계약값을 썼다"까지만 증명된다. production 은
  //     이미 행이 있으므로 **UPDATE 경로**를 타야 하고, 그 경로가 실제로 도는지는 별개다.
  if (applyBatch) {
    const prodLike = new PGlite();
    const createStmt = clubSql.match(/CREATE TABLE[\s\S]*?baseball_terms[\s\S]*?\);/i)?.[0];
    if (createStmt) {
      await prodLike.exec(createStmt.replace(/public\./g, ""));
      await prodLike.exec(seedSql.replace(/public\./g, ""));
      // production 현재 상태 재현 — 위반값 그대로 선투입.
      for (const r of productionClubRows.rows) {
        await prodLike.query(
          "INSERT INTO baseball_terms(term, aliases, answer, category, source_kind, source_url, rule_version, reviewed_at)"
            + " VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::date)",
          [r.term, r.aliases, r.answer, r.category, r.source_kind, r.rule_version, r.reviewed_at],
        );
      }
      const before = await prodLike.query<TermRow>(
        "SELECT term, aliases, answer, category, source_kind, source_url, rule_version FROM baseball_terms ORDER BY term",
      );
      check(before.rows.length === PRODUCTION_ROWS_BEFORE, `production 형상 재현 ${PRODUCTION_ROWS_BEFORE}행 (실제 ${before.rows.length})`);
      check(
        before.rows.filter((r) => r.rule_version === "2026" && r.source_kind === "editorial_definition").length
          === RECONCILED_ROWS,
        "production 형상에 계약 위반 4행이 있어야 한다 — 없으면 CAS 검증이 무의미",
      );

      await prodLike.exec(batchSql.replace(/public\./g, ""));
      const after = await prodLike.query<TermRow>(
        "SELECT term, aliases, answer, category, source_kind, source_url, rule_version FROM baseball_terms ORDER BY term",
      );
      // ⑧ postcondition: production 경로도 재구축본과 **같은 행 수**에 수렴한다.
      check(after.rows.length === FINAL_ROWS, `production 적용 후 ${FINAL_ROWS}행 (실제 ${after.rows.length})`);
      // 위반값이 실제로 사라졌는가.
      const stillViolating = after.rows.filter(
        (r) => r.source_kind === "editorial_definition" && r.rule_version !== "not_applicable",
      );
      check(stillViolating.length === 0, `CAS 교정 후 계약 위반 0 (실제 ${stillViolating.length}: ${JSON.stringify(stillViolating.map((r) => r.term))})`);
      // answer 는 CAS 가 건드리지 않아야 한다 — 톤 migration 결과 보존.
      for (const r of productionClubRows.rows) {
        const row = after.rows.find((x) => x.term === r.term);
        check(row?.answer === r.answer, `CAS 가 answer 를 바꿨다: ${r.term}`);
      }
      // 재구축본과 production 경로의 **최종 상태가 동일**한가 — 두 경로가 만나는 지점.
      const norm = (list: TermRow[]) => JSON.stringify(list.map((r) => [r.term, r.answer, r.aliases, r.category, r.source_kind, r.source_url, r.rule_version]));
      check(norm(after.rows) === norm(rows), "재구축본과 production 경로의 최종 상태가 다르다 — 여전히 갈린다");

      // 멱등 — production 경로에서도 2회 적용이 1회와 같아야 한다.
      await prodLike.exec(batchSql.replace(/public\./g, ""));
      const twiceProd = await prodLike.query<TermRow>(
        "SELECT term, aliases, answer, category, source_kind, source_url, rule_version FROM baseball_terms ORDER BY term",
      );
      check(norm(twiceProd.rows) === norm(after.rows), "production 경로 멱등 위반 — 2회 적용 결과가 다르다");
    }
    await prodLike.close();
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
      `(migration 실행 ${SEED_ROWS}→${FINAL_ROWS} / 운영 로그 원문 exact ${EXACT_CASES.length} + ` +
      `mapper ${MAPPER_CASES.length}건(base 미해결 대조) / 톤 SSOT / 근거 분류 / 멱등 2회 / 기존 answer 불변)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
