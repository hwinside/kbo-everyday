/**
 * 최신 기사 RAG(news_rag) 배선 종단 계약 — **`answerQuestion()` 실제 실행 결과**로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-08).
 *
 * #1111 이 기사 2,438건을 적재하고 임베딩까지 끝냈는데(서빙뷰 2,438건, 검색 RPC 40 hits)
 * **조회 배선이 0** 이라 유저에게는 한 건도 닿지 않았다. #1110 구단 RAG 에서 이미 같은 일이
 * 있었다 — 71,531 chunk 를 적재해 놓고 후보 생성 코드가 없어 전량 사장됐다.
 * "적재됐다"는 "유저가 받는다"가 아니다.
 *
 * 그래서 이 게이트는 존재 검사(정규식·상수·라벨)를 쓰지 않는다. **유저가 받는 `source` 와
 * 답변 문자열**을 본다.
 *
 * 고정하는 계약 (삼순 조건부 GO 2026-08-08):
 *   ① 우선순위 유지 — 서비스/룰/선수/구조화 기록이 먼저다. `단일 TEAM + 최신성 + 서술형`만
 *      기사로 간다. `어제 LG 몇 대 몇` 은 structured, `올해/이번 시즌` 은 30일 창 밖이다.
 *   ② 최신 질문은 news 가 **소유**한다. fresh 근거 0건·검색 오류에도 team_rag/generic 으로
 *      폴백하지 않고 명시 fail-close 한다. `오늘` 도 과거 기사로 대신 답하지 않는다.
 *   ③ `어제` 는 KST 상·하한 exact, `요즘/최근` 은 고정 기간.
 *   ④ 출처 label/allowlist(네이버) · global cache 0 · sourceUrl 노출.
 *   ⑤ 숫자 전면 HOLD — 기사 제목의 수치를 그대로 옮기면 언론사 헤드라인 재발행이다.
 *
 * 실행: npm run qa:news-rag-wiring
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  isTeamRagServableQuestion,
  newsRecencyIntentOf,
  resolveRagNewsCandidate,
  NEWS_UNAVAILABLE_ANSWER,
  TEAM_STAT_HOLD_ANSWER,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import {
  RAG_GROUNDED_SENTINEL,
  RAG_NEWS_SYSTEM_PROMPT,
  selectEvidence,
  type RagEvidence,
  type RagNewsCandidate,
} from "../../src/lib/baseball-qa/rag/retrieve";
import {
  NEWS_RECENT_WINDOW_DAYS,
  resolveNewsRecency,
} from "../../src/lib/baseball-qa/rag/news-recency";
import { gradeForSourceKind } from "../../src/lib/baseball-qa/rag/contracts";
import { MATCH_PATH_REPLY_KIND, replyKindForMatchPath } from "../../src/lib/constants/baseball-genius";
import { FEEDBACK_ELIGIBLE_MATCH_PATHS } from "../../src/lib/baseball-qa/answer-feedback";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** 로스터는 **실제 배포 함수**로 읽는다 — 자체 fixture 는 loader 결함을 GREEN 으로 만든다. */
let players: PlayerRef[] = [];

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["balk"], answer: "투수의 부정 투구 동작이에요." },
];

/**
 * 판정 기준 시각 — KST 2026-08-08 12:00 (UTC 03:00).
 * 한낮으로 잡아 `오늘` 창이 비어 있지 않도록 한다. 자정 경계는 별도 케이스에서 본다.
 */
const NOW_MS = Date.parse("2026-08-08T03:00:00.000Z");

/**
 * 기사 근거 fixture.
 *
 * ⚠️ 내용·URL 형식은 production 적재분 실측 그대로다(2026-08-08 백필).
 * `canonicalUrl` 은 출처 allowlist 를 통과해야 하므로 실제 네이버 재송고 링크 형식을 쓴다 —
 * 가짜 URL 을 쓰면 출처가 안 붙는 게 정상인데 게이트가 그걸 결함으로 오판한다.
 */
const LG_YESTERDAY: RagEvidence = {
  content:
    "천성호→송찬의→문정빈 홈런 합작…FA 김현수 떠난 자리는\n" +
    "지난해 LG 트윈스는 프로야구 통합 우승을 차지했다. 떠난 주전 외야수 자리를 젊은 타자들이 메우고 있다.",
  pageTitle: "천성호→송찬의→문정빈 홈런 합작…FA 김현수 떠난 자리는",
  canonicalUrl: "https://m.sports.naver.com/kbaseball/article/109/0005585034",
  revision: "article:2b1c9f",
  sectionPath: "2026-08-07",
  asOf: "2026-08-07T09:44:00.000Z",
  sourceGrade: "tier2",
  sourceKind: "news_article",
};

interface Calls {
  news: { candidate: RagNewsCandidate; question: string }[];
  newsLlm: { question: string; evidence: RagEvidence[] }[];
  teamSearch: number;
  teamLlm: number;
  genericLlm: number;
  cacheReads: number;
  officialSearch: number;
  playerLlm: number;
  standingsFetches: number;
}

