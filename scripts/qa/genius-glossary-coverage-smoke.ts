/**
 * 야잘알봇 검수 사전 확충 회귀 게이트 (2026-08-05).
 *
 * 왜 만들었나
 * ───────────
 * 운영 미답변 로그 1,075건을 라벨링해 보니 TERM(용어 질문) 이 479건으로 가장 컸다.
 * 사전은 토큰을 쓰지 않고 사람이 검수한 답을 그대로 내보내므로, 여기가 뚫려 있으면
 * 유저는 "야구 룰/용어만 답할 수 있어요" 를 받고 돌아간다.
 *
 * 이 게이트가 지키는 계약
 * ───────────────────────
 *  ① 실제 운영 미답변 질문(fixture)에 대한 사전 커버리지가 기준선 아래로 내려가지 않는다.
 *  ② 기존 132종이 확충 때문에 가려지지 않는다(자기 자신으로 계속 매칭돼야 한다).
 *  ③ alias 정규화 키 충돌이 0이다.
 *  ④ 답변은 발송 상한(200자) 안이고, 근거 분류가 스키마 계약을 만족한다.
 *
 * ③이 왜 P0 인가
 * ───────────────
 * `matchGlossary` 는 Map 을 채우며 **먼저 들어온 항목이 이긴다**. 뒤엣것은 예외도 로그도
 * 없이 조용히 가려진다. 실제로 이번 확충에서 신규 `직구` 가 기존 `포심` 의 alias 와,
 * `2b` 가 2루타 vs 2루수로 겹쳐 11건이 가려질 뻔했다. 사람이 눈으로 볼 수 없는 결함이라
 * 게이트가 아니면 못 잡는다.
 *
 * 검증력 확보 방식 (false-green 방지)
 * ────────────────────────────────────
 *  - 사전 데이터를 **손으로 옮겨 적지 않는다.** 실제 seed SQL + 실제 확충 migration 을
 *    PGlite 에 그대로 적용하고 그 결과 테이블을 읽는다. migration 이 깨지면 여기서 죽는다.
 *  - 정규화·매칭을 **재구현하지 않는다.** 배포되는 `normalizeKey`/`normalizeQuestion`/
 *    `matchGlossary` 를 직접 import 해서 실행한다.
 *  - fixture 는 내가 지어낸 문장이 아니라 **운영 로그 원문**이다. 다듬으면 게이트가 약해진다.
 *  - `GLOSSARY_GATE_MUTATION` 으로 결함을 주입해 이 게이트가 실제로 RED 를 내는지 증명한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { normalizeKey, normalizeQuestion } from "../../src/lib/baseball-qa/normalize";
import { matchGlossary, type GlossaryEntry } from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";

/**
 * 커버리지 기준선. 확충 시점 실측이 67.6%(478건 중 323건)였다.
 *
 * 왜 100%가 아닌가: 남은 미매칭은 `모든 야구 용어 알려줘`(복수 개념 요청),
 * `완투와 완봉의 차이는?`(비교 질문), `.367이 뭐야?`(수치 해석), 심한 오타처럼
 * **exact 매칭 사전으로는 원래 답할 수 없는 종류**다. 그건 LLM/RAG 경로의 몫이다.
 * 여기서 100%를 요구하면 사전에 억지 항목을 넣게 되고 오답이 늘어난다.
 *
 * 왜 하한을 두는가: 나중에 누가 alias 를 정리하거나 term 을 지우면 커버리지가 조용히
 * 떨어진다. 그때 이 게이트가 잡는다.
 */
const COVERAGE_FLOOR = 0.66;

/**
 * 확충 후 사전 총량 하한. 132(기존) + 141(신규) = 273.
 *
 * 처음엔 148을 신규로 잡았는데, 그중 7건(완봉·마운드·더그아웃·타순·엔트리·직선타·승률)은
 * 이미 사전에 있는 용어였다. 그대로 둘 경우 ON CONFLICT DO UPDATE 가 사람이 검수한
 * 기존 answer 를 덮어쓴다. 그래서 alias 보강으로 내리고 이 숫자를 실측값으로 맞췄다.
 */
const MIN_TERM_COUNT = 273;

const MUTATION = process.env.GLOSSARY_GATE_MUTATION ?? "";

const repoRoot = process.cwd();
const seedSqlPath = path.join(repoRoot, "supabase/migrations/20260730_baseball_qa_seed.sql");
const expansionSqlPath = path.join(
  repoRoot,
  "supabase/migrations/20260805170000_baseball_terms_expansion.sql",
);
const fixturePath = path.join(repoRoot, "scripts/qa/fixtures/baseball-glossary-miss-log.json");

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type MissLogFixture = {
  total: number;
  questions: { q: string; count: number }[];
};

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as MissLogFixture;

