/**
 * 구단 RAG 배선 종단 계약 — **`answerQuestion()` 실제 실행 결과**로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-05 production 실측).
 *
 * `genius_rag_serving_chunks` 에 `entity_type='team'` chunk 가 **71,531건** 적재돼 있는데
 * 전용 계정 QA 에서 `LG 트윈스 역사 알려줘` 가 `source=llm` 로 나왔다. 즉 답이 맞아
 * 보였던 것은 모델이 원래 알던 것이지 우리 근거를 읽은 게 아니었다.
 *
 * 원인은 **배선 결손**이었다:
 *   · `searchRag` 시그니처가 `RagPlayerCandidate` 만 받았다(`pipeline.ts`)
 *   · `entityType:"team"` 후보를 만드는 코드가 `src/lib/baseball-qa/` 에 0건이었다
 *     (corpus 적재 쪽에만 team 귀속 로직이 있었다)
 *
 * 그래서 이 게이트는 "team 코드가 존재한다"가 아니라 **유저가 받는 `source` 가 `rag` 인가**를
 * 본다. 소스 정규식·중간 라벨은 배선이 끊겨도 GREEN 이 되므로 쓰지 않는다.
 *
 * 고정하는 계약 5가지:
 *   ① 구단 서술형 질문은 적재된 근거를 읽어 `source=rag` 로 답하고 출처를 붙인다.
 *   ② 우리가 **서빙하는** 수치(순위·승패·팀타율)는 여전히 `kbo_structured` 정본이 이긴다.
 *      tier2 가 그걸 덮으면 §12 수치 계약 위반이다.
 *   ③ **tier2 숫자 출력은 전면 HOLD** (삼순 2026-08-07 P0-2). 근거에 적힌 숫자만 허용하는
 *      토큰 대조로는 "근거가 그렇게 진술했는가"를 못 가린다 — chunk 단위·문장 단위 둘 다
 *      반대가설이 나왔다. 선수 tier2 와 같은 계약(숫자 섞이면 폐기)으로 되돌렸다.
 *   ④ 근거 0건이면 fail-close 가 아니라 **기존 경로로 양보**한다(구단 과차단 회귀 금지 — #1100 P0-1).
 *   ⑤ 후보 해석이 `resolveMentionedTeam` 과 같은 판정기를 쓴다(두 구단 질문은 근거 검색 0회).
 *
 * 실행: npm run qa:team-rag-wiring
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  isTeamRagServableQuestion,
  resolveRagTeamCandidate,
  TEAM_STAT_HOLD_ANSWER,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import {
  RAG_EVIDENCE_MAX_CHARS,
  RAG_GROUNDED_SENTINEL,
  sanitizeEvidenceContent,
  selectEvidence,
  stripNamuDocumentChrome,
  type RagEntityCandidate,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

/** 로스터는 **실제 배포 함수**로 읽는다 — 자체 fixture 는 loader 결함을 GREEN 으로 만든다. */
let players: PlayerRef[] = [];

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["balk"], answer: "투수의 부정 투구 동작이에요." },
];

/**
 * 구단 근거 fixture.
 *
 * ⚠️ 내용은 production 에 실제로 적재된 나무위키 LG 문서 서술을 축약한 것이다.
 * `canonicalUrl` 은 출처 allowlist(`genius-reply-provenance`)를 통과해야 하므로
 * 실제 나무위키 URL 형식을 그대로 쓴다 — 가짜 URL 을 쓰면 출처가 안 붙는 것이
 * 정상 동작인데 게이트는 그걸 결함으로 오판한다.
 */
const LG_EVIDENCE: RagEvidence = {
  content:
    "LG 트윈스는 1990년 MBC 청룡을 인수해 창단했다. 창단 첫 해 한국시리즈에서 삼성 라이온즈를 " +
    "꺾고 우승했고, 1994년에도 태평양 돌핀스를 상대로 우승하며 신바람 야구로 불렸다.",
  pageTitle: "LG 트윈스",
  canonicalUrl: "https://namu.wiki/w/LG%20%ED%8A%B8%EC%9C%88%EC%8A%A4",
  revision: "etag:lg-history",
  sectionPath: "LG 트윈스/역사",
  asOf: "2026-08-05",
  sourceGrade: "tier2",
};

