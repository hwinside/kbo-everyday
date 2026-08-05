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
 *  ① 실제 운영 미답변 질문(fixture) 전수를 expect/exclude 로 고정한다 — 단건 유실도, 억지 alias 도 RED.
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
 * 확충 후 사전 총량 하한. 132(기존) + 148(신규) = 280.
 *
 * 이미 사전에 있던 용어(완봉·마운드·더그아웃·타순·엔트리·직선타·승률)는 신규가 아니라
 * alias 보강으로 내렸다 — 사람이 검수한 기존 answer 를 덮지 않기 위해서다.
 *
 * ⚠️ 커버리지 백분율 하한(floor)은 쓰지 않는다. floor 방식은 A 를 잃고 B 를 얻는 회귀를
 * 못 잡고(66% 기준이면 최대 10건 유실이 GREEN), 무엇보다 **억지 alias 로 숫자를 올리는**
 * 방향을 막지 못한다. 대신 fixture 전수를 expect/exclude 로 고정한다(아래 FixtureItem).
 */
const MIN_TERM_COUNT = 280;

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

/**
 * fixture 항목 계약.
 *
 * 모든 항목은 `expect`(이 용어로 답해야 함) 또는 `exclude`(사전으로 답하지 않는 사유)
 * 중 **정확히 하나**를 갖는다. 백분율 대신 전수 고정을 쓰는 이유는 둘이다.
 *
 *  ① 백분율 하한은 단건 유실을 잡지 못한다. 이제는 `expect` 가 하나라도 다른 용어로
 *     매칭되거나 미매칭이면 그 자리에서 RED 다.
 *  ② `exclude` 를 강제하지 않으면 **억지 alias 로 커버리지를 올리는** 방향이 통한다.
 *     실제로 그래서 `4-6-3`(2루수→유격수→1루수)을 `6-4-3`(유격수→2루수→1루수)의
 *     alias 로 묶어 **정반대 답이 나갈 뻔했다**(2026-08-05 삼순 NO-GO).
 *     제외 항목에 사전이 답변을 내기 시작하면 그것도 RED 다.
 */
type FixtureItem =
  | { q: string; count: number; expect: string; exclude?: undefined }
  | { q: string; count: number; exclude: string; expect?: undefined };

type MissLogFixture = {
  total: number;
  _exclusion_reasons: Record<string, string>;
  questions: FixtureItem[];
};

const fixtureRaw = JSON.parse(readFileSync(fixturePath, "utf8")) as MissLogFixture;

/**
 * fixture 결함 주입.
 *
 * `missing-contract` 는 삼순 3차 지적을 재현한다: 라벨(expect/exclude)을 하나 지우면
 * 그 항목은 expect 검사와 exclude 검사 **양쪽에서 조용히 빠져나간다**. 개수 검사도
 * `>=` 였을 때는 못 잡았다. XOR 계약이 실제로 살아 있는지 증명한다.
 */
const fixture: MissLogFixture = (() => {
  if (MUTATION === "missing-contract") {
    const questions = fixtureRaw.questions.map((item, index) =>
      index === 0 ? ({ q: item.q, count: item.count } as unknown as FixtureItem) : item,
    );
    return { ...fixtureRaw, questions };
  }
  if (MUTATION === "unknown-exclusion-reason") {
    // 선언되지 않은 사유 코드를 쓰면(오타 포함) 잡아야 한다.
    const questions = fixtureRaw.questions.map((item) =>
      item.exclude ? ({ q: item.q, count: item.count, exclude: "MULTI_CONCEPTS" } as FixtureItem) : item,
    );
    return { ...fixtureRaw, questions };
  }
  if (MUTATION === "shrink-fixture") {
    // 어려운 질문을 빼서 통과시키려는 방향.
    return { ...fixtureRaw, total: fixtureRaw.total - 1, questions: fixtureRaw.questions.slice(1) };
  }
  return fixtureRaw;
})();

/**
 * fixture 자체의 무결성을 먼저 본다.
 * 게이트를 통과시키려고 fixture 에서 어려운 질문을 빼는 순간 커버리지는 올라가고
 * 검증력은 사라진다. 그 방향을 막는다.
 */
/**
 * 운영 실측 고유 질문 수. **하한이 아니라 정확값**이다.
 *
 * `>= 478` 로 두면 라벨을 지운 항목이 남아 있는 한 개수는 그대로라 통과한다.
 * 계보: 원본 로그 TERM 라벨 479건 중 완전히 같은 문자열이 1건 중복(`적시타가 뭐야?` 2회).
 */