function makeDeps(overrides: Partial<QaDeps> = {}): {
  deps: QaDeps;
  logs: { matchPath: string; answer: string | null }[];
  calls: Calls;
} {
  const logs: { matchPath: string; answer: string | null }[] = [];
  const calls: Calls = {
    news: [], newsLlm: [], teamSearch: 0, teamLlm: 0, genericLlm: 0,
    cacheReads: 0, officialSearch: 0, playerLlm: 0, standingsFetches: 0,
  };
  const deps: QaDeps = {
    enablePlayerRag: true,
    enableTeamRag: true,
    enableNewsRag: true,
    now: () => NOW_MS,
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => players,
    getCache: async () => { calls.cacheReads++; return null; },
    setCache: async () => {},
    callLlm: async () => {
      calls.genericLlm++;
      return {
        text: JSON.stringify({
          status: "BASEBALL_RULE_TERM",
          answer: "LG 트윈스는 서울을 연고로 하는 KBO 리그 구단이에요.",
        }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    searchNewsRag: async (candidate, question) => {
      calls.news.push({ candidate, question });
      return [LG_YESTERDAY];
    },
    callNewsRagLlm: async (question, evidence) => {
      calls.newsLlm.push({ question, evidence });
      return {
        text: JSON.stringify({
          status: RAG_GROUNDED_SENTINEL,
          answer: "젊은 타자들이 홈런을 합작하며 떠난 주전 외야수 자리를 메우고 있어요.",
        }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    // ⚠️ 구단·선수·공식 경로를 throw 로 막으면 "기사 경로가 그 경로를 선점했는가"를 못 본다.
    //   #1110 P0-1 이 바로 그 반대경로가 없어서 GREEN 이었던 건이라 정상 동작으로 둔다.
    searchRag: async (candidate) => {
      if (candidate.entityType !== "team") return [];
      calls.teamSearch++;
      return [{
        content: "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이다.",
        pageTitle: "LG 트윈스",
        canonicalUrl: "https://namu.wiki/w/LG%20%ED%8A%B8%EC%9C%88%EC%8A%A4",
        revision: "etag:lg", sectionPath: "LG 트윈스/역사", asOf: "2026-08-05",
        sourceGrade: "tier2", sourceKind: "namu_document",
      }];
    },
    callTeamRagLlm: async () => {
      calls.teamLlm++;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "구단 문서 경로 답변이에요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    callRagLlm: async () => {
      calls.playerLlm++;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "선수 경로 답변이에요." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    searchOfficialRag: async () => { calls.officialSearch++; return []; },
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식 조문 답변이에요." }),
      inputTokens: 1, outputTokens: 1,
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async (entry) => { logs.push({ matchPath: entry.matchPath, answer: entry.answer }); },
    fetchTeamRecord: {
      fetchStandings: async () => {
        calls.standingsFetches++;
        return [{
          teamName: "LG", teamId: 1, ranking: 3,
          wins: 55, losses: 45, draws: 2, winRate: 0.55, games: 102, gamesBehind: 2.5,
        }];
      },
      fetchTeamRecords: async () => ({
        season: 2026,
        batting: [{ teamId: 1, slug: "lg", avg: ".270", hr: 92, sb: 65 }],
        pitching: [{ teamId: 1, slug: "lg", era: "3.90" }],
      }),
    },
    ...overrides,
  };
  return { deps, logs, calls };
}

async function run(): Promise<void> {
  players = await loadRosterPlayers();
  assert.ok(players.length > 0, "실제 로스터 loader 가 선수를 돌려줘야 한다");

  let passed = 0;
  const ok = (label: string) => { passed++; console.log(`PASS ${label}`); };

  // ── ① 최신성 판정 — KST 경계 exact (삼순 ③) ─────────────────────────────
  {
    // KST 2026-08-08 12:00 기준 `어제` = KST 08-07 00:00 ~ 08-08 00:00
    //                                = UTC 08-06 15:00 ~ 08-07 15:00
    const yesterday = resolveNewsRecency("어제 LG 어땠어?", NOW_MS);
    assert.equal(yesterday.kind, "fresh");
    assert.ok(yesterday.kind === "fresh");
    assert.equal(yesterday.since.toISOString(), "2026-08-06T15:00:00.000Z",
      `어제 하한이 KST 자정이 아니다: ${yesterday.since.toISOString()}`);
    assert.equal(yesterday.until.toISOString(), "2026-08-07T15:00:00.000Z",
      `어제 상한이 KST 자정이 아니다: ${yesterday.until.toISOString()}`);
    // 창 길이가 정확히 하루여야 한다 — 반열린 구간이라 이틀에 걸치지 않는다.
    assert.equal(yesterday.until.getTime() - yesterday.since.getTime(), 24 * 60 * 60 * 1000);

    // `오늘` 은 아직 끝나지 않았다 — 상한이 자정이면 미래 기사까지 허용하는 창이 된다.
    const today = resolveNewsRecency("오늘 LG 소식 알려줘", NOW_MS);
    assert.ok(today.kind === "fresh");
    assert.equal(today.since.toISOString(), "2026-08-07T15:00:00.000Z");
    assert.equal(today.until.getTime(), NOW_MS, "오늘 상한은 현재 시각이어야 한다");

    // 그저께 = 이틀 전 하루.
    const before = resolveNewsRecency("그저께 LG 무슨 일 있었어?", NOW_MS);
    assert.ok(before.kind === "fresh");
    assert.equal(before.since.toISOString(), "2026-08-05T15:00:00.000Z");
    assert.equal(before.until.toISOString(), "2026-08-06T15:00:00.000Z");

    // 세 창이 서로 겹치지 않아야 한다(반열린 구간 계약).
    assert.equal(before.until.getTime(), yesterday.since.getTime());
    assert.equal(yesterday.until.getTime(), today.since.getTime());

    // `요즘/최근` 은 고정 기간 — 날마다 다른 창이면 재현도 감사도 불가능하다.
    const recent = resolveNewsRecency("요즘 LG 어때?", NOW_MS);
    assert.ok(recent.kind === "fresh");
    assert.equal(recent.until.getTime(), NOW_MS);
    assert.equal(
      recent.since.getTime(),
      NOW_MS - NEWS_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      "최근 창이 고정 기간이 아니다",
    );
    // 보유기간(30일)보다 짧아야 한다 — 29일 전 기사가 `요즘` 최상위로 붙으면 최신이 아니다.
    assert.ok(NEWS_RECENT_WINDOW_DAYS < 30);
    ok("최신성 판정 — 어제/오늘/그저께 KST 경계 exact · 창 비겹침 · 최근 고정기간");
  }

  // ── ①-b KST 자정 직전/직후에 `어제` 가 하루씩 밀린다 ───────────────────
  {
    // KST 08-08 23:59:59 → 어제 = 08-07
    const lateNight = Date.parse("2026-08-08T14:59:59.000Z");
    const late = resolveNewsRecency("어제 LG", lateNight);
    assert.ok(late.kind === "fresh");
    assert.equal(late.since.toISOString(), "2026-08-06T15:00:00.000Z");

    // KST 08-09 00:00:00 → 어제 = 08-08 (하루 밀림)
    const justAfter = Date.parse("2026-08-08T15:00:00.000Z");
    const next = resolveNewsRecency("어제 LG", justAfter);
    assert.ok(next.kind === "fresh");
    assert.equal(next.since.toISOString(), "2026-08-07T15:00:00.000Z",
      "KST 자정을 넘겼는데 어제가 안 밀렸다 — UTC 로 계산하고 있다");
    ok("KST 자정 경계 — 자정 직전/직후로 `어제` 가 정확히 하루 밀린다");
  }

  // ── ② 30일 창 밖은 news 가 소유하지 않는다 (삼순 ①) ─────────────────────
  {
    for (const question of [
      "올해 LG 어때?", "이번 시즌 LG 어땠어?", "작년 LG 어땠어?",
      "2024년 LG 어땠어?", "지난달 LG 어땠어?", "지난 시즌 LG 이야기",
    ]) {
      const intent = newsRecencyIntentOf(question, NOW_MS);
      assert.equal(intent.kind, "out_of_window",
        `창 밖 표현이 news 로 갔다: ${question} → ${intent.kind}`);
      assert.equal(resolveRagNewsCandidate(question, NOW_MS), null,
        `창 밖 표현에 news 후보가 생겼다: ${question}`);
    }
    // 창 밖 질문은 실제로 기존 경로(team_rag)로 내려가야 한다.
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "올해 LG 어때?", deps);
    assert.equal(calls.news.length, 0, "창 밖 질문이 기사 검색을 태웠다");
    assert.equal(result.source, "team_rag",
      `창 밖 질문이 기존 경로로 안 갔다: source=${result.source}`);
    ok("30일 창 밖(올해·이번 시즌·작년·연도·월) — news 미소유, 기존 경로 유지");
  }

  // ── ③ 최신성 신호가 없으면 news 로 가지 않는다 ─────────────────────────
  {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
    assert.equal(calls.news.length, 0, "최신성 신호 없는 질문이 기사 경로를 탔다");
    assert.equal(result.source, "team_rag");
    assert.equal(calls.teamSearch, 1, "구단 문서 경로가 죽었다");
    ok("최신성 신호 없음 — team_rag 가 그대로 소유");
  }

  // ── ④ 최신 서술형 질문이 실제로 기사 근거를 읽는다 (원 사고 재현 축) ────
  {
    const { deps, logs, calls } = makeDeps();
    const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
    assert.equal(result.source, "news_rag", `최신 질문이 news_rag 로 안 갔다: ${result.source}`);
    assert.equal(calls.news.length, 1, "기사 검색이 실행되지 않았다");
    assert.equal(calls.news[0].candidate.entityType, "news");
    assert.equal(calls.news[0].candidate.teamId, 1, "teamId 귀속이 틀렸다");
    // 검색 창이 판정 결과와 동일해야 한다 — 여기가 갈라지면 다른 날 기사로 답한다.
    assert.equal(calls.news[0].candidate.since.toISOString(), "2026-08-06T15:00:00.000Z");
    assert.equal(calls.news[0].candidate.until.toISOString(), "2026-08-07T15:00:00.000Z");
    // LLM 에 넘어간 근거가 조회된 기사여야 한다(빈 근거로 호출하는 변종 차단).
    assert.equal(calls.newsLlm.length, 1);
    assert.equal(calls.newsLlm[0].evidence.length, 1);
    assert.equal(calls.newsLlm[0].evidence[0].canonicalUrl, LG_YESTERDAY.canonicalUrl);
    // 기존 경로를 소비하지 않았다.
    assert.equal(calls.genericLlm, 0, "근거가 있는데 generic LLM 을 소비했다");
    assert.equal(calls.teamLlm, 0, "기사 경로가 구단 문서 LLM 까지 태웠다");
    assert.equal(calls.cacheReads, 0, "기사 경로가 global cache 를 읽었다(삼순 ③ cache 0)");
    // 출처 노출 (삼순 ③)
    assert.match(result.answer, /📄 출처: 네이버 스포츠 기사/,
      `기사 근거에 출처가 안 붙었다: ${result.answer}`);
    assert.equal(result.sourceUrl, LG_YESTERDAY.canonicalUrl, "sourceUrl 이 기사 링크가 아니다");
    // 숫자 전면 HOLD — 본문에 숫자가 남으면 언론사 헤드라인 재발행이다.
    assert.ok(!/\d/.test(result.answer.split("📄")[0]),
      `기사 답변 본문에 숫자가 남았다: ${result.answer}`);
    assert.equal(logs.at(-1)?.matchPath, "news_rag");
    ok("최신 서술형 — news 후보 → 기사 근거 조회 → source=news_rag + 출처 + cache 0");
  }

  // ── ⑤ fresh 근거 0건이면 폴백 금지, 명시 fail-close (삼순 ②) ────────────
  {
    const { deps, logs, calls } = makeDeps({ searchNewsRag: async () => [] });
    const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
    assert.equal(result.source, "unsure", `근거 0 인데 폴백했다: source=${result.source}`);
    assert.equal(result.answer, NEWS_UNAVAILABLE_ANSWER);
    // 폴백 금지 — 어느 경로도 소비하지 않아야 한다.
    assert.equal(calls.teamLlm, 0, "근거 0 에서 team_rag 로 폴백했다");
    assert.equal(calls.teamSearch, 0, "근거 0 에서 구단 문서를 뒤졌다");
    assert.equal(calls.genericLlm, 0, "근거 0 에서 generic LLM 으로 폴백했다");
    assert.equal(calls.cacheReads, 0, "근거 0 에서 캐시를 읽었다");
    assert.equal(logs.at(-1)?.matchPath, "unsure");
    ok("fresh 근거 0 — team_rag/generic/cache 폴백 0, 명시 fail-close");
  }

  // ── ⑥ 검색 오류는 "기사 없음" 과 다르다 ────────────────────────────────
  {
    const { deps, logs, calls } = makeDeps({
      searchNewsRag: async () => { throw new Error("rpc down"); },
    });
    const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
    assert.equal(result.source, "error", `검색 오류가 error 로 안 갔다: ${result.source}`);
    // 오류를 "기사 없음" 으로 둔갑시키면 장애가 조용히 정상처럼 보인다.
    assert.notEqual(result.answer, NEWS_UNAVAILABLE_ANSWER,
      "검색 오류와 기사 0건이 같은 답을 낸다 — 장애가 감춰진다");
    assert.equal(calls.teamLlm, 0, "검색 오류에서 폴백했다");
    assert.equal(calls.genericLlm, 0, "검색 오류에서 generic LLM 으로 폴백했다");
    assert.equal(logs.at(-1)?.matchPath, "error");
    ok("검색 오류 — error 로 종결, 기사 0건과 구분, 폴백 0");
  }

  // ── ⑦ 모델이 근거로 답을 못 만들면(INSUFFICIENT) 폴백 금지 ──────────────
  {
    const { deps, calls } = makeDeps({
      callNewsRagLlm: async () => ({
        text: JSON.stringify({ status: "INSUFFICIENT" }), inputTokens: 1, outputTokens: 1,
      }),
    });
    const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
    assert.equal(result.source, "unsure");
    assert.equal(result.answer, NEWS_UNAVAILABLE_ANSWER);
    assert.equal(calls.genericLlm, 0, "INSUFFICIENT 에서 generic LLM 으로 폴백했다");
    assert.equal(calls.teamLlm, 0, "INSUFFICIENT 에서 team_rag 로 폴백했다");
    ok("모델 INSUFFICIENT — 폴백 0, 명시 fail-close");
  }

  // ── ⑧ 숫자 섞인 모델 답은 폐기된다 (tier2 숫자 HOLD) ────────────────────
  //
  // ⚠️ 근거에 **그 숫자가 실제로 적힌** 케이스여야 한다(2026-08-08 false-green 자체발견).
  //   종전 fixture 는 근거 본문에 숫자가 없어서, 숫자 HOLD 를 해제하고 근거 대조 방식
  //   (`numericEvidence:true`)으로 바꿔도 `3대 2` 가 근거에 없어 똑같이 폐기됐다 — 결과가 같으니
  //   게이트는 GREEN. 기사 제목에는 수치가 항상 들어있으므로(`11이닝 무실점`) 실제 상황은
  //   오히려 "근거에 숫자가 있는" 쪽이다. 그걸 그대로 옮기면 언론사 헤드라인 재발행이다.
  {
    const numericEvidence: RagEvidence = {
      ...LG_YESTERDAY,
      content:
        "'11이닝 무실점' 키움 전준표·'20안타' LG 손용준, 프로야구 7월 퓨처스 신인왕\n" +
        "LG 트윈스가 3대 2로 이겼다. 손용준은 20안타를 기록했다.",
    };
    for (const answerText of [
      "LG가 3대 2로 이겼어요.",           // 근거에 그대로 적힌 스코어
      "손용준이 20안타를 기록했어요.",     // 근거에 적힌 기록 수치
    ]) {
      const { deps } = makeDeps({
        searchNewsRag: async () => [numericEvidence],
        callNewsRagLlm: async () => ({
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: answerText }),
          inputTokens: 1, outputTokens: 1,
        }),
      });
      const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
      assert.notEqual(result.source, "news_rag",
        `숫자 섞인 기사 답이 그대로 나갔다: ${answerText}`);
      assert.equal(result.answer, NEWS_UNAVAILABLE_ANSWER);
    }
    // 같은 근거·같은 경로에서 숫자 없는 답은 정상 통과해야 한다 —
    // 안 그러면 "모든 답을 버리는" 구현도 위 assertion 을 통과하므로 검출력이 0 이다.
    {
      const { deps } = makeDeps({
        searchNewsRag: async () => [numericEvidence],
        callNewsRagLlm: async () => ({
          text: JSON.stringify({
            status: RAG_GROUNDED_SENTINEL,
            answer: "키움 전준표와 LG 손용준이 퓨처스 월간 신인왕으로 뽑혔어요.",
          }),
          inputTokens: 1, outputTokens: 1,
        }),
      });
      const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
      assert.equal(result.source, "news_rag",
        "숫자 없는 정상 답까지 버렸다 — 과차단");
    }
    ok("숫자 섞인 답 폐기 — 근거에 적힌 수치도 차단 / 서술답은 통과");
  }

  // ── ⑨ 우선순위 — 수치 질문은 structured 가 소유 (삼순 ①) ───────────────
  {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "어제 LG 순위 몇 위였어?", deps);
    assert.equal(calls.news.length, 0, "수치 질문이 기사 경로를 탔다");
    assert.equal(result.source, "kbo_structured",
      `수치 질문이 structured 로 안 갔다: ${result.source}`);
    assert.ok(calls.standingsFetches > 0, "정본 조회가 실행되지 않았다");
    ok("우선순위 — `어제 LG 순위 몇 위` 는 kbo_structured 정본");
  }

  // ── ⑨-b 수치 가드 3겹을 **후보 단계에서 직접** 확인 ───────────────────
  //
  // ⚠️ 종단 `source` 로만 보면 가드가 죽어도 GREEN 이 된다(2026-08-08 false-green 자체발견).
  //   앞단 종결 라우트(`team_record`·`history_hold`)가 대부분을 먼저 가로채기 때문이다 —
  //   즉 파이프라인 결과는 같은데 **가드만 없어진** 상태가 감지되지 않는다.
  //   그 상태는 앞단 라우팅이 한 줄만 바뀌면 그대로 누수로 변한다.
  //   그래서 판정을 **후보 함수 자체**에서 한다 — 가드가 살아있어야만 null 이 나온다.
  {
    // (1) 값을 묻는 질문(`몇`·`얼마`) — 삼순 ① `어제 LG 몇 대 몇` 이 여기다.
    for (const question of [
      "어제 LG 몇 대 몇이었어?", "어제 LG 몇대몇", "어제 LG 안타 몇 개?",
      "최근 LG 승리 몇 번 했어?", "요즘 LG 관중 얼마나 들어?",
    ]) {
      assert.equal(resolveRagNewsCandidate(question, NOW_MS), null,
        `값을 물은 질문에 기사 후보가 생겼다(숫자 HOLD 경로라 구조적으로 답못함): ${question}`);
    }
    // (2) 지표어 수치 질문 — `isTeamRagServableQuestion` 공유 판정기.
    for (const question of [
      "어제 LG 타율 좋은 팀이야?", "최근 LG 팀타율 얼마야?", "요즘 LG 승률 어때?",
      "어제 LG ops 어때?", "어제 LG 볼넷 얘기", "최근 LG 성적 얘기해줘",
    ]) {
      assert.equal(isTeamRagServableQuestion(question), false,
        `수치 판정기가 이 질문을 서술형으로 봤다: ${question}`);
      assert.equal(resolveRagNewsCandidate(question, NOW_MS), null,
        `지표어 수치 질문에 기사 후보가 생겼다: ${question}`);
    }
    // (3) 답이 정의상 숫자인 명사 — `몇`도 지표어도 없어 앞 두 가드를 둘 다 통과한다.
    for (const question of [
      "어제 LG 스코어 알려줘", "어제 LG 점수 알려줘", "어제 LG 경기 결과 알려줘",
    ]) {
      assert.equal(isTeamRagServableQuestion(question), true,
        `이 질문은 지표어 판정을 통과해야 한다(그래서 전용 가드가 필요하다): ${question}`);
      assert.equal(resolveRagNewsCandidate(question, NOW_MS), null,
        `수치명사 질문에 기사 후보가 생겼다(삼순 ① score 충돌): ${question}`);
    }
    // 과차단 반대가설 — 지표어가 붙어도 **서술**이면 기사가 답해야 한다.
    //   이게 없으면 "전부 null 을 돌려주는" 구현도 위 assertion 을 전부 통과한다(검출력 0).
    for (const question of [
      "어제 LG 무슨 일 있었어?", "어제 LG 홈런 이야기 해줘", "최근 LG 분위기 어때?",
    ]) {
      assert.ok(resolveRagNewsCandidate(question, NOW_MS),
        `서술형 최신 질문이 과차단됐다: ${question}`);
    }
    ok("수치 가드 3겹(값요구·지표어·수치명사) — 후보 단계 직접 판정 / 서술형은 통과");
  }

  // ── ⑩ 우선순위 — 서비스 문의·룰·선수는 기사가 선점하지 않는다 ──────────
  {
    // 서비스 문의 — 최신성 + 구단명이 붙어도 service_redirect 다.
    {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", "어제 LG 앱 로그인 오류 났어", deps);
      assert.equal(result.source, "service_redirect",
        `서비스 문의를 기사가 선점했다: ${result.source}`);
      assert.equal(calls.news.length, 0);
    }
    // 검수 사전 — 사람이 검수한 답이 항상 우선이다.
    {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", "보크가 뭐야?", deps);
      assert.equal(result.source, "dictionary", `검수 사전이 죽었다: ${result.source}`);
      assert.equal(calls.news.length, 0);
    }
    // 룰/용어 — 최신성·구단명이 붙어도 tier1 공식 조문 경로가 소유한다.
    //
    // ⚠️ 종단 `source` 로 판정하지 않는다 — 이 게이트의 `searchOfficialRag` 는 빈 근거를
    //   돌려주므로 결과가 `llm` 로 떨어진다(그게 정상 양보 동작이다). 여기서 보는 건
    //   **기사가 그 앞을 가로채지 않았는가** 이므로 두 경로의 호출 여부를 직접 대조한다.
    {
      const { deps, calls } = makeDeps();
      await answerQuestion("u1", "어제 LG 경기에서 나온 보크가 뭐야?", deps);
      assert.equal(calls.news.length, 0, "룰 질문을 기사가 선점했다");
      assert.ok(calls.officialSearch > 0,
        "룰 질문이 공식 문서 경로를 타지 않았다 — 기사가 앞에서 가로채었거나 라우팅이 깨졌다");
    }
    // 선수 지명 — 선수 경로가 소유한다.
    {
      const player = players.find((entry) => entry.team === "LG");
      assert.ok(player, "LG 소속 선수를 로스터에서 못 찾았다");
      const { deps, calls } = makeDeps();
      await answerQuestion("u1", `어제 ${player.name} 어땠어?`, deps);
      assert.equal(calls.news.length, 0, "선수 지명 질문을 기사가 선점했다");
    }
    ok("우선순위 반대경로 — 서비스문의/룰용어/선수지명 전부 기사 미선점");
  }

  // ── ⑪ 두 구단 비교 질문은 기사 후보가 생기지 않는다 ────────────────────
  {
    assert.equal(resolveRagNewsCandidate("어제 LG랑 두산 중 누가 이겼어?", NOW_MS), null,
      "두 구단 질문에 단일 기사 후보가 생겼다 — 한쪽 기사만 근거로 붙는다");
    assert.equal(resolveRagNewsCandidate("어제 야구 어땠어?", NOW_MS), null,
      "구단 미지명 질문에 후보가 생겼다");
    // 10개 구단 전부 후보가 나오고 teamId 가 서로 달라야 한다.
    const names = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];
    const ids = new Set<number>();
    for (const name of names) {
      const candidate = resolveRagNewsCandidate(`어제 ${name} 무슨 일 있었어?`, NOW_MS);
      assert.ok(candidate, `${name} 기사 후보가 없다`);
      ids.add(candidate.teamId);
    }
    assert.equal(ids.size, 10, "구단 teamId 는 10개 서로 달라야 한다");
    ok("후보 해석 — 비교/미지명 거절 · 10구단 teamId 유일");
  }

  // ── ⑫ kill-switch 를 끄면 기존 경로로 내려간다 ─────────────────────────
  {
    const { deps, calls } = makeDeps({ enableNewsRag: false });
    const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
    assert.equal(calls.news.length, 0, "kill-switch OFF 인데 기사 검색이 돌았다");
    assert.equal(result.source, "team_rag",
      `kill-switch OFF 시 기존 경로로 안 내려갔다: ${result.source}`);
    ok("kill-switch — OFF 시 기사 경로 우회, 기존 경로 정상");
  }

  // ── ⑬ match_path 등록 4곳 (삼순 ③) ─────────────────────────────────────
  {
    // (1) reply_kind 매핑 — `satisfies` 로 컴파일 강제되지만 값도 확인한다.
    assert.equal(MATCH_PATH_REPLY_KIND.news_rag, "answer");
    assert.equal(replyKindForMatchPath("news_rag"), "answer",
      "news_rag 가 unavailable 로 떨어지면 마스코트가 `모르겠어요` 표정으로 뜬다");
    // (2) 피드백 대상 — 근거 기반 답변이므로 👍/👎 가 붙어야 한다.
    assert.ok((FEEDBACK_ELIGIBLE_MATCH_PATHS as readonly string[]).includes("news_rag"),
      "news_rag 답변에서 피드백 버튼이 사라진다(#1118 회귀)");
    // (3) DB CHECK — migration 이 없으면 INSERT 가 제약 위반으로 전량 실패한다.
    const migrationsDir = path.join(process.cwd(), "supabase/migrations");
    const checkSql = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(path.join(migrationsDir, name), "utf8"))
      // match_path CHECK 를 건드리는 migration 중 **가장 마지막 것**이 최종 상태다.
      .filter((sql) => sql.includes("ADD CONSTRAINT genius_question_logs_match_path_check"))
      .at(-1);
    assert.ok(checkSql, "match_path CHECK migration 을 못 찾았다");
    // ⚠️ 파일 전체가 아니라 **`IN (...)` 목록만** 떼어 대조한다(2026-08-08 false-green 자체발견).
    //   파일 전체를 검사하면 첫 줄 주석(match_path='news_rag')이 정규식을 만족시켜, 정작 CHECK 에서
    //   그 라벨을 지워도 GREEN 이 된다 — **주석이 게이트를 통과시키는** 형태다.
    //   주석은 DB 제약을 만들지 않는다. 판정은 실제 제약 목록에서만 한다.
    const constraintBody = checkSql.slice(
      checkSql.indexOf("ADD CONSTRAINT genius_question_logs_match_path_check"),
    );
    const inList = constraintBody.match(/match_path IN \(([\s\S]*?)\n\s*\)/);
    assert.ok(inList, "CHECK 의 match_path IN (...) 목록을 못 찾았다");
    // 주석을 제거한 범위에서만 라벨을 센다.
    const labels = inList[1].replace(/--[^\n]*/g, "");
    assert.ok(/'news_rag'/.test(labels),
      "최종 match_path CHECK 목록에 news_rag 가 없다 — 기사 답변 INSERT 가 전량 실패한다");
    // 기존 라벨이 지워지지 않았는지도 본다(CHECK 를 통째로 갈아끼우는 방식이라).
    for (const label of ["'team_rag'", "'rag'", "'kbo_structured'", "'player_picker'", "'ack'"]) {
      assert.ok(labels.includes(label), `기존 match_path 라벨이 사라졌다: ${label}`);
    }
    // 코드가 기록하는 모든 MatchPath 가 CHECK 에 있는가 — 새 경로를 추가하고 migration 을
    // 빔뜨리면 그 경로의 답변이 전량 pipeline_failed 로 떨어진다(2026-08-03 실제 사고).
    for (const matchPath of Object.keys(MATCH_PATH_REPLY_KIND)) {
      assert.ok(labels.includes(`'${matchPath}'`),
        `코드의 MatchPath 가 DB CHECK 에 없다: ${matchPath}`);
    }
    // (4) source_kind 등급 — 기사는 tier2 고정이다.
    assert.equal(gradeForSourceKind("news_article"), "tier2",
      "기사가 tier1 이면 숫자 허용 계약이 깨진다");
    ok("등록 4곳 — reply_kind / 피드백 / DB CHECK / source_grade");
  }

  // ── ⑭ 출처 allowlist — 네이버 호스트만, 임의 외부 주소는 거절 ───────────
  {
    // 실제 적재분에 존재하는 3개 호스트가 전부 통과해야 한다(2026-08-08 실측 분포).
    for (const host of ["m.sports.naver.com", "n.news.naver.com", "m.entertain.naver.com"]) {
      const { deps } = makeDeps({
        searchNewsRag: async () => [{
          ...LG_YESTERDAY,
          canonicalUrl: `https://${host}/kbaseball/article/109/0005585034`,
        }],
      });
      const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
      assert.equal(result.source, "news_rag");
      assert.match(result.answer, /📄 출처: 네이버 스포츠 기사/, `${host} 출처가 안 붙었다`);
    }
    // allowlist 밖은 출처를 지어내지 않는다 — 표기 자체를 붙이지 않는다.
    {
      const { deps } = makeDeps({
        searchNewsRag: async () => [{ ...LG_YESTERDAY, canonicalUrl: "https://evil.example.com/a" }],
      });
      const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
      assert.equal(result.source, "news_rag");
      assert.doesNotMatch(result.answer, /📄 출처/,
        "allowlist 밖 URL 에 출처가 붙었다 — 출처를 지어내는 것이다");
      assert.equal(result.sourceUrl, undefined);
    }
    // 서브도메인 위조 차단 — `naver.com.evil.com` 류.
    {
      const { deps } = makeDeps({
        searchNewsRag: async () => [{
          ...LG_YESTERDAY,
          canonicalUrl: "https://n.news.naver.com.evil.com/a",
        }],
      });
      const result = await answerQuestion("u1", "어제 LG 무슨 일 있었어?", deps);
      assert.doesNotMatch(result.answer, /📄 출처/, "서브도메인 위조가 allowlist 를 통과했다");
    }
    ok("출처 allowlist — 네이버 3호스트 통과 / 외부·위조 거절 / 지어내기 0");
  }

  // ── ⑮ 기사 근거는 나무위키 정제 대상이 아니다 ──────────────────────────
  {
    // 나무위키 크롬 정제기가 기사 발췌를 먹으면 근거가 통째로 사라진다.
    const newsWithDomainish: RagEvidence = {
      ...LG_YESTERDAY,
      content: "LG 트윈스 관련 소식이 전해졌다.\nnews.naver.com\n젊은 타자들이 활약했다.",
    };
    const selected = selectEvidence([newsWithDomainish]);
    assert.equal(selected.length, 1, "기사 근거가 정제로 통째로 탈락했다");
    assert.match(selected[0].content, /젊은 타자들이 활약했다/,
      "나무위키 광고 정제가 기사 본문을 먹었다");
    ok("기사 근거 — 나무위키 전용 정제 미적용(본문 보존)");
  }

  // ── ⑯ 프롬프트 계약 — 기사 전용이고 숫자 금지를 말한다 ─────────────────
  {
    assert.ok(RAG_NEWS_SYSTEM_PROMPT.includes("숫자를 쓰지 않는다"),
      "프롬프트가 숫자 금지를 말하지 않으면 모델 답이 매번 폐기돼 INSUFFICIENT 로 샌다");
    assert.ok(/비신뢰 참고 데이터/.test(RAG_NEWS_SYSTEM_PROMPT),
      "근거를 비신뢰 데이터로 프레이밍하지 않으면 프롬프트 인젝션에 열린다");
    assert.ok(/INSUFFICIENT/.test(RAG_NEWS_SYSTEM_PROMPT));
    // 구단 문서 프롬프트를 재사용하면 모델이 사건 서술을 범위 밖으로 오판한다.
    assert.ok(!RAG_NEWS_SYSTEM_PROMPT.includes("구단 소개 도우미"),
      "기사 경로가 구단 문서 프롬프트를 쓰고 있다");
    ok("프롬프트 — 기사 전용 · 숫자 금지 · 비신뢰 프레이밍 · INSUFFICIENT 계약");
  }

  // ── ⑰ 수치 안내문과 기사 안내문이 서로 다르다 ──────────────────────────
  {
    // 같은 문자열이면 유저가 "범위 밖" 과 "그날 기사 없음" 을 구분할 수 없다.
    assert.notEqual(NEWS_UNAVAILABLE_ANSWER, TEAM_STAT_HOLD_ANSWER);
    assert.ok(!/야구 룰|용어만/.test(NEWS_UNAVAILABLE_ANSWER),
      "기사 안내문이 `룰/용어만 답한다` 고 말한다 — 거짓말이다");
    ok("안내문 — 기사 미확보와 수치 HOLD 를 구분");
  }

  console.log(
    `\n✅ news RAG wiring contract: ${passed} PASS ` +
    `(경계/창밖/미신호/근거조회/fail-close/오류/INSUFFICIENT/숫자/우선순위×2/후보/kill-switch/등록4곳/출처/정제/프롬프트/안내문)`,
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