/** 우승 횟수 서술이 실제로 담긴 근거(삼성 문서 원문 형태). */
const SAMSUNG_TITLE_EVIDENCE: RagEvidence = {
  content: "삼성 라이온즈의 통산 한국시리즈 우승 횟수는 총 8회다.",
  pageTitle: "삼성 라이온즈",
  canonicalUrl: "https://namu.wiki/w/%EC%82%BC%EC%84%B1%20%EB%9D%BC%EC%9D%B4%EC%98%A8%EC%A6%88",
  revision: "etag:samsung-title",
  sectionPath: "삼성 라이온즈/우승",
  asOf: "2026-08-05",
  sourceGrade: "tier2",
};

interface Calls {
  search: RagEntityCandidate[];
  /** 구단 RAG LLM 호출 — 질문과 **실제로 넘어간 근거**를 그대로 보관한다. */
  teamLlm: { question: string; evidence: RagEvidence[] }[];
  genericLlm: number;
  cacheReads: number;
  standingsFetches: number;
  /** 공식 간행물(tier1) 근거 조회 횟수 — 룰/용어 경로가 살아있는지 본다. */
  officialSearch: number;
  /** 선수 RAG LLM 호출 횟수 — 선수 경로가 구단에 선점당하지 않았는지 본다. */
  playerLlm: number;
}