const FIXTURE_EXACT_COUNT = 478;

check("fixture 는 운영 원문이며 축소되지 않았다", () => {
  assert.ok(Array.isArray(fixture.questions), "questions 배열이 있어야 함");
  assert.equal(
    fixture.questions.length,
    fixture.total,
    "선언된 total 과 실제 항목 수가 일치해야 함",
  );
  assert.equal(
    fixture.questions.length,
    FIXTURE_EXACT_COUNT,
    `fixture 는 운영 실측 고유 ${FIXTURE_EXACT_COUNT}건이어야 함 (현재 ${fixture.questions.length})`,
  );
  const unique = new Set(fixture.questions.map((item) => item.q));
  assert.equal(unique.size, fixture.questions.length, "fixture 에 중복 질문이 없어야 함");
});

/**
 * ⚠️ fixture 계약을 **런타임에서** 강제한다 (삼순 2026-08-05 3차 지적).
 *
 * 앞선 판은 `FixtureItem` 타입으로 expect/exclude 배타를 표현만 하고 실행 시 확인하지
 * 않았다. JSON 은 타입 검사를 받지 않으므로 **라벨을 하나 지우면 그 항목은 expect 검사
 * (`if (!item.expect) continue`)와 exclude 검사(`if (!item.exclude) continue`) 양쪽에서
 * 조용히 빠져나가 GREEN 이 된다**. 개수 검사도 `>=` 라 못 잡았다.
 *
 * 그래서 여기서 항목별로 정확히 하나를 갖는지(XOR), 제외 사유가 선언된 코드인지,
 * 선언된 사유가 실제로 쓰이는지까지 본다.
 */
