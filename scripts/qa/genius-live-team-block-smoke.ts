/**
 * 야잘알봇 **tier L(현재 시즌 상황) 주입** 계약 게이트
 * (하린아빠 2026-08-28 "핵심은 야잘알봇 답변 퀄리티" — 답변 품질 트랙 ①).
 *
 * ── 왜 이 게이트가 있는가 (48h 원장 645건 judge 전수 실측) ──────────────────
 *   `team_rag` 38건 중 GOOD 11건(29%). 나머지는 전부 같은 모양이었다 —
 *   **나무위키 스냅샷에는 시점이 없어서 모델이 과거 서술을 현재로 단정**한다:
 *     · `롯데 가을야구 갈 수 있을까?` → "이미 진출이 좌절되었어요" (시즌 진행 중)
 *     · `한화 감독 누구여`           → 역대 감독 나열 (현 감독 없음)
 *     · `롯데 투수 선발진`           → 과거 시즌 로테이션
 *   같은 코드베이스의 뉴스클리핑·프리뷰·경기요약은 이미 `standings-guard` 로 공식
 *   순위표를 주입하는데 **야잘알봇 파이프라인만 안 하고 있었다**(2026-08-28 배선 실측).
 *
 * ── 검증 축 ────────────────────────────────────────────────────────────────
 *   L1  블록 생성: 정상 순위/기록 → 블록 문자열에 순위·전적이 원값 그대로 실린다
 *   L2  fail-close: 순위 행이 없으면 블록을 만들지 않는다(null) — 반쪽 블록으로
 *       "현재"를 주장하게 하지 않는다
 *   L3  원값 계약: 블록의 값은 `resolveTeamRecord` 산출과 **문자열 동일**하다
 *       (재계산·재포맷 금지 — 앱 순위표와 1비트도 달라지면 안 된다)
 *   L4  프롬프트 계약: 시점 규칙 3문장이 `RAG_TEAM_SYSTEM_PROMPT` 에 실재한다
 *   L5  요청 조립: `liveTeamBlock` 이 주어지면 **데이터 구획**으로만 들어간다
 *       (systemInstruction 오염 0 — 프롬프트 인젝션 경계 계약)
 *   L6  미주입 시 무변화: 블록이 없으면 요청 본문이 종전과 byte 동일
 *   L7  숫자 계약 불변: tier2 출력 숫자 전면 HOLD 는 그대로다 — 블록이 있어도
 *       숫자 섞인 답변은 폐기된다(`validateRagResponse` 미변경 증명)
 *   L8  배선 종단: 파이프라인 team RAG 분기가 블록 seam 을 실제로 호출한다
 *
 * 검증력 증명: `--selftest` 는 판정 함수를 **변조 입력**에 태워 RED 가 나는지 본다.
 * (mutation 은 `genius-live-team-block-mutations.mjs` 가 소스 변조로 수행한다.)
 *
 * 실행: npm run qa:genius-live-team-block
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLiveTeamBlock,
  composeTeamRecordAnswer,
  resolveTeamRecord,
  type StandingsRow,
  type TeamRecordsPayload,
} from "../../src/lib/baseball-qa/stats/team-record";
import {
  buildRagLlmRequest,
  validateRagResponse,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_GROUNDED_SENTINEL,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

const SELFTEST = process.argv.includes("--selftest");
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = (rel: string) =>
  readFileSync(new URL(`../../src/lib/baseball-qa/${rel}`, import.meta.url), "utf8");
/** 주석 문면이 assertion 을 만족시키면 false-green 이다 (M90). 오프셋 보존 blank 처리. */
const stripComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

// ── fixture: 실제 `/api/standings`·`/api/team-records` 응답 모양 ────────────────
const STANDINGS: StandingsRow[] = [
  { teamName: "LG", teamId: 1, games: 120, wins: 70, losses: 48, draws: 2, winRate: 0.593, gamesBehind: 0, ranking: 1 },
  { teamName: "롯데", teamId: 3, games: 121, wins: 58, losses: 61, draws: 2, winRate: 0.487, gamesBehind: 12.5, ranking: 7 },
];
const RECORDS: TeamRecordsPayload = {
  season: 2026,
  batting: [{ teamId: 3, slug: "lotte", avg: ".271", ops: ".740", hr: 88, runs: 520, sb: 71, hits: 1050 }],
  pitching: [{ teamId: 3, slug: "lotte", era: "4.35", whip: "1.42", so: 890, sv: 30 }],
};
const teamIdOf = (canonical: string): number | null =>
  canonical === "LG" ? 1 : canonical === "롯데" ? 3 : null;