/**
 * fixture 자체의 무결성을 먼저 본다.
 * 게이트를 통과시키려고 fixture 에서 어려운 질문을 빼는 순간 커버리지는 올라가고
 * 검증력은 사라진다. 그 방향을 막는다.
 */
check("fixture 는 운영 원문이며 축소되지 않았다", () => {
  assert.ok(Array.isArray(fixture.questions), "questions 배열이 있어야 함");
  assert.equal(
    fixture.questions.length,
    fixture.total,
    "선언된 total 과 실제 항목 수가 일치해야 함",
  );
  assert.ok(
    fixture.questions.length >= 478,
    `fixture 는 운영 실측 478건 이상이어야 함 (현재 ${fixture.questions.length}). 줄이면 게이트가 약해진다`,
  );
  const unique = new Set(fixture.questions.map((item) => item.q));
  assert.equal(unique.size, fixture.questions.length, "fixture 에 중복 질문이 없어야 함");
});

async function loadGlossaryFromMigrations(): Promise<GlossaryEntry[]> {
  const db = new PGlite();
  // 운영 스키마와 같은 제약을 건다. term UNIQUE 가 없으면 멱등성 결함을 못 잡는다.
  await db.exec(`
    CREATE TABLE public_baseball_terms_placeholder (x int);
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE IF NOT EXISTS public.baseball_terms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      term text NOT NULL UNIQUE,
      aliases text[] NOT NULL DEFAULT '{}',
      answer text NOT NULL,
      category text NOT NULL DEFAULT 'rule',
      source_kind text NOT NULL CHECK (source_kind IN ('official_rule', 'official_record', 'editorial_definition')),
      source_url text,
      rule_version text NOT NULL,
      reviewed_at date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const seedSql = readFileSync(seedSqlPath, "utf8");
  let expansionSql = readFileSync(expansionSqlPath, "utf8");

  // ── 결함 주입 ───────────────────────────────────────────────────────────────
  // 실제 migration SQL 을 변조해 이 게이트가 RED 를 내는지 증명한다.
  if (MUTATION === "drop-new-terms") {
    // 신규 용어를 나중에 누군가 지운 상황을 재현한다.
    //
    // 왜 INSERT 문을 지우지 않는가: INSERT 를 지우면 alias 보강 대상이 사라져
    // migration 자체가 fail-close 로 죽는다. 그건 "migration 안전장치가 동작했다"는
    // 증거일 뿐, 이 게이트의 **커버리지 검증력**을 증명하지 못한다.
    // 우리가 잡아야 하는 건 "migration 은 성공했는데 사전이 줄어든" 상황이다.
    expansionSql += `\nDELETE FROM public.baseball_terms WHERE reviewed_at = DATE '2026-08-05';\n`;
  }
  if (MUTATION === "restore-collision") {
    // 충돌 alias 제거를 되돌린다. `직구` 가 포심에 가려져 조용히 오답이 되는 상태 재현.
    expansionSql = expansionSql.replace(
      /UPDATE public\.baseball_terms SET aliases = ARRAY\(SELECT a FROM unnest\(aliases\)[\s\S]*?WHERE term = '타순';/,
      "SELECT 1;",
    );
  }
  if (MUTATION === "drop-alias-additions") {
    // alias 보강만 제거. 오타·약어 표기가 다시 안 잡혀야 한다.
    expansionSql = expansionSql.replace(
      /UPDATE public\.baseball_terms SET aliases = ARRAY\(SELECT DISTINCT unnest\(aliases \|\|[^;]*;/g,
      "SELECT 1;",
    );
  }
  if (MUTATION === "overlong-answer") {
    // 발송 상한을 넘는 답변을 심는다. 길이 계약이 살아있는지 확인.
    expansionSql = expansionSql.replace(
      "('적시타', ARRAY[",
      `('${"길".repeat(5)}테스트과다', ARRAY['__mutation_overlong__']::text[], '${"가".repeat(
        BASEBALL_GENIUS_MAX_ANSWER_LENGTH + 40,
      )}', 'batting', 'editorial_definition', NULL, 'not_applicable', DATE '2026-08-05'),\n  ('적시타', ARRAY[`,
    );
  }

  await db.exec(seedSql);
  await db.exec(expansionSql);
  // 멱등성: 두 번 돌려도 같은 결과여야 한다(운영에서 재적용될 수 있다).
  await db.exec(expansionSql);

  const rows = (
    await db.query<{ term: string; aliases: string[]; answer: string; source_kind: string; source_url: string | null; rule_version: string }>(
      "SELECT term, aliases, answer, source_kind, source_url, rule_version FROM public.baseball_terms ORDER BY term",
    )
  ).rows;
  await db.close();
  return rows as unknown as GlossaryEntry[];
}

