/**
 * 야잘알봇 **tier L(현재 시즌 정본) 주입** 계약 게이트
 * (하린아빠 2026-08-28 "핵심은 야잘알봇 답변 퀄리티" — 답변 품질 트랙 ①).
 *
 * ── 왜 이 게이트가 있는가 (48h 원장 판정 표본) ──────────────────────────────
 *   실제로 답한 645건을 판정해보니 `team_rag` 는 38건 중 GOOD 11건이었다.
 *   실패는 전부 같은 모양이다 — **나무위키 스냅샷에 시점이 없어 모델이 과거 서술을
 *   현재로 단정**한다:
 *     · `롯데 가을야구 갈 수 있을까?` → "이미 진출이 좌절되었어요" (시즌 진행 중)
 *     · `한화 감독 누구여`           → 역대 감독 나열 (현 감독 없음)
 *   같은 코드베이스의 뉴스클리핑·프리뷰·경기요약은 이미 `standings-guard` 로 공식
 *   순위표를 주입하는데 야잘알봇 파이프라인만 안 하고 있었다(2026-08-28 배선 실측).
 *
 * ── 🔴 이 게이트는 삼순 2026-08-28 NO-GO 로 판정면을 옮겼다 ─────────────────
 *   1차 버전의 L8 은 "호출 결속"이라 써놓고 실제로는 **정규식 4개**였다.
 *   `answerQuestion` 을 한 번도 안 태웠으므로 seam 이 불리는지 증명한 적이 없다.
 *   L6 도 신규 builder 끼리 비교해놓고 "종전과 byte 동일"이라 했다 — 종전을 안 태웠다.
 *   그래서 배선 축을 전부 **`answerQuestion` 종단 + `callTeamRagLlm` extras 캡처**로
 *   옮겼다(M90: 게이트가 종단 실행 경로를 안 태우면 통과는 아무 뜻이 없다).
 *
 * ── 검증 축 ────────────────────────────────────────────────────────────────
 *   [순수 판정 — buildLiveTeamBlock 직접]
 *   L1  블록 생성 + 순위·전적 **원값** 결속 (재포맷 금지, 앱 순위표와 1비트 동일)
 *   L2  fail-close: 순위 부재·미해석 구단 → skip
 *   L3  구조화 답변(`composeTeamRecordAnswer`)과 같은 원값을 쓴다
 *   L9  freshness/season fail-close: TTL 초과·시즌 불일치 → skip (삼순 착수조건 ②)
 *       + TTL 상한은 **코드 상수**라 env 로 못 푼다
 *   L10 scope 선택 주입: 응원가·감독 질문엔 블록 자체가 없다 (삼순 착수조건 ③)
 *   L11 `가을야구` 는 확률이 아니라 순위·게임차·**잔여 경기**까지만 공급
 *
 *   [종단 실행 — answerQuestion + extras 캡처]
 *   T1  정상 주입: team_rag 로 답하고 LLM 이 받은 extras 에 블록이 실린다
 *   T2  순위 부재: 블록 없이도 **team_rag 호출은 유지**된다 (fail-soft 양방향)
 *   T3  조회 throw: 〃 — 순위 API 장애가 구단 서술 질문을 죽이지 않는다
 *   T4  scope=none: 블록 미주입 + fetch 자체를 안 한다 (무관 정보 오염 차단)
 *   T5  블록 주입 시 요청 본문이 실제로 달라진다 (무증상 방지)
 *
 *   [계약 불변]
 *   L4  프롬프트 시점 계약 5축 (현재 단정 금지 / 진행 시즌 과거화 금지 / 블록 우선 /
 *       블록 숫자 전재 금지 / **정본 없으면 현재 확인 불가 명시** — 삼순 착수조건 ④)
 *   L5  인젝션 경계: 블록은 user 데이터 구획에만, systemInstruction 미오염
 *   L7  tier2 숫자 전면 HOLD 불변 — 블록이 있어도 숫자 섞인 답변은 폐기된다
 *
 * 검증력 증명은 `genius-live-team-block-mutations.mjs` 가 **소스 변조**로 수행한다.
 * `--selftest` 는 판정 함수가 RED 를 낼 수 있는지만 본다(그 자체로는 아무것도 증명 못 함).
 *
 * 실행: npm run qa:genius-live-team-block
 */