check("fixture 전 항목이 expect XOR exclude 계약을 지킨다", () => {
  const bad: string[] = [];
  const usedReasons = new Set<string>();
  const declared = fixture._exclusion_reasons ?? {};

  assert.ok(
    Object.keys(declared).length > 0,
    "_exclusion_reasons 선언이 있어야 함 — 사유 코드가 자유 문자열이면 오타가 조용히 통과한다",
  );

  for (const item of fixture.questions) {
    const hasExpect = typeof item.expect === "string" && item.expect.length > 0;
    const hasExclude = typeof item.exclude === "string" && item.exclude.length > 0;
    if (hasExpect && hasExclude) bad.push(`${item.q}: expect 와 exclude 를 둘 다 가짐`);
    else if (!hasExpect && !hasExclude) bad.push(`${item.q}: 라벨 없음 — 양쪽 검사에서 빠진다`);
    if (hasExclude) {
      if (!(item.exclude! in declared)) bad.push(`${item.q}: 선언되지 않은 제외 사유 '${item.exclude}'`);
      usedReasons.add(item.exclude!);
    }
  }

  // 죽은 사유 코드도 잡는다 — 남아 있으면 계약이 실제와 어긋난 채로 굳는다.
  for (const reason of Object.keys(declared)) {
    if (!usedReasons.has(reason)) bad.push(`제외 사유 '${reason}' 가 선언만 되고 쓰이지 않음`);
  }

  assert.deepEqual(bad, [], `fixture 계약 위반:\n${bad.join("\n")}`);
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
  if (MUTATION === "wrong-number-alias") {
    // 삼순 NO-GO 재현: `4-6-3` 을 `6-4-3` 의 alias 로 되돌린다.
    // 6-4-3 은 유격수→2루수→1루수, 4-6-3 은 2루수→유격수→1루수라 정반대다.
    // 사전은 확신에 찬 오답을 내고, 유저는 그게 틀린 줄 모른다.
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['4-6-3','463','20-20','40-40']::text[])) WHERE term = '6-4-3 병살';\n`;
  }
  if (MUTATION === "broad-alias") {
    // 넓은 말을 좁은 term 의 alias 로 붙인다(글러브 → 포수 미트, 인필드 → 인필드플라이).
    // exclude 로 고정된 질문에 사전이 답하기 시작해야 한다.
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['인필드']::text[])) WHERE term = '인필드플라이';\n`;
  }
  if (MUTATION === "single-term-loss") {
    // 딱 한 용어만 지운다. 백분율 하한이었다면 GREEN 이었을 크기의 회귀다.
    expansionSql += `\nDELETE FROM public.baseball_terms WHERE term = '적시타';\n`;
  }
  if (MUTATION === "overwrite-answer") {
    // 재적용이 사람이 검수한 기존 answer 를 덮는 상황을 재현한다.
    // (수정 전 migration 의 `ON CONFLICT DO UPDATE SET answer = excluded.answer` 가 이랬다)
    expansionSql += `\nUPDATE public.baseball_terms SET answer = '__mutation_overwritten__' WHERE term = '보크';\n`;
  }
  if (MUTATION === "factual-claim") {
    // 삼순 P0 재현: 사전 답변에 검증 필요한 사실 주장을 되돌린다.
    // (실제로 나갔던 문장 그대로. 박재홍 2000년은 32홈런·30도루라 두 군데가 틀렸다)
    expansionSql += `\nUPDATE public.baseball_terms SET answer = '한 시즌에 홈런 40개와 도루 40개를 함께 기록한 걸 말해요.\nKBO에서는 2000년 박재홍 선수 단 한 명뿐인 대기록이에요.' WHERE term = '40-40 클럽';\n`;
  }
  if (MUTATION === "junk-alias") {
    // 빈 문자열 alias 와 한 글자 alias 를 되돌린다.
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['','a']::text[])) WHERE term = '보살';\n`;
  }
  if (MUTATION === "opposite-alias") {
    // 삼순 3차 재현: 반대 개념을 alias 로 되돌린다.
    // `우투가 뭐야` 에 좌완 설명이 나가면 유저는 왼손/오른손을 거꾸로 배운다.
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['우완','우투','오른손투수']::text[])) WHERE term = '좌완';\n`;
  }
  if (MUTATION === "seed-wrong-alias") {
    // 기존 시드에 있던 오답 alias 제거를 되돌린다(비자책은 자책점의 반대 개념).
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['비자책']::text[])) WHERE term = '자책점';\n`;
  }
  if (MUTATION === "old-rule-version") {
    // 삼순 4차 재현: 2025 규정 개정 전 구 규정으로 되돌린다.
    // 규칙이 바뀌었는데 옛 설명을 내보내면 유저는 틀린 룰을 배운다.
    expansionSql += `\nUPDATE public.baseball_terms SET answer = '1루로 뛰는 주자가 정해진 좁은 통로를 벗어나 수비를 방해하면 아웃되는 규정이에요.\n홈과 1루 사이 마지막 구간에 그려진 선을 기준으로 판단해요.' WHERE term = '쓰리피트';\n`;
  }
  if (MUTATION === "missing-condition") {
    // `인사이드더파크홈런` 에서 '실책 없이' 조건을 뺀다.
    expansionSql += `\nUPDATE public.baseball_terms SET answer = '타구가 담장을 넘지 않았는데 타자가 그대로 홈까지 달려 들어온 홈런이에요.\n기록은 홈런으로 인정돼요.' WHERE term = '인사이드더파크홈런';\n`;
  }
  if (MUTATION === "merge-distinct-pitch") {
    // 포크볼과 스플리터를 다시 같은 것으로 묶는다(낙차·구속이 다른 별개 구종).
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['스플리터','splitter']::text[])) WHERE term = '포크볼';\n`;
  }
  if (MUTATION === "conflate-dp-gidp") {
    // 병살(DP, 수비기록)과 병살타(GIDP, 타격기록)를 다시 합친다.
    expansionSql += `\nUPDATE public.baseball_terms SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY['병살','더블플레이','dp']::text[])) WHERE term = '병살타';\n`;
  }
  if (MUTATION === "undeclared-answer-fix") {
    // 선언 없이 시드 answer 를 덮는다. answer_corrections 계약이 살아 있는지 본다.
    expansionSql += `\nUPDATE public.baseball_terms SET answer = '__undeclared_overwrite__' WHERE term = '보크';\n`;
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
/**
 * 반대 개념 alias 감사.
 *
 * 2026-08-05 3차: `좌완` 에 `우완`·`우투`·`오른손투수` 를, `상반기` 에 `후반기` 를 묶었다.
 * "다른 개념을 묶지 않는다" 를 이미 두 번 고쳤는데도 **정반대 개념**이 남아 있었다.
 * `우투가 뭐야` 에 좌완 설명이 나가면 유저는 왼손/오른손을 거꾸로 배운다.
 *
 * 기계로 잡을 수 있는 건 대립쌍 접두어다. 완전하지는 않지만(실제로 `상반기/후반기` 는
 * 이 규칙으로 못 잡아 사람이 찾았다) 가장 흔한 형태는 막는다.
 */
const OPPOSITE_PREFIX_PAIRS: [string, string][] = [
  ["좌", "우"],
  ["상반", "후반"],
  ["전반", "후반"],
  ["승리", "패전"],
  ["공격", "수비"],
  ["홈", "원정"],
  ["성공", "실패"],
];

/**
 * 부정 접두어. `비자책` 은 `자책` 을 **문자열로 포함**하므로 위 대립쌍 로직으로는
 * 절대 못 잡는다(`!alias.includes(a)` 조건에서 탈락). 실제로 `seed-wrong-alias`
 * mutation 이 GREEN 으로 통과해 이 구멍을 스스로 드러냈다.
 * 그래서 "alias = 부정접두어 + term(또는 term의 어간)" 형태를 따로 본다.
 */
const NEGATION_PREFIXES = ["비", "무", "미", "역"];

check("반대 개념을 같은 용어의 alias 로 묶지 않는다", () => {
  const bad: string[] = [];
  for (const row of raw) {
    for (const alias of row.aliases) {
      // ① 대립쌍 접두어 (좌/우, 상반/후반 …)
      for (const [a, b] of OPPOSITE_PREFIX_PAIRS) {
        const termA = row.term.includes(a);
        const termB = row.term.includes(b);
        const aliasA = alias.includes(a);
        const aliasB = alias.includes(b);
        if ((termA && aliasB && !aliasA && !termB) || (termB && aliasA && !aliasB && !termA)) {
          bad.push(`${row.term} ← '${alias}' (대립쌍 ${a}/${b}) — 반대 개념이면 별도 term 이어야 한다`);
        }
      }
      // ② 부정 접두어 (자책 ↔ 비자책)
      for (const neg of NEGATION_PREFIXES) {
        if (!alias.startsWith(neg) || row.term.startsWith(neg)) continue;
        const stripped = alias.slice(neg.length);
        if (stripped.length >= 2 && row.term.startsWith(stripped)) {
          bad.push(`${row.term} ← '${alias}' (부정 접두어 '${neg}') — 부정형은 반대 개념이다`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

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

// ── ① 실제 운영 질문 전수 고정 (expect / exclude) ─────────────────────────────
//
// 백분율이 아니라 **항목 하나하나**를 본다. 이유는 FixtureItem 주석 참조.
const resolved = fixture.questions.map((item) => ({ ...item, hit: matchGlossary(glossary, item.q) }));
const hitCount = resolved.filter((item) => item.hit).length;
const expectCount = fixture.questions.filter((item) => item.expect).length;

check("expect 로 고정된 질문이 전부 그 용어로 답변된다 (단건 유실도 RED)", () => {
  const broken: string[] = [];
  for (const item of resolved) {
    if (!item.expect) continue;
    if (item.hit?.term !== item.expect) {
      broken.push(`"${item.q}" → ${item.hit?.term ?? "(미매칭)"} (기대 ${item.expect})`);
    }
  }
  assert.deepEqual(broken, [], `${broken.length}건이 기대와 다르게 답변된다:\n${broken.join("\n")}`);
});

check("exclude 로 고정된 질문에 사전이 답하지 않는다 (억지 alias 차단)", () => {
  // 이 검사가 없으면 커버리지를 올리려고 넓은 alias 를 붙이는 방향이 통한다.
  // 그 방향의 끝이 `4-6-3` → `6-4-3` 오답이었다.
  const leaked: string[] = [];
  for (const item of resolved) {
    if (!item.exclude) continue;
    if (item.hit) leaked.push(`"${item.q}" (${item.exclude}) → 사전이 '${item.hit.term}' 로 답함`);
  }
  assert.deepEqual(
    leaked,
    [],
    `사전이 답하면 안 되는 질문에 답한다. alias 범위가 넓어졌는지 확인하라:\n${leaked.join("\n")}`,
  );
});

/**
 * alias 는 term 과 **같은 것**을 가리켜야 한다.
 *
 * 숫자가 의미를 이루는 표기에서 숫자가 다르면 다른 개념이다.
 * `6-4-3`(유격수→2루수→1루수) 과 `4-6-3`(2루수→유격수→1루수) 은 정반대이고,
 * `30-30` 과 `40-40` 은 아예 다른 기록이다. 그런데도 묶으면 사전이 확신에 찬 오답을 낸다.
 *
 * 사람 눈으로는 alias 목록에서 이 결함이 잘 안 보인다. 그래서 기계가 본다:
 * alias 안의 숫자열이 그 term 의 답변 본문에 없으면 의심 대상으로 올린다.
 * (정당한 경우는 ALLOWED 에 근거와 함께 명시한다 — 침묵하는 예외를 만들지 않는다)
 */
const NUMERIC_ALIAS_ALLOWED = new Map<string, string>([
  ["6-4-3 병살|643", "붙여 쓴 같은 표기(6-4-3 = 643)"],
  ["4-6-3 병살|463", "붙여 쓴 같은 표기"],
  ["5-4-3 병살|543", "붙여 쓴 같은 표기"],
  ["10-10 클럽|1010", "붙여 쓴 같은 표기"],
  ["20-20 클럽|2020", "붙여 쓴 같은 표기"],
  ["30-30 클럽|3030", "붙여 쓴 같은 표기"],
  ["40-40 클럽|4040", "붙여 쓴 같은 표기"],
  ["쓰리번트|3", "쓰리 = 3 (한글/숫자 표기 차이)"],
  ["쓰리피트|3", "쓰리 = 3 (한글/숫자 표기 차이)"],
  ["삼자범퇴|1", "1-2-3 이닝 = 삼자범퇴의 관용 표기"],
  ["삼자범퇴|2", "1-2-3 이닝 = 삼자범퇴의 관용 표기"],
  ["무사|0", "0아웃 = 무사"],
  ["1선발|1", "term 자체의 숫자"],
  ["2차 드래프트|2", "term 자체의 숫자"],
  ["1/3이닝|0", "0.1이닝 = 1/3이닝의 기록지 표기"],
  ["자동고의4구|4", "고의4구 = 자동고의4구의 준말"],
  ["이닝|1", "1회·1이닝 = 이닝의 사례 표기"],
  ["할푼리|1", "n할 = 할푼리 읽는 법 질의"],
  ["할푼리|2", "n할 = 할푼리 읽는 법 질의"],
  ["할푼리|3", "n할 = 할푼리 읽는 법 질의"],
  ["할푼리|4", "n할 = 할푼리 읽는 법 질의"],
  ["할푼리|5", "n할 = 할푼리 읽는 법 질의"],
]);

check("숫자가 다른 표기를 같은 용어로 묶지 않는다", () => {
  const suspicious: string[] = [];
  for (const row of raw) {
    const answerDigits = row.answer.match(/[0-9]+/g) ?? [];
    for (const alias of row.aliases) {
      for (const num of alias.match(/[0-9]+/g) ?? []) {
        if (answerDigits.includes(num)) continue;
        if (NUMERIC_ALIAS_ALLOWED.has(`${row.term}|${num}`)) continue;
        suspicious.push(`${row.term} ← '${alias}' (답변에 없는 숫자 ${num})`);
      }
    }
  }
  assert.deepEqual(
    suspicious,
    [],
    `숫자가 다르면 다른 개념일 수 있다. 정당하면 NUMERIC_ALIAS_ALLOWED 에 근거를 적어라:\n${suspicious.join("\n")}`,
  );
});

/**
 * 대표 표본 고정.
 *
 * fixture 전수 고정이 있어도 이건 남긴다 — 사람이 읽고 "이건 이렇게 답해야지" 를
 * 곧바로 확인할 수 있는 목록이 있어야 리뷰가 가능하다. 전부 운영 로그 원문이다.
 */
const ANCHORS: [question: string, expectedTerm: string][] = [
  ["적시타가 뭐야", "적시타"],
  ["적시타", "적시타"],
  ["타수가 뭐야?", "타수"],
  ["투런포가 뭐야?", "투런"],
  ["삼자범퇴가 뭐야?", "삼자범퇴"],
  ["주루사", "주루사"],
  ["추격조", "추격조"],
  ["유격수가 뭐애", "유격수"],
  ["BABIP", "BABIP"],
  ["바빕", "BABIP"],
  ["wOBA가 뭐야?", "wOBA"],
  ["K/9", "K/9"],
  ["ISO가 뭐야?", "ISO"],
  ["Qs+은?", "QS+"],
  ["볼펜", "불펜"],
  ["퍼팩트게임", "퍼펙트게임"],
  ["삼진아웃이 뭐야", "삼진"],
  ["보쿠가 뭐야", "보크"],
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
  ["463병살은뭐야", "4-6-3 병살"],
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

/**
 * 기존 시드 answer 원문 보존.
 *
 * 확충 migration 은 alias 만 손대고 **사람이 검수한 answer 는 건드리지 않는다**.
 * 앞선 판(ON CONFLICT DO UPDATE SET answer = excluded.answer)은 재실행 시 기존 답을
 * 덮어썼다(2026-08-05 삼순 지적). seed SQL 원문과 직접 대조해 그 회귀를 막는다.
 */
const seedAnswers = new Map<string, string>(
  [...readFileSync(seedSqlPath, "utf8").matchAll(/\n\('([^']+)', ARRAY\[[^\]]*\], '((?:[^']|'')*)'/g)].map(
    (match) => [match[1], match[2].replace(/''/g, "'")],
  ),
);

/**
 * answer 교정 allowlist.
 *
 * 원칙은 "확충은 기존 answer 를 덮지 않는다" 이지만, 기존 답이 **명백한 오답**이면
 * 그대로 둘 수 없다(2026-08-05 4차: `병살타` 의 시드 답이 실제로는 병살(DP) 설명이었다).
 * 그 경우 조용히 덮지 않고 데이터 파일의 `answer_corrections` 에 term·사유·새 답을 적고
 * migration 이 그 term 만 개별 UPDATE 한다.
 *
 * ⚠️ 이 목록을 게이트가 **하드코딩하지 않고 데이터 파일에서 읽는** 이유: 게이트가 따로
 * 적으면 둘이 어긋나도 아무도 모른다. 여기서는 "선언된 교정 = 실제 결과" 까지 대조한다.
 */
const expansionData = JSON.parse(
  readFileSync(path.join(repoRoot, "data/baseball-qa/glossary-expansion-2026-08.json"), "utf8"),
) as { answer_corrections?: { term: string; reason: string; answer: string }[] };
const answerCorrections = new Map(
  (expansionData.answer_corrections ?? []).map((c) => [c.term, c]),
);

check("기존 시드 answer 는 선언된 교정 목록 외에는 덮이지 않는다", () => {
  assert.ok(seedAnswers.size >= 130, `시드 answer 추출이 정상이어야 함 (현재 ${seedAnswers.size})`);
  const problems: string[] = [];
  for (const row of raw) {
    const original = seedAnswers.get(row.term);
    if (original === undefined) continue;
    const correction = answerCorrections.get(row.term);
    if (row.answer === original) {
      // 교정하겠다고 선언해 놓고 실제로는 안 바뀐 경우도 결함이다(조용한 실패).
      if (correction) problems.push(`${row.term}: 교정 선언했는데 answer 가 그대로다`);
      continue;
    }
    if (!correction) {
      problems.push(`${row.term}: 선언 없이 시드 answer 가 바뀌었다`);
      continue;
    }
    if (row.answer !== correction.answer) {
      problems.push(`${row.term}: 실제 answer 가 선언된 교정문과 다르다`);
    }
    if (!correction.reason || correction.reason.length < 20) {
      problems.push(`${row.term}: 교정 사유가 비었거나 너무 짧다`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `시드 answer 교정 계약 위반:\n${problems.join("\n")}`,
  );
});

/**
 * 사전 answer 에 **검증이 필요한 사실 주장**을 넣지 않는다.
 *
 * 2026-08-05 실제 사고: `40-40 클럽` 답에 "KBO에서는 2000년 박재홍 선수 단 한 명뿐" 이라고
 * 썼는데 두 군데가 틀렸다 — 박재홍 2000년은 32홈런·30도루였고(그는 1996년 최초 30-30
 * 달성자다), KBO 40-40 은 2015년 에릭 테임즈가 유일하다. 사전은 사람이 검수한 답을
 * 그대로 내보내므로 이런 오류는 **확신에 찬 오답**이 되어 나간다.
 *
 * 설령 맞더라도 "유일·최초" 류는 다음 달성자가 나오면 틀려진다. 기록 수치는
 * 구조화 DB(kbo_structured)나 RAG 가 답할 영역이고, 사전은 뜻만 말한다.
 *
 * ⚠️ 기존 시드 132종은 대상에서 뺀다. 이미 사람이 검수해 운영 중이고 이 확충의 범위가
 * 아니다(예: ABS "2024년 도입", 샐러리캡 "2023년부터"). 대상은 이번에 새로 넣는 답뿐이다.
 */
const FACTUAL_CLAIM_PATTERNS: [RegExp, string][] = [
  [/\b(?:19|20)[0-9]{2}\s*년/, "특정 연도"],
  [/유일|최초|단\s*한\s*명|처음으로/, "유일·최초 주장"],
  // ⚠️ "특정 선수 이름" 을 정규식으로 잡으려던 시도는 폐기했다.
  // `[가-힣]{2,4}\s*선수(가|는|…)` 로 짰더니 "선수가 계약을 끝내고"(옵트아웃),
  // "어깨가 강한 선수가 맡아요"(우익수) 같은 **일반 문장**을 전부 잡았다.
  // 한국어에서 '선수'는 보통명사라 이름과 구분되지 않는다.
  // 실제 사고(40-40)는 연도와 '단 한 명' 두 패턴에 모두 걸리므로, 잡아야 할 것은
  // 위 두 개로 덮인다. 검출력 없는 규칙을 남겨 오탐을 내는 쪽이 더 나쁘다.
];

/**
 * 연도 표기 허용 목록.
 *
 * 막으려는 건 "누가 언제 어떤 기록을 세웠다" 는 **기록 주장**이다(40-40 사고).
 * 반면 **규칙의 시행 시점**은 용어의 뜻 자체이고, 빼면 오히려 구 규정을 가르치게 된다
 * (`쓰리피트` 는 2025년에 주로가 넓어졌다 — 안 적으면 답이 틀린다).
 *
 * 그래서 전면 금지 대신 term 별 근거를 남긴다. 근거 없이 연도를 쓰면 여전히 RED 다.
 * 기존 시드에도 같은 성격의 서술이 있다(ABS "2024년 도입", 샐러리캡 "2023년부터").
 */
const RULE_YEAR_ALLOWED = new Map<string, string>([
  ["쓰리피트", "2025 KBO 규정 개정으로 주로가 1루 페어지역 흙까지 확대 — 시행 시점이 뜻의 일부"],
]);

check("신규 답변에 검증 필요한 사실 주장이 없다", () => {
  const seeded = new Set(seedAnswers.keys());
  const claims: string[] = [];
  for (const row of raw) {
    if (seeded.has(row.term)) continue; // 기존 검수분은 이 확충의 범위가 아니다
    for (const [pattern, label] of FACTUAL_CLAIM_PATTERNS) {
      if (!pattern.test(row.answer)) continue;
      // 규칙 시행연도는 근거가 선언돼 있으면 통과. 그 외 패턴(유일·최초)은 예외 없음.
      if (label === "특정 연도" && RULE_YEAR_ALLOWED.has(row.term)) continue;
      claims.push(`${row.term}: ${label} — "${row.answer.split("\n")[0]}"`);
    }
  }
  assert.deepEqual(
    claims,
    [],
    `사전은 뜻만 말한다. 기록·인물 주장은 구조화 DB/RAG 의 몫이다:\n${claims.join("\n")}`,
  );
});

check("연도 허용 목록이 실제로 쓰이고 있다", () => {
  // 죽은 예외가 남으면 다음 사람이 "여긴 원래 연도 써도 되나 보다" 하고 늘린다.
  const dead: string[] = [];
  for (const [term] of RULE_YEAR_ALLOWED) {
    const row = raw.find((r) => r.term === term);
    if (!row) { dead.push(`${term}: 사전에 없는 term`); continue; }
    if (!/\b(?:19|20)[0-9]{2}\s*년/.test(row.answer)) dead.push(`${term}: 연도가 없는데 예외로 선언됨`);
  }
  assert.deepEqual(dead, [], dead.join("\n"));
});

/**
 * alias 위생.
 *
 * 빈 문자열 alias 는 정규화 키가 "" 가 되어 매칭 자체가 깨진다(`타율` 에 실제로 있었다).
 *
 * 한 글자 alias 는 원래 전부 막으려 했는데, 그러면 `k`(삼진)·`e`(실책)·`h`(안타) 같은
 * **KBO 기록지 표준 약어**까지 죽는다. matchGlossary 는 질문 전체가 그 키와 정확히 같을
 * 때만 매칭되므로(부분 문자열이 아니다) `k` 한 글자를 물으면 삼진을 답하는 게 맞다.
 * 그래서 **표준 약어만 근거와 함께 allowlist** 하고 나머지는 막는다.
 * `보살` 의 `a` 는 여기 없다 — 어시스트 약어로 쓰긴 하지만 우리 로그에 그 질의가 없고,
 * 한 글자는 오답 시 손해가 커서 근거 없이는 두지 않는다.
 */
const SINGLE_LETTER_ALIAS_ALLOWED = new Map<string, string>([
  ["삼진|k", "KBO 기록지 표준 약어 (strikeout)"],
  ["실책|e", "KBO 기록지 표준 약어 (error)"],
  ["안타|h", "KBO 기록지 표준 약어 (hit)"],
  ["득점|r", "KBO 기록지 표준 약어 (run)"],
  ["투수|p", "KBO 기록지 표준 약어 (pitcher)"],
  ["포수|c", "KBO 기록지 표준 약어 (catcher)"],
]);

check("alias 에 빈 문자열이 없고, 한 글자 약어는 근거가 있다", () => {
  const bad: string[] = [];
  for (const row of raw) {
    for (const alias of row.aliases) {
      const trimmed = alias.trim();
      if (trimmed === "") {
        bad.push(`${row.term}: 빈 alias (정규화 키가 "" 가 된다)`);
      } else if (/^[a-z0-9]$/i.test(trimmed)) {
        const key = `${row.term}|${trimmed.toLowerCase()}`;
        if (!SINGLE_LETTER_ALIAS_ALLOWED.has(key)) {
          bad.push(`${row.term}: 한 글자 alias '${alias}' — SINGLE_LETTER_ALIAS_ALLOWED 에 근거를 적어라`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

/**
 * 의미·규칙 정확성 계약 (삼순 2026-08-05 4차).
 *
 * 앞선 게이트들은 alias 의 **구조**(충돌·숫자·반대개념·위생)만 봤다. 그래서
 * "정의가 사실인가" 는 전부 GREEN 으로 통과했고, 삼순이 4건을 잡아냈다.
 * 기계가 의미를 판정할 수는 없지만, **한 번 지적받은 항목이 되돌아가는 것**은 막을 수 있다.
 * 아래는 실제 지적을 받은 항목의 핵심 조건을 답변 본문에서 직접 확인한다.
 */
const SEMANTIC_CONTRACTS: { term: string; mustInclude: RegExp; why: string }[] = [
  {
    term: "쓰리피트",
    mustInclude: /2025|페어지역|흙/,
    why: "2025 KBO 개정으로 주로가 1루 페어지역 흙까지 확대 — 구 규정만 쓰면 틀린 룰을 가르친다",
  },
  {
    term: "인사이드더파크홈런",
    mustInclude: /실책 없이|실책이 없|수비 실책 없/,
    why: "실책 덕에 홈까지 갔으면 홈런이 아니라 안타+실책이다. 조건이 정의의 핵심",
  },
  {
    term: "병살타",
    mustInclude: /땅볼/,
    why: "GIDP 는 땅볼 한정 타격 기록. 이 조건이 빠지면 병살(DP) 설명이 된다",
  },
  {
    term: "병살",
    mustInclude: /수비|아웃 2개|두 개/,
    why: "DP 는 한 플레이로 아웃 2개를 잡은 수비 기록",
  },
  {
    term: "스플리터",
    mustInclude: /포크볼|낙차/,
    why: "포크볼과의 차이(낙차·구속)를 밝혀야 별개 구종임이 드러난다",
  },
];

check("지적받은 항목의 핵심 조건이 답변에 남아 있다", () => {
  const broken: string[] = [];
  for (const contract of SEMANTIC_CONTRACTS) {
    const row = raw.find((r) => r.term === contract.term);
    if (!row) { broken.push(`${contract.term}: 사전에 없음`); continue; }
    if (!contract.mustInclude.test(row.answer)) {
      broken.push(`${contract.term}: 핵심 조건 누락 — ${contract.why}`);
    }
  }
  assert.deepEqual(broken, [], broken.join("\n"));
});

/**
 * 별개 개념으로 분리한 쌍이 다시 합쳐지지 않았는지 본다.
 * alias 로 묶이면 한쪽 질문에 다른 쪽 설명이 나간다.
 */
const MUST_STAY_SEPARATE: [string, string][] = [
  ["포크볼", "스플리터"],
  ["병살타", "병살"],
  ["좌완", "우완"],
  ["상반기", "후반기"],
  ["희생플라이", "희생타"],
  ["6-4-3 병살", "4-6-3 병살"],
  ["30-30 클럽", "40-40 클럽"],
];

check("분리한 개념이 다시 같은 용어로 합쳐지지 않는다", () => {
  const merged: string[] = [];
  for (const [a, b] of MUST_STAY_SEPARATE) {
    const rowA = raw.find((r) => r.term === a);
    const rowB = raw.find((r) => r.term === b);
    if (!rowA || !rowB) { merged.push(`${a}/${b}: 한쪽이 사전에 없음`); continue; }
    // 서로를 자기 alias 로 갖고 있으면 안 된다(정규화 키 기준으로 비교).
    const keysA = new Set([rowA.term, ...rowA.aliases].map(normalizeKey));
    const keysB = new Set([rowB.term, ...rowB.aliases].map(normalizeKey));
    if (keysA.has(normalizeKey(b))) merged.push(`${a} 가 '${b}' 를 alias 로 가짐`);
    if (keysB.has(normalizeKey(a))) merged.push(`${b} 가 '${a}' 를 alias 로 가짐`);
  }
  assert.deepEqual(merged, [], merged.join("\n"));
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
  `\nfixture ${resolved.length}건 = expect ${expectCount} / exclude ${resolved.length - expectCount}` +
    ` · 실제 사전 응답 ${hitCount}건 · 사전 ${glossary.length}종` +
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