// ── 판정 함수 (selftest 가 변조 입력에도 태운다) ────────────────────────────
/** L1/L3: 블록이 순위·전적을 **원값 그대로** 담았는가. */
function blockCarriesLiveValues(block: string | null, canonical: string): string[] {
  const errs: string[] = [];
  if (block === null) return ["블록이 null"];
  for (const metric of ["ranking", "record"] as const) {
    const outcome = resolveTeamRecord(metric, canonical, STANDINGS, RECORDS, teamIdOf);
    if (outcome.kind !== "ok") { errs.push(`${metric} 조회 실패`); continue; }
    // 원값 문자열이 그대로 있어야 한다 — 재포맷하면 앱 순위표와 갈라진다.
    if (!block.includes(`${outcome.label}: ${outcome.value}`)) {
      errs.push(`${metric} 원값 부재: 기대 "${outcome.label}: ${outcome.value}"`);
    }
  }
  if (!block.includes(canonical)) errs.push("구단명 부재");
  return errs;
}

async function main() {
  const pipeline = stripComments(src("pipeline.ts"));
  const retrieve = stripComments(src("rag/retrieve.ts"));

  // ── L1. 블록 생성 ─────────────────────────────────────────────────────────
  const block = buildLiveTeamBlock("롯데", STANDINGS, RECORDS, teamIdOf);
  check("L1 블록 생성 — 롯데", block !== null && block.length > 0, String(block));
  check("L1b 순위·전적 원값 결속", blockCarriesLiveValues(block, "롯데").length === 0,
    blockCarriesLiveValues(block, "롯데").join(" / "));

  // ── L2. fail-close — 순위 행이 없으면 블록을 만들지 않는다 ────────────────
  //   반쪽 블록으로 "현재"를 주장하게 두면, 순위를 모르는 채 팀타율만 보고
  //   현재 상황을 서술한다. 안 주는 쪽이 낫다.
  const noRanking = buildLiveTeamBlock("롯데", [], RECORDS, teamIdOf);
  check("L2 순위 부재 → null (fail-close)", noRanking === null, String(noRanking));
  const unknownTeam = buildLiveTeamBlock("없는팀", STANDINGS, RECORDS, () => null);
  check("L2b 미해석 구단 → null", unknownTeam === null, String(unknownTeam));

  // ── L3. 원값 계약 — 구조화 답변과 같은 값을 쓴다 ──────────────────────────
  const rankOutcome = resolveTeamRecord("ranking", "롯데", STANDINGS, RECORDS, teamIdOf);
  assert.equal(rankOutcome.kind, "ok");
  if (rankOutcome.kind === "ok") {
    const structuredAnswer = composeTeamRecordAnswer(rankOutcome);
    // 같은 원값이 두 표면(구조화 답변·tier L 블록)에 동일하게 나타나야 한다.
    check("L3 구조화 답변과 원값 동일",
      structuredAnswer.includes(rankOutcome.value) && (block ?? "").includes(rankOutcome.value),
      `${structuredAnswer} vs ${block}`);
  }

  // ── L4. 프롬프트 시점 계약 ────────────────────────────────────────────────
  //   ⚠️ 문면 exact 가 아니라 **계약 요소**로 검사한다 — 문구 다듬기로 게이트가 깨지면
  //   다음 사람이 assertion 을 느슨하게 만든다. 대신 요소가 빠지면 반드시 RED 다.
  const promptAxes: ReadonlyArray<{ name: string; re: RegExp }> = [
    { name: "현재 단정 금지", re: /현재 상태를 단정하지 않는다/ },
    { name: "시변 주제 열거", re: /순위.*감독.*선발로테이션|감독.*포스트시즌 진출 여부/ },
    { name: "진행 시즌 과거화 금지", re: /진행 중인 시즌의 결과를 끝난 일처럼 말하지 않는다/ },
    { name: "블록 우선", re: /<현재 시즌 상황>.*정본|블록을 따른다/ },
    { name: "블록 숫자 전재 금지", re: /블록의 숫자를 답변에 옮기지는 않는다/ },
  ];
  for (const axis of promptAxes) {
    check(`L4 프롬프트 — ${axis.name}`, axis.re.test(RAG_TEAM_SYSTEM_PROMPT));
  }

  // ── L5. 요청 조립 — 데이터 구획으로만 들어간다 ───────────────────────────
  const evidence: RagEvidence[] = [{
    content: "롯데 자이언츠는 부산을 연고로 하는 구단이다.",
    pageTitle: "롯데 자이언츠",
    canonicalUrl: "https://namu.wiki/w/롯데",
    revision: "1",
    sectionPath: "본문",
    asOf: "2026-08-01",
    sourceGrade: "tier2",
  }];
  const withBlock = buildRagLlmRequest("롯데 요즘 어때?", evidence, RAG_TEAM_SYSTEM_PROMPT, {
    liveTeamBlock: block ?? undefined,
  });
  const userText = withBlock.contents[0].parts[0].text;
  const sysText = withBlock.systemInstruction.parts[0].text;
  check("L5 블록이 user 구획에 실린다", userText.includes(block ?? "\u0000"));
  check("L5b 구획 마커 존재",
    userText.includes("<현재 시즌 상황") && userText.includes("<현재 시즌 상황 끝>"));
  // 🔴 인젝션 경계: 데이터는 systemInstruction 을 절대 오염시키지 않는다.
  check("L5c systemInstruction 미오염", !sysText.includes(block ?? "\u0000"));

  // ── L6. 미주입 시 종전과 byte 동일 ───────────────────────────────────────
  const withoutBlock = buildRagLlmRequest("롯데 요즘 어때?", evidence, RAG_TEAM_SYSTEM_PROMPT, {});
  const baseline = buildRagLlmRequest("롯데 요즘 어때?", evidence, RAG_TEAM_SYSTEM_PROMPT);
  check("L6 블록 미설정 → 요청 동일",
    JSON.stringify(withoutBlock) === JSON.stringify(baseline));
  check("L6b 블록 설정 → 요청 상이(무증상 방지)",
    JSON.stringify(withBlock) !== JSON.stringify(baseline));

  // ── L7. 숫자 계약 불변 ────────────────────────────────────────────────────
  //   블록에 `7위`·`58승` 이 있다고 해서 tier2 출력 숫자가 열리는 것이 아니다.
  //   "근거에 있다 ≠ 근거가 그렇게 진술했다"(2026-08-07 4라운드) 는 정본 블록에도 적용된다.
  const numericAnswer = validateRagResponse(
    JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "롯데는 현재 7위입니다." }),
    { maxChars: 400 },
  );
  check("L7 tier2 숫자 여전히 폐기", numericAnswer.kind === "insufficient",
    JSON.stringify(numericAnswer));
  const textualAnswer = validateRagResponse(
    JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "롯데는 부산 연고 구단입니다." }),
    { maxChars: 400 },
  );
  check("L7b 숫자 없는 서술은 통과", textualAnswer.kind === "grounded",
    JSON.stringify(textualAnswer));

  // ── L8. 배선 종단 — 파이프라인이 seam 을 실제로 호출한다 ─────────────────
  //   ⚠️ 존재 확인이 아니라 **호출 결속**을 본다. seam 함수가 정의만 되고 호출되지
  //   않으면 이 PR 은 아무 일도 하지 않는다(M90 "소스가 바뀐 것은 동작이 바뀐 증거가 아니다").
  check("L8 seam 정의", /async function buildLiveTeamBlockForCandidate\(/.test(pipeline));
  check("L8b team RAG 분기가 seam 을 호출",
    /await buildLiveTeamBlockForCandidate\(\s*teamRagCandidate\.name/.test(pipeline));
  check("L8c 호출 결과가 extras 로 전달",
    /liveTeamBlock:\s*liveTeamBlock\s*\?\?\s*undefined/.test(pipeline));
  check("L8d retrieve 가 extras 를 소비", /extras\.liveTeamBlock/.test(retrieve));

  // ── selftest: 판정 함수가 RED 를 낼 수 있는가 ────────────────────────────
  if (SELFTEST) {
    console.log("\n── selftest (판정 함수 변조 입력) ──");
    // A. 값이 재포맷된 블록 → L1b 가 잡아야 한다
    const reformatted = "롯데 (현재 시즌 진행 중)\n순위: 7등\n전적: 58-61-2";
    check("selftest A 재포맷 블록 RED", blockCarriesLiveValues(reformatted, "롯데").length > 0);
    // B. 구단명 없는 블록 → RED
    check("selftest B 구단명 부재 RED", blockCarriesLiveValues("순위: 7위", "롯데").length > 0);
    // C. null → RED
    check("selftest C null RED", blockCarriesLiveValues(null, "롯데").length > 0);
    // D. 정상 블록은 GREEN 이어야 한다 (RED 만 나는 판정기는 판정기가 아니다)
    check("selftest D 정상 블록 GREEN", blockCarriesLiveValues(block, "롯데").length === 0);
  }

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL 게이트 실행 실패", error);
  process.exit(1);
});
