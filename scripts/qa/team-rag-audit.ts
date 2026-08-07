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
 *   · hold_rate          = 근거가 있는데도 답을 못 낸 비율(과차단 대리 지표).
 *
 * ⚠️ 이 스크립트는 **읽기 전용**이다. service_role 로 로그만 조회하고 아무것도 쓰지 않는다.
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

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

async function main() {
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days 값이 잘못됐다: ${days}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요하다");
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // query-guard: bounded -- match_path 단일값 + 기간 한정 + 상한 5000.
  //   `team_rag` 는 2026-08-07 에 `rag` 에서 분리한 구단 전용 식별자다. 이 분리가 없으면
  //   선수·공식 RAG 가 섞여 구단만 뽑을 수 없다(그래서 감사가 실행 불가였다).
  const { data, error } = await supabase
    .from("genius_question_logs")
    .select("id, created_at, question, answer")
    .eq("match_path", "team_rag")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`로그 조회 실패: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) {
    console.log(`⚠️ 최근 ${days}일 team_rag 답변이 0건이다.`);
    console.log("   배포 전이거나, 경로가 실제로 안 타고 있다는 뜻이다. 후자면 그 자체가 결함이다.");
    process.exit(0);
  }

  // 출처 꼬리(`📄 출처: …`)는 본문이 아니다. 가드도 본문만 보므로 동일하게 자른다.
  const bodyOf = (answer: string | null) => (answer ?? "").split("📄")[0];

  const numericLeaks = rows.filter((r) => UNICODE_NUMERIC.test(bodyOf(r.answer)));
  const koreanNumerals = rows.filter((r) => KOREAN_NUMERAL_SIGNAL.test(bodyOf(r.answer)));

  const koreanRate = koreanNumerals.length / rows.length;

  console.log(`\n━━ 구단 tier2 전수 감사 (최근 ${days}일) ━━`);
  console.log(`총 team_rag 답변      ${rows.length}건`);
  console.log(`유니코드 숫자 누수     ${numericLeaks.length}건  (임계 ${THRESHOLDS.numericLeakMax})`);
  console.log(`한글 수사 포함        ${koreanNumerals.length}건 = ${(koreanRate * 100).toFixed(1)}%  (임계 ${(THRESHOLDS.koreanNumeralRateMax * 100).toFixed(0)}%)`);

  const sample = (label: string, list: typeof rows) => {
    if (list.length === 0) return;
    console.log(`\n[${label}] 표본 ${Math.min(5, list.length)}건 — 사실 여부는 사람이 확인한다`);
    for (const r of list.slice(0, 5)) {
      console.log(`  · Q: ${r.question}`);
      console.log(`    A: ${bodyOf(r.answer).slice(0, 120)}`);
    }
  };
  sample("숫자 누수", numericLeaks);
  sample("한글 수사", koreanNumerals);

  const failures: string[] = [];
  if (numericLeaks.length > THRESHOLDS.numericLeakMax) {
    failures.push(
      `숫자 누수 ${numericLeaks.length}건 — 코드 가드(\\p{N})가 막아야 하는 축이다. 가드 결손을 조사한다.`);
  }
  if (koreanRate > THRESHOLDS.koreanNumeralRateMax) {
    failures.push(
      `한글 수사 비율 ${(koreanRate * 100).toFixed(1)}% — 프롬프트가 새고 있다. ` +
      `프롬프트 강화 또는 LLM judge 도입을 검토한다(파서 재추가는 금지).`);
  }

  if (failures.length > 0) {
    console.log(`\n❌ 감사 실패`);
    for (const f of failures) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ 감사 통과 — 숫자 누수 0건, 한글 수사 비율 임계 이내`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