type GlossaryRow = {
  term: string;
  aliases: string[];
  answer: string;
  source_kind: string;
  source_url: string | null;
  rule_version: string;
};

async function run(): Promise<void> {
const glossary = await loadGlossaryFromMigrations();
const raw = glossary as unknown as GlossaryRow[];

check("확충 migration 이 실제로 적용되어 사전이 커졌다", () => {
  assert.ok(
    glossary.length >= MIN_TERM_COUNT,
    `사전은 ${MIN_TERM_COUNT}종 이상이어야 함 (현재 ${glossary.length})`,
  );
});

check("migration 은 멱등이다 (2회 적용해도 중복 term 0)", () => {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const entry of glossary) {
    if (seen.has(entry.term)) dup.push(entry.term);
    seen.add(entry.term);
  }
  assert.deepEqual(dup, [], "중복 term 이 없어야 함");
});

// ── ③ alias 충돌 0 ─────────────────────────────────────────────────────────────
check("정규화 키 충돌 0 (조용히 가려지는 용어가 없다)", () => {
  const owner = new Map<string, string>();
  const collisions: string[] = [];
  for (const entry of glossary) {
    for (const name of [entry.term, ...entry.aliases]) {
      for (const key of [normalizeKey(name), normalizeQuestion(name)]) {
        if (!key) continue;
        const prev = owner.get(key);
        if (prev && prev !== entry.term) collisions.push(`${key}: ${prev} vs ${entry.term}`);
        if (!prev) owner.set(key, entry.term);
      }
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `충돌하면 뒤엣것이 예외 없이 가려진다:\n${collisions.join("\n")}`,
  );
});

// ── ② 기존 132종 회귀 0 ────────────────────────────────────────────────────────
const seedTerms = [
  ...readFileSync(seedSqlPath, "utf8").matchAll(/\n\('([^']+)', ARRAY\[/g),
].map((match) => match[1]);

check("기존 시드 용어가 확충에 가려지지 않는다", () => {
  assert.ok(seedTerms.length >= 130, `시드 term 추출이 정상이어야 함 (현재 ${seedTerms.length})`);
  const broken: string[] = [];
  for (const term of seedTerms) {
    const hit = matchGlossary(glossary, term);
    if (hit?.term !== term) broken.push(`${term} → ${hit?.term ?? "(미매칭)"}`);
  }
  assert.deepEqual(broken, [], `기존 용어가 자기 자신으로 매칭돼야 함:\n${broken.join("\n")}`);
});

// ── ① 실제 운영 질문 커버리지 ──────────────────────────────────────────────────
const resolved = fixture.questions.map((item) => ({
  ...item,
  hit: matchGlossary(glossary, item.q),
}));
const hitCount = resolved.filter((item) => item.hit).length;
const coverage = hitCount / resolved.length;

check(`운영 미답변 질문 커버리지 ≥ ${(COVERAGE_FLOOR * 100).toFixed(0)}%`, () => {
  assert.ok(
    coverage >= COVERAGE_FLOOR,
    `커버리지 ${(coverage * 100).toFixed(1)}% (${hitCount}/${resolved.length}) — 기준선 ${(COVERAGE_FLOOR * 100).toFixed(0)}% 미만`,
  );
});

/**
 * 대표 표본 고정.
 *
 * 총량(%)만 보면 A 를 지우고 B 를 넣어 숫자를 유지하는 회귀를 놓친다.
 * 그래서 로그 빈도 상위이거나 성격이 뚜렷한 질문들은 **어느 용어로 답해야 하는지까지**
 * 고정한다. 전부 운영 로그 원문이다.
 */
const ANCHORS: [question: string, expectedTerm: string][] = [
  ["적시타가 뭐야", "적시타"],
  ["적시타", "적시타"],
  ["타수가 뭐야?", "타수"],
  ["투런포가 뭐야?", "투런"],
  ["삼자범퇴가 뭐야?", "삼자범퇴"],
  ["주루사", "주루사"],
  ["추격조", "추격조"],
  ["유격수가 뭐애", "유격수"], // 오타 어미(`뭐애`) 정규화
  ["BABIP", "BABIP"],
  ["바빕", "BABIP"],
  ["wOBA가 뭐야?", "wOBA"],
  ["K/9", "K/9"],
  ["ISO가 뭐야?", "ISO"],
  ["Qs+은?", "QS+"],
  ["볼펜", "불펜"], // 오타 alias
  ["퍼팩트게임", "퍼펙트게임"], // 오타 alias
  ["삼진아웃이 뭐야", "삼진"],
  ["보쿠가 뭐야", "보크"], // 오타 alias
  ["잔루만루", "잔루만루"],
  ["초구딱", "초구"],
  ["할푼리 가 뭐에요", "할푼리"],
  ["게임차가 뭐야", "게임차"],
  ["1선발이 뭐야", "1선발"],
  ["필승조", "필승조"],
  ["영구결번이 뭐야", "영구결번"],
  ["가을야구", "가을야구"],
  ["빠던", "빠던"],
  ["호수비뜻", "호수비"],
  ["본헤드 플레이가 뭐야", "본헤드 플레이"],
  ["고의낙구가 뭐야", "고의낙구"],
  ["페어볼이 뭐야", "페어"],
  ["제구가 뭐야", "제구"],
  ["루킹삼진이 머야", "루킹삼진"],
  ["보살이 뭐야", "보살"],
  ["수비수 번호", "포지션 번호"],
  ["643 병살", "6-4-3 병살"],
  ["무사 만루가 뭐야", "무사 만루"],
  ["홈스틸이 뭐야", "홈스틸"],
  ["옵트아웃이 뭐야?", "옵트아웃"],
  ["프랜차이즈 선수가 뭐야", "프랜차이즈 스타"],
];

check("대표 표본이 올바른 용어로 매칭된다", () => {
  const wrong: string[] = [];
  for (const [question, expected] of ANCHORS) {
    const hit = matchGlossary(glossary, question);
    if (hit?.term !== expected) wrong.push(`"${question}" → ${hit?.term ?? "(미매칭)"} (기대 ${expected})`);
  }
  assert.deepEqual(wrong, [], `표본 오매칭:\n${wrong.join("\n")}`);
});

check("대표 표본은 전부 운영 로그에 실재하는 질문이다", () => {
  const logged = new Set(fixture.questions.map((item) => item.q));
  const invented = ANCHORS.map(([question]) => question).filter((question) => !logged.has(question));
  assert.deepEqual(
    invented,
    [],
    `게이트가 지어낸 질문으로 통과하면 안 된다:\n${invented.join("\n")}`,
  );
});

// ── ④ 발송 계약 ────────────────────────────────────────────────────────────────
check(`모든 답변이 발송 상한 ${BASEBALL_GENIUS_MAX_ANSWER_LENGTH}자 이내`, () => {
  const over = raw
    .filter((row) => row.answer.length > BASEBALL_GENIUS_MAX_ANSWER_LENGTH)
    .map((row) => `${row.term}(${row.answer.length}자)`);
  assert.deepEqual(over, [], `상한 초과:\n${over.join("\n")}`);
});

check("근거 분류가 스키마 계약을 만족한다", () => {
  const bad: string[] = [];
  for (const row of raw) {
    if (row.source_kind === "editorial_definition") {
      if (row.source_url !== null) bad.push(`${row.term}: editorial 인데 URL 이 있음`);
      if (row.rule_version !== "not_applicable") bad.push(`${row.term}: editorial 인데 rule_version=${row.rule_version}`);
    } else {
      if (!row.source_url) bad.push(`${row.term}: ${row.source_kind} 인데 URL 이 없음`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

check("답변에 외부 링크·마크업이 섞이지 않는다", () => {
  // 발송 검증(validateLlmResponse)이 링크를 거절하므로, 사전 답변에 링크가 있으면
  // 사전 경로만 우회해 나가는 불일치가 생긴다.
  const bad = raw
    .filter((row) => /https?:\/\/|www\.|```|<a\b/i.test(row.answer))
    .map((row) => row.term);
  assert.deepEqual(bad, [], `답변 본문에 링크/마크업이 있으면 안 됨: ${bad.join(", ")}`);
});

console.log(
  `\n커버리지 ${(coverage * 100).toFixed(1)}% (${hitCount}/${resolved.length}) · 사전 ${glossary.length}종` +
    (MUTATION ? ` · MUTATION=${MUTATION}` : ""),
);
console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`실패: ${failures.join(", ")}`);
  process.exit(1);
}
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
