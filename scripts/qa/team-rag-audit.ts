/**
 * 구단 tier2 (team RAG) 전수 감사 — 출시 후 7일차에 실행한다.
 *
 * ⚠️ 왜 이 스크립트가 존재하는가.
 *
 * 2026-08-07 에 한글 수사 파서(224줄 + 사전 190항목)를 삭제했다. 코드의 결정론 가드는
 * 유니코드 숫자 문자(`\p{N}`) 하나만 남았고, 한글 수치(`여덟 번`·`첫 우승`)는
 * `RAG_TEAM_SYSTEM_PROMPT` 가 생성 단계에서 막는다.
 *
 * 즉 **한글 수치의 실제 위반율은 코드가 보장하지 않는다.** 그래서 감사가 유일한
 * 안전망이다. "측정 없이 층을 얹지 않는다"는 것이 그때 정한 원칙이고, 이 스크립트가
 * 그 측정을 실행 가능하게 만든다(삼순 지적: 약속만 있고 쿼리가 없었다).
 *
 * 실행: npm run qa:team-rag-audit            (기본 7일)
 *       npm run qa:team-rag-audit -- --days 14
 *
 * 판정 기준(아래 THRESHOLDS):
 *   · numeric_leak       = 답변 본문에 유니코드 숫자가 남은 건. **0건이어야 한다**
 *                          (코드 가드가 막게 되어 있으므로 1건이라도 나오면 가드 결손이다).
 *   · korean_numeral     = 한글 수사가 섞인 건. 프롬프트만 막으므로 0 이 아닐 수 있다.
 *                          비율이 임계를 넘으면 프롬프트 강화 또는 judge 도입을 검토한다.
 *
 * ⚠️ 과차단(hold_rate)은 **여기서 재지 않는다**(삼순 2026-08-07). 이 스크립트는 성공한
 *   `team_rag` 답변만 조회하므로 "근거가 있는데 못 답한 비율"은 이 데이터로 계산 불가능하다.
 *   재려면 새 DB 계측이 필요한데, 그건 또 층을 늘리는 일이라 하지 않는다.
 *   초안 헤더에 그 약속이 적혀 있었으나 구현이 없었다 — 못 지킬 약속은 지운다.
 *
 * ⚠️ **전수** 계약: 상한 하나로 자르고 끝내면 그건 전수가 아니라 표본이다. 그래서
 *   페이지네이션으로 전부 읽고 **DB 의 전체 count 와 대조**한다. 불일치하거나 상한을
 *   넘으면 조용히 통과시키지 않고 명시적으로 실패한다(감사가 유일한 안전망이므로,
 *   "일부만 보고 통과"는 안 본 것보다 나쁘다 — 봤다고 착각하게 만든다).
 *
 * ⚠️ 이 스크립트는 **읽기 전용**이다. service_role 로 로그만 조회하고 아무것도 쓰지 않는다.
 */
import { createClient } from "@supabase/supabase-js";

// ⚠️ `_env.mjs` 는 env 가 없으면 `process.exit(1)` 한다. 그래서 **top-level 로 두지 않는다** —
//   두면 self-test 가 DB 자격증명 없이는 못 돌고, 결국 CI 에서 판정 로직을 못 지킨다.
//   실제 감사(`main`)에서만 불러온다.

/** 유니코드 숫자 — 코드 가드와 **같은 식**을 쓴다. 다른 걸 쓰면 감사와 가드가 어긋난다. */
const UNICODE_NUMERIC = /\p{N}/u;

/**
 * 한글 수사 신호.
 *
 * ⚠️ 이건 **가드가 아니라 계측기**다. 정확도보다 재현성이 중요하고, 과탐은 사람이
 *   눈으로 걸러내면 된다(감사 결과는 표본을 함께 출력한다). 이 목록을 늘려서
 *   가드로 승격시키려 하지 마라 — 그 시도가 12라운드를 태웠다.
 */
const KOREAN_NUMERAL_SIGNAL =
  /(?<![가-힣])(하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|스물|첫|두 번|세 번|네 번)(?![가-힣])/;

const THRESHOLDS = {
  /** 코드 가드가 막는 축이라 0 이 아니면 결손이다. */
  numericLeakMax: 0,
  /** 프롬프트만 막는 축. 이 비율을 넘으면 프롬프트 강화/judge 도입을 검토한다. */
  koreanNumeralRateMax: 0.05,
};