// ⚠️ 반드시 server.ts 보다 **먼저** 로드돼야 한다 — server 는 트랜지티브로 supabase/admin
//   싱글톤을 끌어오고, 그 싱글톤이 모듈 로드 시점에 env 를 요구한다(ESM 평가 순서).
//   프로덕션 무변경이며, 여기서 태우는 것은 순수 요청 조립 함수다.
import "./_smoke-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerQuestion,
  teamIdOfCanonical,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  buildLiveTeamBlock,
  composeTeamRecordAnswer,
  kstSeasonOf,
  KBO_REGULAR_SEASON_GAMES,
  LIVE_TEAM_BLOCK_MAX_AGE_MS,
  resolveLiveTeamScope,
  resolveTeamRecord,
  type LiveTeamProvenance,
  type StandingsRow,
  type StandingsSnapshot,
  type TeamRecordsPayload,
} from "../../src/lib/baseball-qa/stats/team-record";
import {
  buildRagLlmRequest,
  validateRagResponse,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_GROUNDED_SENTINEL,
  type RagEvidence,
  type RagLlmExtras,
} from "../../src/lib/baseball-qa/rag/retrieve";
// 🔴 production 요청 조립 seam — Gemini 에 실제로 보내는 payload 를 만드는 그 함수다.
//   사본이 아니라 이걸 태워야 "extras 를 손으로 재조립하다 필드를 잃는" 결함이 잡힌다
//   (삼순 2026-08-28 4차 NO-GO ① — 실제로 그 결함이 있었다).
import { buildProductionRagRequest } from "../../src/lib/baseball-qa/server";

const SELFTEST = process.argv.includes("--selftest");
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const src = (rel: string) =>
  readFileSync(new URL(`../../src/lib/baseball-qa/${rel}`, import.meta.url), "utf8");
/** 주석 문면이 assertion 을 만족시키면 false-green 이다(M90). 오프셋 보존 blank 처리. */
const stripComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

// ── fixture: 실제 `/api/standings`·`/api/team-records` 응답 모양 ────────────────
const NOW = Date.parse("2026-08-28T14:00:00+09:00");
const SEASON = kstSeasonOf(NOW);
// 🔴 teamId 는 **프로덕션 매핑 그대로** 써야 한다(롯데=7, LG=1).
//   1차 게이트는 롯데를 3 으로 넣고 `teamIdOf` 를 직접 주입해 순수 축만 GREEN 이었다 —
//   종단(`answerQuestion`)은 상수 SSOT(`teamIdOfCanonical`)를 쓰므로 픽스처가 어긋나면
//   배선이 멀지얰한데도 순수 축은 통과한다(이번 재작성에서 실제로 검출됨).
//   픽스처는 상수에서 기계적으로 끈어온다.
const LG_ID = teamIdOfCanonical("LG")!;
const LOTTE_ID = teamIdOfCanonical("롯데")!;
const STANDINGS_ROWS: StandingsRow[] = [
  { teamName: "LG", teamId: LG_ID, games: 120, wins: 70, losses: 48, draws: 2, winRate: 0.593, gamesBehind: 0, ranking: 1 },
  { teamName: "롯데", teamId: LOTTE_ID, games: 121, wins: 58, losses: 61, draws: 2, winRate: 0.487, gamesBehind: 12.5, ranking: 7 },
];
/**
 * 🔴 순위표도 **소스가 실어보낸 수신 시각**을 함께 준다 (삼순 2026-08-28 P0-③).
 *   `/api/standings` 는 CDN 이 최대 15분(`s-maxage=300`+`swr=600`) 캐시하므로
 *   우리가 응답을 받은 시각으로 신선도를 재면 캐시된 값이 방금 값이 된다.
 */