function makeDeps(overrides: Partial<QaDeps> = {}): {
  deps: QaDeps;
  logs: { matchPath: string; answer: string | null }[];
  calls: Calls;
} {
  const logs: { matchPath: string; answer: string | null }[] = [];
  const calls: Calls = {
    search: [], teamLlm: [], genericLlm: 0, cacheReads: 0, standingsFetches: 0,
    officialSearch: 0, playerLlm: 0,
  };
  const deps: QaDeps = {
    enablePlayerRag: true,
    enableTeamRag: true,
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
    searchRag: async (candidate) => {
      calls.search.push(candidate);
      if (candidate.entityType !== "team") return [];
      return candidate.name === "삼성" ? [SAMSUNG_TITLE_EVIDENCE] : [LG_EVIDENCE];
    },
    callTeamRagLlm: async (question, evidence) => {
      calls.teamLlm.push({ question, evidence });
      // ⚠️ tier2 숫자 HOLD 계약이라 모델도 숫자 없이 서술한다.
      //   숫자가 섞인 답은 출력 가드가 폐기하므로, 그건 아래 전용 케이스에서 따로 본다.
      const usesSamsung = evidence.some((row) => row.pageTitle === "삼성 라이온즈");
      return {
        text: JSON.stringify({
          status: RAG_GROUNDED_SENTINEL,
          answer: usesSamsung
            ? "삼성 라이온즈는 한국시리즈 우승 경험이 많은 구단이에요."
            : "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이에요.",
        }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    // ⚠️ 선수·공식 경로를 throw 로 막으면 "구단 RAG 가 그 경로를 선점했는가"를 아예 못 본다.
    //   삼순 2026-08-07 P0-1 은 바로 그 반대경로가 게이트에 없어서 GREEN 이었던 건이라,
    //   여기서는 **정상 동작하는 경로**로 두고 호출 횟수를 센다.
    callRagLlm: async () => {
      calls.playerLlm++;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "선수 경로 답변이에요." }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    searchOfficialRag: async () => { calls.officialSearch++; return []; },
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식 조문 답변이에요." }),
      inputTokens: 1,
      outputTokens: 1,
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async (entry) => { logs.push({ matchPath: entry.matchPath, answer: entry.answer }); },
    fetchTeamRecord: {
      // ⚠️ 필드명은 `/api/standings` 응답 그대로여야 한다(`ranking`, `teamName`).
      // `rank` 로 쓰면 정본 조회가 missing 으로 떨어져 안내문이 나간다.
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

  // ── ① 후보 해석 계약 ────────────────────────────────────────────────────
  {
    const lg = resolveRagTeamCandidate("LG 트윈스 역사 알려줘");
    assert.ok(lg, "구단이 지명된 질문은 team 후보가 나와야 한다");
    assert.equal(lg.entityType, "team");
    assert.equal(lg.name, "LG");
    // entityId 는 corpus 귀속과 같은 teamId 문자열이어야 한다.
    assert.equal(lg.entityId, "1");
    assert.equal(lg.sourceKey, "namu:team:1");

    // 붙여쓴 풀네임도 같은 후보로 해석돼야 한다(#1100 원 사고 축).
    assert.deepEqual(resolveRagTeamCandidate("LG트윈스의 역사"), lg);

    // 10개 구단 전부 후보가 나오고 sourceKey 가 중복되지 않아야 한다.
    const names = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];
    const keys = new Set<string>();
    for (const name of names) {
      const candidate = resolveRagTeamCandidate(`${name} 어떤 팀이야?`);
      assert.ok(candidate, `${name} 후보가 없다`);
      keys.add(candidate.sourceKey);
    }
    assert.equal(keys.size, 10, "구단 sourceKey 는 10개 서로 달라야 한다");

    // 두 구단 비교 질문은 단일 entity 로 답할 수 없다.
    assert.equal(resolveRagTeamCandidate("LG랑 두산 중 누가 더 잘해?"), null);
    // 존재하지 않는 교차 조합은 구단이 아니다.
    assert.equal(resolveRagTeamCandidate("LG라이온즈 역사"), null);
    ok("구단 후보 해석 — teamId 귀속 / 붙여쓰기 / 10구단 / 비교·교차조합 거절");
  }

  // ── ② 서술형 구단 질문이 실제로 근거를 읽는다 (원 사고 재현 축) ─────────
  {
    const { deps, logs, calls } = makeDeps();
    const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
    assert.equal(result.source, "rag", `구단 서술형이 rag 로 안 갔다: source=${result.source}`);
    assert.equal(calls.genericLlm, 0, "근거가 있으면 generic LLM 을 소비하지 않는다");
    assert.equal(calls.search.length, 1);
    assert.equal(calls.search[0].entityType, "team");
    assert.equal(calls.search[0].entityId, "1");
    assert.equal(calls.teamLlm.length, 1);
    // LLM 에 넘어간 근거가 조회된 구단 문서여야 한다(빈 근거로 호출하는 변종 차단).
    assert.equal(calls.teamLlm[0].evidence.length, 1);
    assert.equal(calls.teamLlm[0].evidence[0].pageTitle, "LG 트윈스");
    // 답변 본문에 숫자가 없어야 한다(tier2 숫자 HOLD). 출처 표기는 본문 밖이라 제외한다.
    assert.ok(!/\d/.test(result.answer.split("📄")[0]),
      `tier2 답변 본문에 숫자가 남았다: ${result.answer}`);
    assert.match(result.answer, /📄 출처: 나무위키/, "tier2 근거는 출처가 붙어야 한다");
    assert.equal(result.sourceUrl, LG_EVIDENCE.canonicalUrl);
    assert.equal(logs.at(-1)?.matchPath, "rag");
    ok("구단 서술형 — team 후보로 근거 조회 → source=rag + 출처 표기");
  }

  // 붙여쓰기 표기도 같은 경로여야 한다.
  {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "LG트윈스 창단 이야기 알려줘", deps);
    assert.equal(result.source, "rag");
    assert.equal(calls.search[0]?.entityId, "1");
    ok("붙여쓴 구단명 — 동일 근거 경로");
  }

  // ── ③ 서빙 정본 수치는 tier2 가 이기지 못한다 (§12) ─────────────────────
  {
    for (const question of ["LG 지금 몇 위야?", "LG 팀타율 알려줘", "LG 몇 승 했어?"]) {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", question, deps);
      assert.equal(result.source, "kbo_structured", `${question} → ${result.source}`);
      assert.equal(calls.search.length, 0, `${question}: 정본이 있는 수치는 RAG 를 타면 안 된다`);
      assert.equal(calls.teamLlm.length, 0);
      assert.ok(calls.standingsFetches > 0, "정본 조회가 실제로 일어나야 한다");
    }
    ok("서빙 정본 수치 — kbo_structured 우선 / tier2 조회 0회");
  }

  // ── ④ tier2 숫자 출력 전면 HOLD (삼순 2026-08-07 P0-2) ─────────────────
  //
  // ⚠️ 여기가 이번 라운드의 핵심 계약이다. 종전에는 "근거에 적힌 숫자면 통과"였는데,
  //   그건 **근거가 그 관계를 진술했는가**를 못 가린다. 범위를 두 번 좁혔지만 두 번 다
  //   반대가설이 나왔다:
  //     · chunk 단위 → 한 chunk 안의 `1990년`·`3회` 를 조합한 새 주장이 통과
  //     · 문장 단위 → `LG는 1990년 창단했고, 통산 우승은 3회다.` 한 문장이면 똑같이 통과
  //   토큰 대조로 닫힐 문제가 아니라서, 선수 tier2 와 같은 계약(숫자 섞이면 폐기)으로 되돌린다.
  //
  //   아래 케이스들은 **삼순이 제시한 반대가설 원문 그대로**를 fixture 로 쓴다.
  //   내가 만든 형태(마침표로 갈라놓은 두 문장)만 넣으면 같은 사고가 또 통과한다.
  {
    // ④-1 삼순 반대가설 A — 한 문장 안에 쉼표/접속사로 두 사실이 붙어 있는 근거.
    //     이 fixture 는 직전 exact(문장 단위 검사)에서 **통과했다**. 지금은 거절돼야 한다.
    const COMMA_CHUNK: RagEvidence = {
      ...LG_EVIDENCE,
      content: "LG는 1990년 창단했고, 통산 우승은 3회다.",
      sectionPath: "LG 트윈스/역사",
    };
    const { deps, logs, calls } = makeDeps({
      searchRag: async (candidate) => {
        calls.search.push(candidate);
        return candidate.entityType === "team" ? [COMMA_CHUNK] : [];
      },
      callTeamRagLlm: async (question, evidence) => {
        calls.teamLlm.push({ question, evidence });
        return {
          // 두 사실을 이어붙인 관계 주장. 숫자는 둘 다 근거 한 문장 안에 있다.
          text: JSON.stringify({
            status: RAG_GROUNDED_SENTINEL,
            answer: "LG는 1990년에 3회째 우승했어요.",
          }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    const result = await answerQuestion("u1", "LG 우승 몇 번 했어?", deps);
    assert.notEqual(result.source, "rag",
      "한 문장 안 쉼표로 붙은 두 사실을 조합한 주장이 rag 로 나갔다(삼순 반대가설 A)");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("삼순 반대가설 A — 단일 문장 쉼표/접속사 조합 주장 거절");
  }

  {
    // ④-2 근거에 **그대로 적힌** 숫자여도 tier2 면 내보내지 않는다.
    //     종전 계약에서는 이게 정상 통과였다. HOLD 로 바뀐 것을 여기서 고정한다.
    const { deps, logs } = makeDeps({
      callTeamRagLlm: async () => ({
        // 삼성 근거 원문에 `8회` 가 실제로 있다. 그래도 폐기돼야 한다.
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "삼성은 통산 8회 우승했어요." }),
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    const result = await answerQuestion("u1", "삼성 우승 몇 번 했어?", deps);
    assert.notEqual(result.source, "rag",
      "근거에 적힌 숫자라도 tier2 는 내보내지 않는다(숫자 HOLD)");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("tier2 숫자 HOLD — 근거에 적힌 값이어도 답변으로 안 나간다");
  }

  {
    // ④-3 지어낸 숫자는 당연히 거절 (종전 계약도 유지).
    const { deps, logs } = makeDeps({
      callTeamRagLlm: async () => ({
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "삼성은 통산 12회 우승했어요." }),
        inputTokens: 10,
        outputTokens: 5,
      }),
    });
    const result = await answerQuestion("u1", "삼성 우승 몇 번 했어?", deps);
    assert.notEqual(result.source, "rag", "근거 밖 숫자가 rag 답변으로 나갔다");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("미서빙 수치 환각 — 근거 밖 숫자는 답변 거절 후 안내");
  }

  {
    // ④-4 반대편 고정 — 숫자만 막는 것이지 **서술형 경로 자체를 죽이면 안 된다**.
    //     이 단언이 없으면 "구단 RAG 통째로 끄기"로도 위 세 케이스가 GREEN 이 된다.
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "삼성 어떤 팀이야?", deps);
    assert.equal(result.source, "rag", "숫자 HOLD 가 서술형 경로까지 죽였다");
    assert.equal(calls.teamLlm.length, 1);
    assert.ok(!/\d/.test(result.answer.split("📄")[0]), "본문에 숫자가 남았다");
    ok("숫자 HOLD 는 서술형을 막지 않는다 — 숫자 없는 답변은 그대로 서빙");
  }

  // ── ④-b 교차 chunk 조합도 당연히 거절 (숫자 HOLD 의 부분집합) ────────────
  //
  // ⚠️ 이 케이스는 종전 `requireSingleSource` 계약이 노렸던 것이다. 지금은 숫자 자체를
  //   막으므로 자동으로 닫히지만, **회귀 감시용으로 남긴다** — 나중에 누가 숫자를 다시
  //   열 때 이 케이스가 가장 먼저 깨져야 한다.
  {
    const YEAR_CHUNK: RagEvidence = {
      ...LG_EVIDENCE,
      content: "LG 트윈스는 1994년 태평양 돌핀스를 꺾고 한국시리즈에서 우승했다.",
      sectionPath: "LG 트윈스/1994년",
    };
    const COUNT_CHUNK: RagEvidence = {
      ...LG_EVIDENCE,
      content: "LG 트윈스의 통산 한국시리즈 우승 횟수는 총 3회다.",
      sectionPath: "LG 트윈스/우승",
    };
    const { deps, logs, calls } = makeDeps({
      searchRag: async (candidate) => {
        calls.search.push(candidate);
        return candidate.entityType === "team" ? [YEAR_CHUNK, COUNT_CHUNK] : [];
      },
      callTeamRagLlm: async (question, evidence) => {
        calls.teamLlm.push({ question, evidence });
        return {
          text: JSON.stringify({
            status: RAG_GROUNDED_SENTINEL,
            answer: "LG 트윈스는 1994년에 통산 3회째 우승을 달성했어요.",
          }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    const result = await answerQuestion("u1", "LG 우승 몇 번 했어?", deps);
    assert.notEqual(result.source, "rag",
      "여러 chunk 의 숫자를 조합한 주장이 rag 답변으로 나갔다");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("교차 chunk 조합 — 여러 근거를 이어붙인 수치 주장 거절");
  }

  // ── ⑤ 근거 0건은 fail-close 가 아니라 양보 (#1100 P0-1 회귀 금지) ────────
  {
    const { deps, calls } = makeDeps({ searchRag: async (candidate) => { calls.search.push(candidate); return []; } });
    const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
    assert.notEqual(result.source, "blocked", "근거 0건이 구단 과차단으로 퇴행했다");
    assert.notEqual(result.source, "history_hold");
    assert.equal(calls.genericLlm, 1, "근거가 없으면 기존 LLM 경로로 내려가야 한다");
    ok("근거 0건 — 차단 아닌 기존 경로 양보 (구단 과차단 회귀 금지)");
  }

  // 미서빙 수치도 근거가 없으면 종전 안내문 그대로다.
  {
    const { deps, logs } = makeDeps({ searchRag: async () => [] });
    const result = await answerQuestion("u1", "한화 우승 몇 번 했어?", deps);
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("미서빙 수치 + 근거 0건 — 종전 안내문 유지");
  }

  // ── ⑥ 플래그가 꺼지면 배선 이전 동작 그대로 ─────────────────────────────
  {
    const { deps, calls } = makeDeps({ enableTeamRag: false });
    const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
    assert.equal(calls.search.length, 0, "플래그 off 에서 구단 근거를 읽으면 안 된다");
    assert.equal(calls.teamLlm.length, 0);
    assert.notEqual(result.source, "rag");
    ok("enableTeamRag=false — 종전 동작 유지");
  }

  // ── ⑦ 서술/수치 판정기 단독 계약 (경로 의존 없는 이중 방어) ─────────────
  {
    for (const question of ["LG 트윈스 역사 알려줘", "두산 어떤 팀이야?", "한화 응원 분위기 어때?"]) {
      assert.equal(isTeamRagServableQuestion(question), true, `${question} 는 서술형이다`);
    }
    for (const question of ["LG 몇 위야?", "삼성 팀타율 얼마야?", "두산 홈런 몇 개야?", "KIA 승률 알려줘"]) {
      assert.equal(isTeamRagServableQuestion(question), false, `${question} 는 수치 질문이다`);
    }
    ok("서술/수치 판정 — 라우팅과 독립적으로도 수치가 tier2 로 새지 않는다");
  }

  // ── ⑧ 비구단 질문은 이 경로를 타지 않는다 ───────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await answerQuestion("u1", "보크가 뭐야?", deps);
    assert.equal(calls.search.filter((c) => c.entityType === "team").length, 0);
    ok("룰 질문 — 구단 근거 조회 0회");
  }

  // ── ⑧-b 라우팅 역전 금지 — 구단명이 붙었다고 남의 경로를 선점하면 안 된다 ──
  //
  // ⚠️ 삼순 2026-08-07 P0-1. 종전에는 team RAG 블록이 종결 라우트보다 **먼저**
  //   실행돼, 구단명 하나만 붙어있으면 blocked·service_redirect·선수 RAG·공식 RAG
  //   질문까지 전부 구단 문서로 답할 수 있었다.
  //
  //   그런데 이전 17 PASS 는 이 반대경로를 **한 번도 안 태워서** GREEN 이었다.
  //   게이트가 자기가 만든 경로만 확인한 전형적인 false-green 이다.
  //   그래서 여기서는 **구단명이 붙은 다른 경로 질문 4종**을 실제로 태워
  //   `source` 와 구단 근거 조회 횟수를 둘 다 고정한다.
  //
  //   근거는 항상 있는 상태(`makeDeps` 기본 `searchRag` 는 team 이면 근거를 돌려준다)라,
  //   순서가 되돌려지면 즉시 RED 가 된다.
  {
    const reversals: { question: string; source: string; label: string }[] = [
      { question: "LG 날씨 알려줘", source: "blocked", label: "범위 밖" },
      { question: "LG 앱 로그인 오류", source: "service_redirect", label: "서비스 문의" },
    ];
    for (const { question, source, label } of reversals) {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", question, deps);
      assert.equal(result.source, source,
        `${question}: ${label} 질문을 구단 RAG 가 선점했다 (source=${result.source})`);
      assert.equal(calls.search.filter((c) => c.entityType === "team").length, 0,
        `${question}: 종결 라우트 질문인데 구단 근거를 조회했다`);
      assert.equal(calls.teamLlm.length, 0, `${question}: 구단 RAG LLM 을 소비했다`);
    }

    // 선수가 지명된 질문은 선수 경로가 소유한다 — 구단 문서로 답하면 동문서답이다.
    {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", "LG 문보경 별명이 뭐야?", deps);
      assert.equal(calls.search.filter((c) => c.entityType === "team").length, 0,
        "선수 질문을 구단 RAG 가 선점했다");
      assert.equal(calls.teamLlm.length, 0, "선수 질문에 구단 RAG LLM 을 소비했다");
      assert.notEqual(result.source, "rag",
        "구단 근거로 선수 질문을 답했다(근거는 있지만 동문서답이다)");
    }

    // 룰/용어 질문은 tier1 공식 조문 경로가 소유한다. 구단명이 붙어도 마찬가지다 —
    // 공식 근거가 0건이라고 구단 문서로 대신 답하면 `LG 투수 보크 규칙`에
    // LG 구단 문서가 근거로 붙는다.
    {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", "LG 투수 보크 규칙이 뭐야?", deps);
      assert.equal(calls.search.filter((c) => c.entityType === "team").length, 0,
        "룰 질문을 구단 RAG 가 선점했다");
      assert.equal(calls.teamLlm.length, 0, "룰 질문에 구단 RAG LLM 을 소비했다");
      assert.notEqual(result.source, "rag",
        "구단 근거로 룰 질문을 답했다(tier1 조문이 정본이다)");
    }

    // 반대편 고정 — 순서를 뒤로 미룬 것이 구단 서술 경로까지 죽이면 안 된다.
    // 이 단언이 없으면 "team RAG 를 통째로 끄기"로도 위 4종이 GREEN 이 된다.
    {
      const { deps, calls } = makeDeps();
      const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
      assert.equal(result.source, "rag", "역전 방지 때문에 구단 서술 경로까지 죽었다");
      assert.equal(calls.teamLlm.length, 1);
    }
    ok("라우팅 역전 금지 — 구단명이 붙은 blocked/service/선수/룰 질문을 선점하지 않는다");
  }

  // ── ⑧ 근거 위생 — 나무위키 광고·문서 크롬이 근거로 나가면 안 된다 ──────────
  //
  // ⚠️ production 실측 (2026-08-05): `genius_rag_serving_chunks` 의 team chunk 71,531건 중
  //   광고 358 · 네비게이션 2,449건이 **본문에 섞여** 적재돼 있다(player 도 광고 170·네비 1,346).
  //   배선만 열고 이걸 두면 두 가지가 깨진다:
  //     ① 봇이 왁싱·대출 광고를 "근거"로 삼아 답한다
  //     ② 근거 상한(600자)을 쓰레기가 먹어 정작 시즌 내용이 잘린다
  //        (실측: 886자 chunk → sanitize 후 600자가 전부 크롬+광고였다)
  //
  //   fixture 는 **production 원문 그대로**다(LG 트윈스/1997년 chunk 25). 손으로 지어낸
  //   문자열을 쓰면 실제 오염 형태가 바뀌었을 때 게이트가 조용히 GREEN 이 된다.
  {
    const REAL_AD_CHUNK = [
      "LG 트윈스/1997년",
      "최근 수정 시각: 2026-06-19 06:56:38",
      "편집", "토론", "역사",
      "분류LG 트윈스/1997년LG 트윈스/시즌한국프로야구/1997년",
      "더 보기",
      "",
      "1:1 프라이빗 탐나다왁싱",
      "",
      "www.tamnadawaxing.com",
      "",
      "첫 브라질리언 50% 할인 / 개인 샤워실 완비 / 원장 직접 시술 / 무료주차",
      "",
      "산후도우미 신청하기",
      "",
      "onfit.n.wooyupost.com",
      "",
      "산후도우미 신청 방법 졍부지원 복지로 보건소 안내드립니다",
      "  상위 문서: LG 트윈스",
      "",
      "LG 트윈스 1997 시즌 성적",
      "순위", "승", "무", "패", "승률",
      "2 / 8", "73", "2", "51", "0.587",
      "1. 개요",
      "LG 트윈스의 1997 시즌을 정리한 문서.",
      "이광환 감독의 경질로 공석이 된 감독 자리에 천보성 코치가 정식 감독으로 승격했다.",
    ].join("\n");

    const cleaned = sanitizeEvidenceContent(REAL_AD_CHUNK);

    // (a) 광고가 근거에서 사라져야 한다.
    for (const junk of ["왁싱", "브라질리언", "산후도우미", "무료주차", "tamnadawaxing", "wooyupost"]) {
      assert.ok(!cleaned.includes(junk), `광고 문구가 근거로 살아남았다: ${junk}`);
    }
    // (b) 문서 크롬도 마찬가지다.
    for (const chrome of ["최근 수정 시각", "더 보기", "상위 문서"]) {
      assert.ok(!cleaned.includes(chrome), `문서 크롬이 근거로 살아남았다: ${chrome}`);
    }
    // (c) **정작 지켜야 할 야구 본문은 남아야 한다** — 과삭제 금지.
    //     이 반대편 고정이 없으면 "전부 지우기"로도 (a)(b)가 GREEN 이 된다.
    for (const keep of ["1997 시즌", "천보성", "0.587", "73"]) {
      assert.ok(cleaned.includes(keep), `야구 본문이 과삭제됐다: ${keep}`);
    }
    ok("근거 위생 — 실 production 광고/크롬 제거 + 야구 본문 보존");
  }

  // 스탯 표 숫자를 도메인으로 오인하면 안 된다 (자체 적발한 치명 결함).
  // `3.90`·`0.270`·`2026.08.05` 가 도메인으로 잡히면 **앞뒤 줄까지 함께 지워져**
  // 지키려던 기록이 통째로 날아간다. 광고를 지우려다 본문을 지우는 게 더 나쁜 결과다.
  {
    const statLines = ["순위", "3.90", "0.270", "2026.08.05", "1.7", ".270", "73", "0.587"];
    assert.deepEqual(stripNamuDocumentChrome(statLines), statLines,
      "숫자 줄을 도메인으로 오인해 스탯 표를 파괴했다");
    // 반대로 진짜 도메인은 제거되고, 광고 슬롯의 제목·설명(앞뒤 1줄)도 함께 사라진다.
    assert.deepEqual(
      stripNamuDocumentChrome(["LG 트윈스 1997 시즌 성적", "명품시계대출", "blog.naver.com/nicewatch_kr", "당일대출 가능", "천보성 감독"]),
      ["LG 트윈스 1997 시즌 성적", "천보성 감독"],
      "광고 슬롯(제목/도메인/설명)이 통째로 제거돼야 한다",
    );
    ok("도메인 판정 — 스탯 숫자 보존 + 광고 슬롯 3줄 제거");
  }

  // 위생 뒤 남는 게 없는 chunk 는 근거에서 탈락해야 한다(빈 근거로 답하지 않는다).
  {
    const adOnly: RagEvidence = {
      ...LG_EVIDENCE,
      content: ["1:1 프라이빗 탐나다왁싱", "www.tamnadawaxing.com", "첫 브라질리언 50% 할인"].join("\n"),
    };
    assert.deepEqual(selectEvidence([adOnly]), [], "광고뿐인 chunk 가 근거로 선택됐다");
    // 정상 근거는 그대로 선택된다.
    assert.equal(selectEvidence([LG_EVIDENCE]).length, 1);
    ok("광고 전용 chunk — 근거 탈락 (빈 근거 서빙 금지)");
  }

  // 근거 상한을 쓰레기가 먹어치우지 않는지 — 위생 전후 '야구 본문' 확보량 비교.
  {
    const padded = [
      "최근 수정 시각: 2026-06-19 06:56:38", "편집", "토론", "역사", "더 보기",
      "명품시계대출용산전당포", "blog.naver.com/nicewatch_kr", "쉽고 빠른 당일대출 가능해요",
      "용산PC방 쿠팡", "m.coupang.com", "고사양 용산PC방 렉 없이 부드러운 게임",
      "LG 트윈스는 1990년 MBC 청룡을 인수해 창단했으며 창단 첫 해 한국시리즈에서 우승했다.",
    ].join("\n");
    const cleaned = sanitizeEvidenceContent(padded);
    assert.ok(cleaned.includes("1990년"), "상한을 광고가 먹어 본문이 잘렸다");
    assert.ok(cleaned.length <= RAG_EVIDENCE_MAX_CHARS);
    assert.ok(!/대출|쿠팡|PC방/.test(cleaned), "광고 잔존");
    ok("근거 상한 — 광고 제거로 본문 확보");
  }

  console.log(`\n✅ team RAG wiring contract: ${passed} PASS (후보해석 / 근거조회 / 정본우선 / 환각차단 / 양보 / 플래그 / 판정기)`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