/** 한 번에 읽는 페이지 크기. Supabase 기본 응답 상한을 넘지 않는 값. */
const PAGE_SIZE = 1000;
/**
 * 전수 조회 상한. 넘으면 **자르지 않고 실패**한다.
 *
 * ⚠️ 여기서 조용히 잘라 통과시키면 "전수 감사 통과" 라는 거짓 결론이 나온다.
 *   기간을 좁혀(`--days`) 나눠 돌리라고 안내하는 편이 정직하다.
 */
const MAX_ROWS = 50_000;

/**
 * 전수 조회가 실제로 **전수**였는지 검증 — 순수 함수.
 *
 * ⚠️ 상한으로 자르고 통과시키면 "전수 감사 통과"라는 거짓 결론이 나온다.
 *   일부만 보고 통과시키는 것은 안 본 것보다 나쁘다 — 봤다고 착각하게 만든다.
 */
export function verifyFullScan(expected: number, ids: number[]): string[] {
  const failures: string[] = [];
  if (expected > MAX_ROWS) {
    failures.push(
      `대상 ${expected}건이 상한 ${MAX_ROWS}건을 넘는다. --days 로 기간을 좁혀 나눠 돌린다.`);
    return failures;
  }
  if (ids.length !== expected) {
    failures.push(
      `전수 조회 실패: DB count ${expected}건 vs 조회 ${ids.length}건. ` +
      `일부만 보고 통과시키면 안 본 것보다 나쁘다(봤다고 착각하게 만든다).`);
  }
  const unique = new Set(ids).size;
  if (unique !== ids.length) {
    failures.push(`페이지 경계에서 중복 ${ids.length - unique}건이 발생했다(정렬 키 문제).`);
  }
  return failures;
}

export interface AuditCounts {
  total: number;
  numericLeak: number;
  koreanNumeral: number;
}

/** 출처 꼬리(`📄 출처: …`)는 본문이 아니다. 가드도 본문만 보므로 동일하게 자른다. */
export function auditBody(answer: string | null): string {
  return (answer ?? "").split("📄")[0];
}

/**
 * 감사 판정 — **순수 함수**로 뽑아 self-test 가 직접 호출한다.
 *
 * ⚠️ 게이트가 판정 로직을 스스로 재구현하면 대상이 죽어도 GREEN 이 된다(이 PR 에서
 *   실제로 겪었다). 그래서 CLI 와 self-test 가 **같은 함수**를 쓴다.
 */
export function evaluateAudit(counts: AuditCounts, opts: { allowEmpty: boolean }): string[] {
  const failures: string[] = [];
  if (counts.total === 0) {
    // 배포 후 0건은 "깨끗함"이 아니라 **경로 미배선**이다. 성공으로 처리하면
    // 아무것도 안 타는 상태가 감사 통과로 둔갑한다(삼순 지적).
    if (!opts.allowEmpty) {
      failures.push(
        "team_rag 답변이 0건이다 — 배포 후라면 경로가 안 타고 있다는 뜻이다(미배선). " +
        "배포 전 사전 점검이라면 --allow-empty 를 붙여 명시한다.");
    }
    return failures;
  }
  if (counts.numericLeak > THRESHOLDS.numericLeakMax) {
    failures.push(
      `숫자 누수 ${counts.numericLeak}건 — 코드 가드(\\p{N})가 막아야 하는 축이다. 가드 결손을 조사한다.`);
  }
  const koreanRate = counts.koreanNumeral / counts.total;
  if (koreanRate > THRESHOLDS.koreanNumeralRateMax) {
    failures.push(
      `한글 수사 비율 ${(koreanRate * 100).toFixed(1)}% — 프롬프트가 새고 있다. ` +
      `프롬프트 강화 또는 LLM judge 도입을 검토한다(파서 재추가는 금지).`);
  }
  return failures;
}