const STANDINGS: StandingsSnapshot = {
  rows: STANDINGS_ROWS,
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  // 🔴 순위표도 **자기 시즌**을 실어보낸다 (삼순 2026-08-28 4차 ②).
  //   upstream URL 이 연도 고정이라, 시즌 표기가 없으면 작년 최종 순위를 올해 현황으로
  //   말하게 된다. 부재는 0 이 아니라 모름이므로 소비처가 fail-close 한다.
  season: SEASON,
};
// 🔴 `fetchedAt` 은 **소스가 실어보낸** upstream 수신 시각이다 (삼순 2026-08-28 P0-③).
//   우리가 응답을 받은 시각이 아니다 — `/api/team-records` 는 upstream 장애 시 만료
//   캐시를 200 으로 돌려주므로, 수신 시각을 신선도로 쓰면 몇 시간 묵은 값이 방금 값이 된다.
const RECORDS: TeamRecordsPayload = {
  season: SEASON,
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  batting: [{ teamId: LOTTE_ID, slug: "lotte", avg: ".271", ops: ".740", hr: 88, runs: 520, sb: 71, hits: 1050 }],
  pitching: [{ teamId: LOTTE_ID, slug: "lotte", era: "4.35", whip: "1.42", so: 890, sv: 30 }],
};
// 순수 축도 프로덕션과 **같은 해석기**를 태운다 — 별도 매핑을 두면 둘이 갈라진다.
const teamIdOf = teamIdOfCanonical;

const freshProvenance = (over: Partial<LiveTeamProvenance> = {}): LiveTeamProvenance => ({
  fetchedAt: NOW - 60_000,
  now: NOW,
  maxAgeMs: LIVE_TEAM_BLOCK_MAX_AGE_MS,
  expectedSeason: SEASON,
  // 순위표가 실어보낸 시즌 — 전 scope 가 이걸 검사한다(삼순 2026-08-28 4차 ②).
  standingsSeason: SEASON,
  ...over,
});

// ── 판정 함수 (selftest 가 변조 입력에도 태운다) ────────────────────────────
/** L1/L3: 블록이 순위·전적을 **원값 그대로** 담았는가. */
function blockCarriesLiveValues(block: string | null, canonical: string): string[] {
  const errs: string[] = [];
  if (block === null) return ["블록이 null"];
  for (const metric of ["ranking", "record"] as const) {
    const outcome = resolveTeamRecord(metric, canonical, STANDINGS_ROWS, RECORDS, teamIdOf);
    if (outcome.kind !== "ok") { errs.push(`${metric} 조회 실패`); continue; }
    if (!block.includes(`${outcome.label}: ${outcome.value}`)) {
      errs.push(`${metric} 원값 부재: 기대 "${outcome.label}: ${outcome.value}"`);
    }
  }
  if (!block.includes(canonical)) errs.push("구단명 부재");
  return errs;
}

// ── 종단 하니스 ────────────────────────────────────────────────────────────
interface Calls {
  /** `callTeamRagLlm` 이 실제로 받은 extras — 배선 판정의 유일한 근거. */
  teamExtras: RagLlmExtras[];
  teamLlm: number;
  standingsFetch: number;
  recordsFetch: number;
  logged: string[];
}

const TEAM_EVIDENCE: RagEvidence[] = [{
  content: "롯데 자이언츠는 부산광역시를 연고로 하는 프로야구단이다.",
  pageTitle: "롯데 자이언츠",
  canonicalUrl: "https://namu.wiki/w/롯데 자이언츠",
  revision: "1234",
  sectionPath: "본문",
  asOf: "2026-08-01",
  sourceGrade: "tier2",
}];

function makeDeps(calls: Calls, overrides: Partial<QaDeps> = {}): QaDeps {
  const glossary: GlossaryEntry[] = [];
  const players: PlayerRef[] = [];
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => players,
    getCache: async () => null,
    setCache: async () => {},
    reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    log: async (row) => { calls.logged.push(row.matchPath); },
    now: () => NOW,
    callLlm: async () => ({
      text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "일반 지식으로 답합니다." }),
      inputTokens: 1, outputTokens: 1,
    }),
    enableTeamRag: true,
    searchRag: async () => TEAM_EVIDENCE,
    // 🔴 배선 판정의 seam — 여기서 받은 extras 가 곧 "LLM 이 본 것"이다.
    callTeamRagLlm: async (_q: string, _e: RagEvidence[], extras?: RagLlmExtras) => {
      calls.teamLlm += 1;
      calls.teamExtras.push(extras ?? {});
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "부산 연고 구단입니다." }),
        inputTokens: 10, outputTokens: 5,
      };
    },
    fetchTeamRecord: {
      fetchStandings: async () => { calls.standingsFetch += 1; return STANDINGS; },
      fetchTeamRecords: async () => { calls.recordsFetch += 1; return RECORDS; },
    },
    ...overrides,
  } as QaDeps;
}