async function main() {
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days 값이 잘못됐다: ${days}`);
  // ⚠️ 배포 **전** 사전 점검에서만 쓴다. 배포 후 0건은 미배선이므로 RED 여야 한다.
  const allowEmpty = process.argv.includes("--allow-empty");

  await import("./_env.mjs");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요하다");
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // ── ① 전체 count 를 **먼저** 잡는다 ────────────────────────────────────────
  // 페이지네이션 결과와 대조할 기준값이다. 이게 없으면 "몇 건을 못 봤는지"를 알 수 없다.
  // query-guard: bounded -- head-only count, 행을 가져오지 않는다.
  const { count: totalCount, error: countError } = await supabase
    .from("genius_question_logs")
    .select("id", { count: "exact", head: true })
    .eq("match_path", "team_rag")
    .gte("created_at", since);
  if (countError) throw new Error(`count 조회 실패: ${countError.message}`);
  const expected = totalCount ?? 0;

  // 상한 초과는 읽기 전에 판정한다 — 자르고 통과시키지 않는다.
  const overflow = verifyFullScan(expected, Array.from({ length: expected }, (_, i) => i));
  if (expected > MAX_ROWS) {
    console.log(`\n❌ 감사 실패`);
    for (const f of overflow) console.log(`   · ${f}`);
    process.exit(1);
  }

  // ── ② 페이지네이션으로 **전부** 읽는다 ────────────────────────────────────
  type LogRow = { id: number; created_at: string; question: string; answer: string | null };
  const rows: LogRow[] = [];
  for (let from = 0; from < expected; from += PAGE_SIZE) {
    // query-guard: bounded -- match_path 단일값 + 기간 한정 + range 페이지 상한.
    //   `team_rag` 는 2026-08-07 에 `rag` 에서 분리한 구단 전용 식별자다. 이 분리가 없으면
    //   선수·공식 RAG 가 섞여 구단만 뽑을 수 없다(그래서 감사가 실행 불가였다).
    //   정렬은 `id` 로 한다 — `created_at` 은 동일 타임스탬프가 있으면 페이지 경계에서
    //   행이 겹치거나 빠질 수 있다. count 대조가 그걸 잡아주지만 애초에 만들지 않는다.
    const { data, error } = await supabase
      .from("genius_question_logs")
      .select("id, created_at, question, answer")
      .eq("match_path", "team_rag")
      .gte("created_at", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`로그 조회 실패(offset ${from}): ${error.message}`);
    const page = (data ?? []) as LogRow[];
    if (page.length === 0) break;
    rows.push(...page);
  }

  // ── ③ 전수 검증 — self-test 와 **같은 순수 함수**로 판정한다 ──────────────
  const scanFailures = verifyFullScan(expected, rows.map((r) => r.id));
  if (scanFailures.length > 0) {
    console.log(`\n❌ 감사 실패`);
    for (const f of scanFailures) console.log(`   · ${f}`);
    process.exit(1);
  }

  const numericLeaks = rows.filter((r) => UNICODE_NUMERIC.test(auditBody(r.answer)));
  const koreanNumerals = rows.filter((r) => KOREAN_NUMERAL_SIGNAL.test(auditBody(r.answer)));
  const counts: AuditCounts = {
    total: rows.length,
    numericLeak: numericLeaks.length,
    koreanNumeral: koreanNumerals.length,
  };

  console.log(`\n━━ 구단 tier2 전수 감사 (최근 ${days}일) ━━`);
  console.log(`총 team_rag 답변      ${counts.total}건 (DB count 일치 확인)`);
  if (counts.total > 0) {
    const rate = counts.koreanNumeral / counts.total;
    console.log(`유니코드 숫자 누수     ${counts.numericLeak}건  (임계 ${THRESHOLDS.numericLeakMax})`);
    console.log(`한글 수사 포함        ${counts.koreanNumeral}건 = ${(rate * 100).toFixed(1)}%  (임계 ${(THRESHOLDS.koreanNumeralRateMax * 100).toFixed(0)}%)`);
  }

  const sample = (label: string, list: LogRow[]) => {
    if (list.length === 0) return;
    console.log(`\n[${label}] 표본 ${Math.min(5, list.length)}건 — 사실 여부는 사람이 확인한다`);
    for (const r of list.slice(0, 5)) {
      console.log(`  · Q: ${r.question}`);
      console.log(`    A: ${auditBody(r.answer).slice(0, 120)}`);
    }
  };
  sample("숫자 누수", numericLeaks);
  sample("한글 수사", koreanNumerals);

  // 판정은 CLI 가 재구현하지 않고 self-test 와 **같은 순수 함수**를 쓴다.
  const failures = evaluateAudit(counts, { allowEmpty });
  if (failures.length > 0) {
    console.log(`\n❌ 감사 실패`);
    for (const f of failures) console.log(`   · ${f}`);
    process.exit(1);
  }
  if (counts.total === 0) {
    console.log(`\n✅ 사전 점검 통과 — team_rag 0건(--allow-empty). 배포 후에는 0건이 RED 다.`);
    return;
  }
  console.log(`\n✅ 감사 통과 — 숫자 누수 0건, 한글 수사 비율 임계 이내`);
}

/**
 * self-test — DB 없이 **판정 로직**만 검증한다(`npm run qa:team-rag-audit -- --self-test`).
 *
 * ⚠️ 이 게이트가 재구현으로 빠지지 않도록 CLI 와 동일한 `evaluateAudit` 를 호출한다.
 */
async function selfTest() {
  const assert = await import("node:assert/strict");
  const eq = assert.default;

  // ① 0건은 기본적으로 RED — 배포 후 0건은 "깨끗함"이 아니라 미배선이다.
  const empty = evaluateAudit({ total: 0, numericLeak: 0, koreanNumeral: 0 }, { allowEmpty: false });
  eq.equal(empty.length, 1, "0건이 통과해버렸다(미배선을 성공으로 처리)");
  eq.match(empty[0], /0건/);

  // ①-b 사전 점검 모드에서만 0건 허용.
  eq.deepEqual(
    evaluateAudit({ total: 0, numericLeak: 0, koreanNumeral: 0 }, { allowEmpty: true }), [],
    "--allow-empty 가 동작하지 않는다");

  // ② 숫자 누수는 1건이라도 RED — 코드 가드가 막는 축이다.
  eq.equal(
    evaluateAudit({ total: 100, numericLeak: 1, koreanNumeral: 0 }, { allowEmpty: false }).length, 1,
    "숫자 누수 1건이 통과했다");

  // ③ 한글 수사는 임계 이내면 통과, 넘으면 RED.
  eq.deepEqual(
    evaluateAudit({ total: 100, numericLeak: 0, koreanNumeral: 5 }, { allowEmpty: false }), [],
    "임계 이내 한글 수사가 RED 로 잡혔다");
  eq.equal(
    evaluateAudit({ total: 100, numericLeak: 0, koreanNumeral: 6 }, { allowEmpty: false }).length, 1,
    "임계 초과 한글 수사가 통과했다");

  // ④ 본문 추출 — 출처 꼬리는 감사 대상이 아니다(가드와 같은 규칙).
  eq.equal(auditBody("MBC 청룡을 인수해 창단했어요. 📄 출처: 나무위키 1990"),
    "MBC 청룡을 인수해 창단했어요. ");
  eq.ok(!UNICODE_NUMERIC.test(auditBody("창단했어요. 📄 출처: 나무위키 1990")),
    "출처 꼬리의 숫자가 누수로 오판된다");

  // ⑤ 상한/페이지 상수 계약 — 상한 초과는 자르지 않고 실패해야 한다는 전제.
  eq.ok(MAX_ROWS > PAGE_SIZE, "상한이 페이지 크기보다 작다");
  eq.ok(PAGE_SIZE >= 1000, "페이지 크기가 비합리적으로 작다");

  // ⑥ 전수 계약 — 여기가 삼순이 지적한 핵심(종전엔 .limit(5000) 으로 조용히 잘렸다).
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from);
  //   ⑥-a 정상: count 와 조회 수가 같으면 통과.
  eq.deepEqual(verifyFullScan(5001, ids(5001)), [], "정상 전수 조회가 RED 로 잡혔다");
  //   ⑥-b 🔴 5001건 중 5000건만 읽으면 **RED** — 종전 구현이 조용히 통과시키던 지점이다.
  const truncated = verifyFullScan(5001, ids(5000));
  eq.equal(truncated.length, 1, "5001건 중 5000건만 읽었는데 통과했다(전수 아님)");
  eq.match(truncated[0], /5001건 vs 조회 5000건/);
  //   ⑥-c 상한 초과는 자르지 않고 명시 RED.
  const over = verifyFullScan(MAX_ROWS + 1, []);
  eq.equal(over.length, 1, "상한 초과가 통과했다");
  eq.match(over[0], /상한/);
  //   ⑥-d 페이지 경계 중복(정렬 키 문제)도 잡는다.
  const dup = verifyFullScan(3, [1, 2, 2]);
  eq.ok(dup.some((f) => /중복/.test(f)), "페이지 중복이 통과했다");

  console.log("✅ team-rag-audit self-test PASS (0건 RED / allow-empty / 누수 / 임계 / 본문추출 / 전수 5001·상한·중복)");
}

if (process.argv.includes("--self-test")) {
  selfTest().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
    main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