async function run(question: string, overrides: Partial<QaDeps> = {}) {
  const calls: Calls = { teamExtras: [], teamLlm: 0, standingsFetch: 0, recordsFetch: 0, logged: [] };
  const result = await answerQuestion("u-livechunk", question, makeDeps(calls, overrides));
  return { result, calls };
}

async function main() {
  const pipeline = stripComments(src("pipeline.ts"));
  const retrieve = stripComments(src("rag/retrieve.ts"));
  // 🔴 주석은 blank 처리한다 — 주석 문면이 assertion 을 만족시키는 false-green 방지(M90).
  const server = stripComments(src("server.ts"));

  // ══ 순수 판정 축 ═══════════════════════════════════════════════════════
  const ok = buildLiveTeamBlock("롯데", STANDINGS_ROWS, RECORDS, teamIdOf, "standing", freshProvenance());
  assert.equal(ok.kind, "ok");
  const block = ok.kind === "ok" ? ok.block : null;

  check("L1 블록 생성 — 롯데", block !== null && block.length > 0, String(block));
  check("L1b 순위·전적 원값 결속", blockCarriesLiveValues(block, "롯데").length === 0,
    blockCarriesLiveValues(block, "롯데").join(" / "));

  const noRanking = buildLiveTeamBlock("롯데", [], RECORDS, teamIdOf, "standing", freshProvenance());
  check("L2 순위 부재 → skip(no_ranking)",
    noRanking.kind === "skip" && noRanking.reason === "no_ranking", JSON.stringify(noRanking));
  const unknownTeam = buildLiveTeamBlock("없는팀", STANDINGS_ROWS, RECORDS, () => null, "standing", freshProvenance());
  check("L2b 미해석 구단 → skip", unknownTeam.kind === "skip", JSON.stringify(unknownTeam));

  const rankOutcome = resolveTeamRecord("ranking", "롯데", STANDINGS_ROWS, RECORDS, teamIdOf);
  assert.equal(rankOutcome.kind, "ok");
  if (rankOutcome.kind === "ok") {
    const structuredAnswer = composeTeamRecordAnswer(rankOutcome);
    check("L3 구조화 답변과 원값 동일",
      structuredAnswer.includes(rankOutcome.value) && (block ?? "").includes(rankOutcome.value),
      `${structuredAnswer} vs ${block}`);
  }

  // ── L9. freshness / season fail-close (삼순 착수조건 ②) ───────────────────
  //   "tier L = 항상 최신" 은 틀렸다. `/api/team-records` 는 시즌 기본값이 고정이고
  //   장애 시 만료된 메모리 캐시를 그대로 돌려준다 — 200 은 신선도의 증거가 아니다.
  const stale = buildLiveTeamBlock("롯데", STANDINGS_ROWS, RECORDS, teamIdOf, "standing",
    freshProvenance({ fetchedAt: NOW - LIVE_TEAM_BLOCK_MAX_AGE_MS - 1 }));
  check("L9 TTL 초과 → skip(stale)",
    stale.kind === "skip" && stale.reason === "stale", JSON.stringify(stale));
  const futureFetch = buildLiveTeamBlock("롯데", STANDINGS_ROWS, RECORDS, teamIdOf, "standing",
    freshProvenance({ fetchedAt: NOW + 60_000 }));
  check("L9b 미래 관측시각 → skip (시계 이상은 신선함이 아니다)",
    futureFetch.kind === "skip" && futureFetch.reason === "stale", JSON.stringify(futureFetch));
  const wrongSeason = buildLiveTeamBlock("롯데", STANDINGS_ROWS,
    { ...RECORDS, season: SEASON - 1 }, teamIdOf, "batting", freshProvenance());
  check("L9c 시즌 불일치 → skip(season_mismatch)",
    wrongSeason.kind === "skip" && wrongSeason.reason === "season_mismatch", JSON.stringify(wrongSeason));
  // 상한은 코드 상수여야 한다 — env 로 늦추면 계약을 런타임이 무를 수 있다(M90).
  const teamRecordSrc = stripComments(readFileSync(
    new URL("../../src/lib/baseball-qa/stats/team-record.ts", import.meta.url), "utf8"));
  check("L9d TTL 상한이 코드 상수 (env 주입 불가)",
    /export const LIVE_TEAM_BLOCK_MAX_AGE_MS\s*=\s*\d+\s*\*\s*\d+\s*\*\s*\d+;/.test(teamRecordSrc)
    && !/LIVE_TEAM_BLOCK_MAX_AGE_MS\s*=\s*Number\(process\.env/.test(teamRecordSrc));

  // ── L10. scope 선택 주입 (삼순 착수조건 ③) ───────────────────────────────
  const scopeCases: ReadonlyArray<[string, ReturnType<typeof resolveLiveTeamScope>]> = [
    ["롯데 요즘 어때?", "standing"],
    ["롯데 가을야구 갈 수 있을까?", "standing"],
    ["롯데 팀 타율 어때?", "batting"],
    ["롯데 불펜 어때?", "pitching"],
    ["한화 대표 응원가 불러줘", "none"],
    ["한화 감독 누구여", "none"],
    ["엔씨 04번 누구야?", "none"],
  ];
  for (const [q, expected] of scopeCases) {
    check(`L10 scope — ${q} → ${expected}`, resolveLiveTeamScope(q) === expected,
      `실제 ${resolveLiveTeamScope(q)}`);
  }
  const scopeNone = buildLiveTeamBlock("롯데", STANDINGS_ROWS, RECORDS, teamIdOf, "none", freshProvenance());
  check("L10b scope=none → 블록 없음", scopeNone.kind === "skip", JSON.stringify(scopeNone));

  // ── L11. 가을야구 = 확률 아니라 잔여 경기까지 (삼순 착수조건 ③) ─────────
  //   확률 모델이 없는데 순위표로 숫자를 만들면 새 환각이다. 대신 판단 재료를 준다.
  const remaining = KBO_REGULAR_SEASON_GAMES - 121;
  check("L11 잔여 경기 공급", (block ?? "").includes(`잔여 경기: ${remaining}`), String(block));

  // ══ 종단 실행 축 (삼순 P0: 1차의 L8 은 정규식이었다) ═══════════════════
  const t1 = await run("롯데 요즘 어때?");
  check("T1 team_rag 로 답한다", t1.result.source === "team_rag", String(t1.result.source));
  check("T1b LLM 이 받은 extras 에 블록이 실렸다",
    t1.calls.teamLlm === 1 && typeof t1.calls.teamExtras[0]?.liveTeamBlock === "string"
    && t1.calls.teamExtras[0].liveTeamBlock!.includes("순위: 7위"),
    JSON.stringify(t1.calls.teamExtras[0]));

  // T2. 순위를 못 읽어도 team_rag 호출은 유지 — 양방향 고정.
  const t2 = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => ({ ...STANDINGS, rows: [] }),
      fetchTeamRecords: async () => RECORDS,
    },
  } as Partial<QaDeps>);
  check("T2 순위 부재에도 team_rag 유지", t2.result.source === "team_rag", String(t2.result.source));
  check("T2b 블록은 미주입", t2.calls.teamLlm === 1 && t2.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(t2.calls.teamExtras[0]));

  // T3. 조회 throw 도 마찬가지 — 순위 API 장애를 배포 가용성에 위임하지 않는다.
  const t3 = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => { throw new Error("standings upstream down"); },
      fetchTeamRecords: async () => RECORDS,
    },
  } as Partial<QaDeps>);
  check("T3 조회 실패에도 team_rag 유지", t3.result.source === "team_rag", String(t3.result.source));
  check("T3b 블록은 미주입", t3.calls.teamLlm === 1 && t3.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(t3.calls.teamExtras[0]));

  // T4. scope=none 이면 fetch 자체를 안 한다 — 무관 정보 오염 + 외부 호출 낭비 차단.
  const t4 = await run("한화 대표 응원가 불러줘");
  check("T4 scope=none → 블록 미주입",
    t4.calls.teamExtras.every((e) => e.liveTeamBlock === undefined),
    JSON.stringify(t4.calls.teamExtras));
  check("T4b scope=none → 순위 조회 0회",
    t4.calls.standingsFetch === 0 && t4.calls.recordsFetch === 0,
    `standings=${t4.calls.standingsFetch} records=${t4.calls.recordsFetch}`);

  // ── T6. source timestamp 결속 (삼순 2026-08-28 P0-③) ────────────────────
  //   `/api/team-records` 는 upstream 장애 시 **만료 캐시를 200 으로** 돌려준다.
  //   우리가 응답을 받은 시각으로 신선도를 재면 몇 시간 묵은 값이 방금 값이 된다.
  const staleSource = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => STANDINGS,
      // 소스가 "2시간 전에 받은 데이터"라고 말한다 — 우리 수신 시각은 방금이다.
      fetchTeamRecords: async () => ({
        ...RECORDS,
        fetchedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      }),
    },
  } as Partial<QaDeps>);
  check("T6 소스가 stale 이라 말하면 블록 미주입",
    staleSource.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(staleSource.calls.teamExtras[0]));
  check("T6b 그래도 team_rag 는 유지", staleSource.result.source === "team_rag",
    String(staleSource.result.source));

  //   소스가 수신 시각을 안 실어보내면 **모름**이다 — 모르면 현재를 단정하지 않는다.
  const noTimestamp = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => STANDINGS,
      fetchTeamRecords: async () => {
        const { fetchedAt: _drop, ...rest } = RECORDS;
        void _drop;
        return rest;
      },
    },
  } as Partial<QaDeps>);
  check("T6c 소스 timestamp 부재 → 블록 미주입 (부재 ≠ 방금)",
    noTimestamp.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(noTimestamp.calls.teamExtras[0]));

  //   🔴 순위표 축도 **대칭**으로 닫는다. 블록은 두 소스를 함께 실으므로 한쪽만 신선해도
  //   전체가 신선하다고 말하면 무엇이 묵은 것인지 구분되지 않는다.
  const staleStandings = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => ({
        ...STANDINGS,
        fetchedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      }),
      fetchTeamRecords: async () => RECORDS,
    },
  } as Partial<QaDeps>);
  check("T6e 순위표가 stale 이면 블록 미주입 (둘 중 오래된 쪽 기준)",
    staleStandings.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(staleStandings.calls.teamExtras[0]));

  const noStandingsTimestamp = await run("롯데 요즘 어때?", {
    fetchTeamRecord: {
      fetchStandings: async () => ({ rows: STANDINGS_ROWS }),
      fetchTeamRecords: async () => RECORDS,
    },
  } as Partial<QaDeps>);
  check("T6f 순위표 timestamp 부재 → 블록 미주입",
    noStandingsTimestamp.calls.teamExtras[0]?.liveTeamBlock === undefined,
    JSON.stringify(noStandingsTimestamp.calls.teamExtras[0]));

  //   🔴 회귀 축: 판정 기준 시각을 조회 **전**에 읽으면 프로덕션(`Date.now`)에서 age 가
  //   음수가 되어 블록이 항상 죽는다. 고정 시계 게이트는 이걸 못 본다 —
  //   그래서 여기서만 **실제로 흐르는 시계**를 주입해 조회 지연을 만든다.
  const flowing = await run("롯데 요즘 어때?", {
    now: undefined,
    fetchTeamRecord: {
      fetchStandings: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { rows: STANDINGS_ROWS, fetchedAt: new Date().toISOString(), season: kstSeasonOf(Date.now()) };
      },
      fetchTeamRecords: async () => ({ ...RECORDS, fetchedAt: new Date().toISOString() }),
    },
  } as Partial<QaDeps>);
  check("T6d 흐르는 시계 + 조회 지연에도 블록이 산다 (음수 age 회귀)",
    typeof flowing.calls.teamExtras[0]?.liveTeamBlock === "string",
    JSON.stringify(flowing.calls.teamExtras[0]));

  // T5. 주입 시 요청 본문이 실제로 달라진다 — 무증상 방지(1차 L6 의 결함).
  const injected = buildRagLlmRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT,
    { liveTeamBlock: t1.calls.teamExtras[0]?.liveTeamBlock });
  const bare = buildRagLlmRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT);
  check("T5 블록 주입 → 요청 본문 상이", JSON.stringify(injected) !== JSON.stringify(bare));
  check("T5b 블록 미주입 → 종전 요청과 동일",
    JSON.stringify(buildRagLlmRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT,
      { context: undefined })) === JSON.stringify(bare));

  // ══ 계약 불변 ═════════════════════════════════════════════════════════
  // L4. 프롬프트 시점 계약 — 문면 exact 가 아니라 **계약 요소**로 검사한다.
  const promptAxes: ReadonlyArray<{ name: string; re: RegExp }> = [
    { name: "현재 단정 금지", re: /현재 상태를 단정하지 않는다/ },
    { name: "시변 주제 일반화", re: /순위.*감독.*선발로테이션|감독.*포스트시즌 진출 여부/ },
    { name: "진행 시즌 과거화 금지", re: /진행 중인 시즌의 결과를 끝난 일처럼 말하지 않는다/ },
    { name: "블록 우선", re: /<현재 시즌 상황> 블록이 주어지면 그것만이 현재의 정본/ },
    { name: "블록 숫자 전재 금지", re: /블록의 숫자를 답변에 옮기지는 않는다/ },
    // 🔴 삼순 착수조건 ④ — 과거형 강제만으론 부족하다. 정본이 없으면 "현재 확인 불가"를 먼저.
    { name: "정본 부재 시 현재 확인 불가 명시", re: /현재는 확인해 드리기 어렵다고 먼저 밝힌 뒤/ },
  ];
  for (const axis of promptAxes) {
    check(`L4 프롬프트 — ${axis.name}`, axis.re.test(RAG_TEAM_SYSTEM_PROMPT));
  }

  // L5. 인젝션 경계 — 데이터는 systemInstruction 을 절대 오염시키지 않는다.
  const userText = injected.contents[0].parts[0].text;
  const sysText = injected.systemInstruction.parts[0].text;
  const injectedBlock = t1.calls.teamExtras[0]?.liveTeamBlock ?? "\u0000";
  check("L5 블록이 user 구획에 실린다", userText.includes(injectedBlock));
  check("L5b 구획 마커 존재",
    userText.includes("<현재 시즌 상황") && userText.includes("<현재 시즌 상황 끝>"));
  check("L5c systemInstruction 미오염", !sysText.includes(injectedBlock));

  // L7. tier2 숫자 전면 HOLD 불변 — 블록이 있어도 열리지 않는다.
  //   "근거에 있다 ≠ 근거가 그렇게 진술했다"(2026-08-07 4라운드)는 정본 블록에도 적용된다.
  const numericAnswer = validateRagResponse(
    JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "롯데는 현재 7위입니다." }),
    { maxChars: 400 },
  );
  check("L7 tier2 숫자 여전히 폐기", numericAnswer.kind === "insufficient", JSON.stringify(numericAnswer));
  const textualAnswer = validateRagResponse(
    JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "롯데는 부산 연고 구단입니다." }),
    { maxChars: 400 },
  );
  check("L7b 숫자 없는 서술은 통과", textualAnswer.kind === "grounded", JSON.stringify(textualAnswer));

  // ══ L13. 🔴 production 요청 종단 (삼순 2026-08-28 4차 NO-GO ① — 실재했던 결함) ══
  //
  //   종전 게이트는 ⓐ mock 으로 extras 캡처 ⓑ builder 직접 호출 을 **따로** 태웠다.
  //   그 사이에 있는 `callRagLlmWithPrompt` 가 extras 를 손으로 재조립하며
  //   `{ context, rosterBlock }` 만 넘기고 있었는데도 둘 다 GREEN 이었다 —
  //   즉 이 PR 은 프로덕션에서 **아무 일도 안 하고 있었다**(전형적 false-green).
  //
  //   그래서 이제 **Gemini 에 실제로 보내는 payload 를 만드는 그 함수**를 태운다.
  //   ⚠️ 판정은 "필드가 payload 문자열 안에 있는가" 다 — 시그니처 존재가 아니다.
  const prodExtras: RagLlmExtras = {
    liveTeamBlock: t1.calls.teamExtras[0]?.liveTeamBlock,
    evidenceTime: t1.calls.teamExtras[0]?.evidenceTime,
    context: { question: "직전 질문", answer: "직전 답변" },
  };
  const prodRequest = buildProductionRagRequest(
    "롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT, prodExtras);
  const prodUserText = prodRequest.contents[0].parts[0].text;
  check("L13 production payload 에 tier L 블록이 실린다",
    typeof prodExtras.liveTeamBlock === "string"
    && prodUserText.includes(prodExtras.liveTeamBlock)
    && prodUserText.includes("<현재 시즌 상황"),
    prodUserText.slice(0, 200));
  check("L13b production payload 에 시점 주석이 실린다",
    /현재성: (최신|과거 시즌|확인 불가)/.test(prodUserText),
    prodUserText.split("\n").slice(0, 3).join(" | "));
  check("L13c 직전 대화도 함께 산다 (재조립으로 기존 필드를 잃지 않았다)",
    prodUserText.includes("직전 질문") && prodUserText.includes("직전 답변"));
  // 🔴 extras 미주입이면 **종전과 byte 동일** — 선수·뉴스·공식 경로 무영향 양방향 고정.
  check("L13d extras 없으면 종전 요청과 byte 동일",
    JSON.stringify(buildProductionRagRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT))
    === JSON.stringify(buildRagLlmRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT)));
  check("L13e 주입/미주입이 실제로 다르다 (무증상 방지)",
    JSON.stringify(prodRequest)
    !== JSON.stringify(buildProductionRagRequest("롯데 요즘 어때?", TEAM_EVIDENCE, RAG_TEAM_SYSTEM_PROMPT)));
  // production 호출부가 그 함수를 **실제로** 쓰는지 — seam 동일성(M90: 사본을 태우면 무의미).
  check("L13f callRagLlmWithPrompt 가 buildProductionRagRequest 를 호출한다",
    /buildProductionRagRequest\(question, evidence, systemPrompt, extras\)/.test(server));
  check("L13g 그 함수는 extras 를 통째로 넘긴다 (필드 재조립 금지)",
    /buildRagLlmRequest\(question, evidence, systemPrompt \?\? RAG_SYSTEM_PROMPT, extras \?\? \{\}\)/
      .test(server));

  // 소스 결속은 **보조**다 — 위 종단 축이 주 판정이고, 이건 seam 이름이 바뀌었을 때의 힌트.
  check("L8 seam 정의(보조)", /async function buildLiveTeamBlockForCandidate\(/.test(pipeline));
  check("L8b retrieve 가 extras 를 소비(보조)", /extras\.liveTeamBlock/.test(retrieve));

  // ── selftest: 판정 함수가 RED 를 낼 수 있는가 (증명은 mutations 가 한다) ──
  if (SELFTEST) {
    console.log("\n── selftest (판정 함수 변조 입력) ──");
    check("selftest A 재포맷 블록 RED",
      blockCarriesLiveValues("롯데 — 진행 중\n순위: 7등\n전적: 58-61-2", "롯데").length > 0);
    check("selftest B 구단명 부재 RED", blockCarriesLiveValues("순위: 7위", "롯데").length > 0);
    check("selftest C null RED", blockCarriesLiveValues(null, "롯데").length > 0);
    check("selftest D 정상 블록 GREEN", blockCarriesLiveValues(block, "롯데").length === 0);
  }

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL 게이트 실행 실패", error);
  process.exit(1);
});
