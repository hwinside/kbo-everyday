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
  hasKoreanNumericExpression,
  RAG_GROUNDED_SENTINEL,
  RAG_TEAM_SYSTEM_PROMPT,
  sanitizeEvidenceContent,
  selectEvidence,
  rankEvidenceByQuery,
  shouldStripNamuChrome,
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

  {
    // ④-5 삼순 반대가설 B/C — **한글로 쓴 수치**. 아라비아 숫자가 하나도 없다.
    //
    //     ⚠️ 5라운드 실측(삼순 지적): 아래 3개는 직전 exact 에서 전부 `grounded` 였다.
    //       · `첫 우승`      → `우승` 이 counter 사전에 없어서 통과
    //       · `창단 첫해`    → `해` 가 counter 사전에 없어서 통과
    //       · `통산 팔회`    → `팔` 이 numeral 사전에 없어서 통과
    //     그리고 내가 4라운드에 넣은 `첫 해에 우승 두 번` 은 **`첫 해` 가 아니라 뒤의
    //     `두 번` 때문에** 차단되고 있었다 — 즉 그 케이스는 서수 접두를 검증하지 못했다.
    //     그래서 각 축을 **단독으로** 태우는 fixture 로 바꾼다(다른 축이 대신 잡아주지 않게).
    for (const answer of [
      // 축1: 고유어 수사 + 단위
      "삼성 라이온즈는 한국시리즈에서 여덟 번 우승했어요.",
      "LG 트윈스는 세 번째 우승을 차지한 구단이에요.",
      // 축2: 서수 접두 `첫` 단독 (다른 수치 표현 없음)
      "LG 트윈스는 첫 우승을 차지한 구단이에요.",
      "LG 트윈스는 창단 첫해에 우승했어요.",
      // 축3: 한자 수사 + 단위 (numeral 사전 밖)
      "삼성 라이온즈는 통산 팔회 우승을 기록했어요.",
      "LG 트윈스는 삼연승을 기록했어요.",
      "LG 트윈스는 십년 만의 우승을 했어요.",
      // 축4: **합성 수사** — 6라운드 삼순 지적. 수사 원자 1개만 받으면 전부 빠져나간다.
      //   `열두`·`열한`·`스물두` 는 수사 사이에 한글 경계가 없어 종전 규칙에 안 걸렸고,
      //   `스무` 는 목록에도 없었다. `십팔`·`이십`·`십이` 는 한자 수사 2음절 조합이다.
      "LG 트윈스는 열두 번 우승했어요.",
      "LG 트윈스는 열한 번째 시즌이에요.",
      "LG 트윈스는 스무 번 도전했어요.",
      "LG 트윈스는 스물두 번 우승했어요.",
      "삼성 라이온즈는 십팔회 우승했어요.",
      "삼성 라이온즈는 십이 회 우승이에요.",
      "LG 트윈스는 이십년 만의 우승이에요.",
      // 축5: **미등재 어미** — 조사 사전에 없는 어미가 붙어도 새면 안 된다.
      //   종전 규칙은 단위 뒤 경계를 조사 열거로 처리해서 이게 통과했다.
      //   조사를 더 채우는 대응은 또 유한 사전이라 뒤 경계 요구 자체를 없앴다.
      "삼성 라이온즈는 팔회라고 알려져요.",
      "삼성 라이온즈는 팔회쯤 우승했다고 해요.",
      // 축6: **완전형 수사 + 조사/어미** — 7라운드 삼순 지적.
      //   `하나`·`둘째` 는 단독으로 수사로만 읽히는데 목록에 없거나 뒤 경계에 막혔다.
      //   완전형은 뒤에 무엇이 붙어도 수사이므로 경계를 요구하지 않는 축으로 분리했다.
      "LG 트윈스의 우승컵은 하나뿐이에요.",
      "LG 트윈스는 둘째로 창단한 구단이에요.",
      "LG 트윈스의 우승은 셋이에요.",
      // 축7: **0(영)** — 수사 목록에 아예 없었다. 0 도 수치 주장이다.
      "LG 트윈스의 우승은 영 회예요.",
      // 축8: **한자 단음절 + 넓은 단위 + 공백** — `삼 점`.
      //   좁은 단위 집합에만 의존하면 새고, 넓은 단위를 붙여쓰기까지 허용하면
      //   `이점`(利點)·`이번` 이 죽는다. 그래서 공백을 판별자로 쓴다.
      "LG 트윈스의 점수 차는 삼 점이었어요.",
      "LG 트윈스는 선수가 아홉 명이에요.",
      // 축9: **관형형+완전형 연속 + 어미** — 8라운드 삼순 지적.
      //   `열하나예요` 는 완전형 `하나` 가 앞의 `열` 때문에 앞 경계에 막혀 통과했다.
      "LG 트윈스의 우승은 열하나예요.",
      // 축10: **근사 수량 접미 `여`** — `십여 회` 는 그 자체가 수량 주장이다.
      "LG 트윈스의 우승은 십여 회예요.",
      "LG 트윈스는 이십여 년 역사를 가졌어요.",
      // 축11: **비-ASCII 숫자 표기** — `/\d/` 는 ASCII 만 보므로 전부 통과했다.
      //   전각·로마·원문자로 바꿔 쓰는 것만으로 우회가 됐다.
      "LG 트윈스는 １９９０년에 창단했어요.",
      "LG 트윈스는 Ⅲ회 우승했어요.",
      "LG 트윈스는 ⑧회 우승했어요.",
      "LG 트윈스는 Ⅷ회 우승했어요.",
      // 축12: 한자 수 조합(자리수사 포함) + 단위.
      "LG 트윈스는 삼십사 년 역사를 가졌어요.",
      // 축13: **place+place 조합** — 9라운드 삼순 지적. `digit+place|place+digit` 2음절만
      //   받던 종전 규칙은 `백십`·`십만` 처럼 자리수사끼리 붙은 형태를 놓쳤다.
      "LG 트윈스는 창단 백십 년이에요.",
      "LG 트윈스는 관중이 십만 명이에요.",
      // 축14: **수사 + 서술격 조사** — 단위도 어절 끝도 아니라 어느 축에도 안 걸렸다.
      "LG 트윈스의 우승은 열이에요.",
      "LG 트윈스의 우승은 팔이에요.",
      // 축15: **서술격 활용형** — 10라운드 삼순 지적. 9라운드에 활용형을 열거했더니
      //   목록 밖 활용이 그대로 우회로가 됐다("닫힌 집합" 판단이 틀렸다).
      "LG 트윈스의 우승은 열이라고 해요.",
      "LG 트윈스의 우승은 팔이죠.",
      "LG 트윈스의 관중은 십만이라네요.",
      "LG 트윈스의 우승은 여덟이라고 합니다.",
      // 축16: **단위 allowlist 밖 수량명사** — `관중` 은 단위 목록에 없고 `만명` 은 붙여쓰기다.
      "LG 트윈스는 관중이 만명이에요.",
      "LG 트윈스는 십만 관중이 모였어요.",
      // 축17: 큰 자리수사 뒤에 **단위가 아예 없는** 형태(조사/어절끝만).
      //   ⚠️ 이 축이 없으면 ⑨-a 를 통째로 지워도 게이트가 GREEN 이다 — ⑨-b 가
      //   `관중`·`명` 을 대신 잡아주기 때문이다(자체 mutation M29 로 실측 확인).
      "LG 트윈스는 관중이 십만을 넘었어요.",
      "LG 트윈스 우승 상금은 백만에 달해요.",
    ]) {
      const { deps, logs } = makeDeps({
        callTeamRagLlm: async () => ({
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer }),
          inputTokens: 10,
          outputTokens: 5,
        }),
      });
      const result = await answerQuestion("u1", "삼성 어떤 팀이야?", deps);
      assert.notEqual(result.source, "rag",
        `한글 수사 수치가 rag 로 나갔다(삼순 반대가설 B): ${answer}`);
      assert.equal(logs.at(-1)?.matchPath, "unsure");
    }
    ok("삼순 반대가설 B~H — 한글/비ASCII 수치 16축 단독 차단 (합성·서수·근사`여`·전각·로마·원문자·자리수사조합·서술격활용·큰자리수사 포함)");
  }

  {
    // ④-5b 과차단 반대편 — 숫자 표현이 아닌 정상 구단 서술은 그대로 서빙돼야 한다.
    //
    //     ⚠️ 이게 없으면 "한글이 섞이면 무조건 차단" 같은 극단 변이도 위 3축을 GREEN 으로
    //     만든다. 실제로 자체 검증에서 `이승엽 선수가`(이+승) 가 한자수사+단위로 잡혀
    //     과차단됐고, 뒤 경계를 넣어 고쳤다. 그 회귀를 여기 고정한다.
    for (const answer of [
      "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이에요.",
      "이승엽 선수가 활약한 구단이에요.",
      "두산 베어스와 잠실야구장을 함께 쓰는 구단이에요.",
      "세계적인 선수들이 거쳐간 구단이에요.",
      "사직야구장을 홈으로 쓰는 구단이에요.",
      // 한자 단음절 수사(이/오)가 일상어 앞머리와 겹치는 축. 단위 집합을 넓히면
      // 여기가 통째로 죽는다 — 자체 검증에서 실제로 4건이 과차단됐다.
      "이해하기 쉬운 팀 컬러를 가진 구단이에요.",
      "이번 시즌 상승세를 탄 구단이에요.",
      "오타니와는 무관한 구단이에요.",
      "네이버에서도 화제가 된 구단이에요.",
      // 관형형·충돌형 수사가 일상어 첫 음절과 겹치는 축. 이것들을 완전형에 넣으면
      // 여기가 통째로 죽는다 — `열`(열심히)·`백`(백업)·`천`(천천히)·`이`(이점).
      "열심히 응원하는 팬이 많은 구단이에요.",
      "이점이 많은 전력을 가진 구단이에요.",
      "천천히 성장한 구단이에요.",
      "백업 선수층이 두꺼운 구단이에요.",
      // 8라운드 삼순 지적 — 한자 수사를 **나열**로 두면 수사가 아닌 한자어가 잡힌다.
      //   `이사회` = 이+사+회. 자리수사(십·백·천…)를 필수 성분으로 요구해 닫았다.
      "이사회에서 결정한 구단이에요.",
      "구단 이사회가 열렸어요.",
      // 자리수사 **한 글자**만으로 매칭하면 아래가 전부 죽는다(자체 검증 실측).
      //   `천천히`(천+천) · `백업`(백) · `만루`(만) · `억척`(억)
      "만루 상황에 강한 구단이에요.",
      "억척스러운 팬덤을 가진 구단이에요.",
      // 9라운드 삼순 지적 — 한자 수 조합을 **단독으로** 잡으면 고유명사가 죽는다.
      //   `이만수`(이+만+수) 감독 · `이천`(이+천) 베어스 파크.
      //   수 표기 여부는 **뒤따르는 것이 단위인가**로 가른다: 십만 `명` ✓ / 이만 `수` ✗
      "이만수 감독이 이끌었어요.",
      "이천 베어스 파크에서 훈련해요.",
      "이만수 감독과 김성근 감독이 있었어요.",
      // 10라운드 자체발견 — 큰 자리수사(만·억)를 넓게 잡으면 야구 어휘가 죽는다.
      //   `만루`(滿壘)·`만족`·`억척`. 특히 `만루` 는 구단 서술에 흔하다.
      "만루 상황에 강한 구단이에요.",
      "만족스러운 시즌을 보낸 구단이에요.",
      "조만간 우승할 구단이에요.",
      // 10라운드 자체발견 2 — 서술격을 `이 + 아무 한글` 로 두면 야구 어휘가 죽는다.
      //   세`이`브 · 세`이`프 · 네`이`버 는 앞 글자(세·네)가 관형형 수사라 수사로 오독된다.
      //   실제로 `네이버` 가 과차단돼 게이트가 RED 를 냈다.
      "세이브 기록이 많은 구단이에요.",
      "세이프 판정으로 이긴 구단이에요.",
    ]) {
      const { deps } = makeDeps({
        callTeamRagLlm: async () => ({
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer }),
          inputTokens: 10,
          outputTokens: 5,
        }),
      });
      const result = await answerQuestion("u1", "삼성 어떤 팀이야?", deps);
      assert.equal(result.source, "rag",
        `수치가 아닌 정상 구단 서술이 차단됐다(과차단): ${answer}`);
    }
    ok("한글 수치 차단 과차단 방지 — 이승엽·이해·이번·오타니·열심히·이점·천천히·백업·이사회·만루·만족·조만간·억척·이만수·이천·세이브·세이프·네이버 통과");
  }

  {
    // ④-6 미서빙 수치 질문은 team RAG 를 **아예 호출하지 않는다** (삼순 P0-2 4라운드).
    //     내가 "수치 질문은 team RAG 를 안 탄다"고 보고했는데 코드는 `team_record`
    //     실패 분기에서 계속 호출하고 있었다. 여기서 호출 자체를 고정한다.
    //     근거는 있는 상태(기본 searchRag)라, 우회가 되살아나면 즉시 RED 다.
    for (const question of ["LG 우승 몇 번 했어?", "삼성 우승 몇 번 했어?", "한화 우승 횟수 알려줘"]) {
      const { deps, logs, calls } = makeDeps();
      const result = await answerQuestion("u1", question, deps);
      assert.equal(calls.search.filter((c) => c.entityType === "team").length, 0,
        `${question}: 미서빙 수치 질문이 구단 근거를 조회했다`);
      assert.equal(calls.teamLlm.length, 0,
        `${question}: 미서빙 수치 질문이 구단 RAG LLM 을 소비했다`);
      assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
      assert.equal(logs.at(-1)?.matchPath, "history_hold");
    }
    ok("미서빙 수치 질문 — team RAG 호출 0회 (LLM·quota 미소비)");
  }

  {
    // ④-7 프롬프트와 출력 가드가 **같은 계약**을 말해야 한다.
    //     가드만 닫고 프롬프트가 "자료 숫자는 써라" 로 남아 있으면 모델 답이 매번
    //     폐기돼 INSUFFICIENT 로 새고, 리뷰어도 계약을 오독한다(실제로 그랬다).
    //     배포되는 상수 원문을 직접 읽는다 — 내 요약이 아니라 실제 문자열이다.
    // ⚠️ 문자열 존재 검사만으로는 불일치를 못 잡는다(삼순 5라운드 지적).
    //   프롬프트가 `첫 우승` 을 예시로 금지해도 가드가 그걸 통과시키면 계약은 깨진 것이다.
    //   그래서 **프롬프트가 금지 예시로 든 표현을 뽑아 실제 가드에 먹인다.**
    //   프롬프트에 새 예시를 추가했는데 가드가 못 잡으면 여기서 RED 가 난다.
    assert.ok(!/자료에 그대로 적힌 값만/.test(RAG_TEAM_SYSTEM_PROMPT),
      "구단 프롬프트에 종전 '숫자 허용' 지시가 남아 있다(가드와 모순)");
    //   ⚠️ 추출 범위를 잘못 잡으면 게이트가 거짓 RED 를 낸다(자체 검증에서 두 번 났다):
    //     · 문서 전체 괄호 → `한국 프로야구(KBO)` 의 `KBO` 를 금지 예시로 오인
    //     · 예시 줄 통째   → `→` **오른쪽**은 오히려 통과해야 하는 모범답인데 금지로 오인
    //   그래서 두 축을 나눠 본다.
    //
    //   축1: `숫자를 쓰지 않는다` 줄의 괄호 안 예시는 **전부 차단**돼야 한다.
    const bannedLine = RAG_TEAM_SYSTEM_PROMPT.split("\n")
      .find((line) => /숫자를 쓰지 않는다/.test(line));
    assert.ok(bannedLine, "프롬프트에 숫자 금지 지시가 없다");
    const bannedExamples = [...bannedLine.matchAll(/[(（]([^)）]*)[)）]/g)]
      .flatMap((m) => m[1].split(/\s*,\s*/))
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    assert.ok(bannedExamples.length >= 3,
      `프롬프트 금지 예시를 못 뽑았다: ${JSON.stringify(bannedExamples)}`);
    for (const example of bannedExamples) {
      assert.ok(/\d/.test(example) || hasKoreanNumericExpression(example),
        `프롬프트가 금지한 표현을 가드가 통과시킨다(계약 불일치): ${example}`);
    }

    //   축2: `A → B` 재작성 예시. **왼쪽은 차단, 오른쪽은 통과**여야 한다.
    //   오른쪽까지 막히면 프롬프트가 시킨 모범답을 가드가 폐기한다는 뜻이라
    //   그 경로는 영원히 INSUFFICIENT 만 낸다.
    const rewriteLine = RAG_TEAM_SYSTEM_PROMPT.split("\n").find((line) => line.includes("→"));
    assert.ok(rewriteLine, "프롬프트에 재작성 예시가 없다");
    const [before, after] = rewriteLine.split("→")
      .map((side) => (side.match(/`([^`]+)`/)?.[1] ?? "").trim());
    assert.ok(before && after, `재작성 예시 파싱 실패: ${rewriteLine}`);
    assert.ok(/\d/.test(before) || hasKoreanNumericExpression(before),
      `재작성 예시의 '고치기 전' 을 가드가 통과시킨다: ${before}`);
    assert.ok(!/\d/.test(after) && !hasKoreanNumericExpression(after),
      `재작성 예시의 '고친 후' 를 가드가 차단한다(모범답이 폐기됨): ${after}`);

    ok(`프롬프트↔가드 계약 일치 — 금지예시 ${bannedExamples.length}종 차단 + 재작성 모범답 통과, 실제 가드로 대조`);
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

  {
    // ⑤ 나무위키 전용 정제는 **나무위키 문서에만** 적용된다 (삼순 2026-08-07 8라운드).
    //
    //   ⚠️ 왜 위험했나: `BARE_DOMAIN_LINE` 앵커는 도메인 줄의 **앞뒤 1줄까지** 지운다.
    //   공식 e북(tier1) 조문 사이에 출처 URL 한 줄이 섞이면 그 위아래 조문이 통째로
    //   사라진다. 나무위키 근거가 안 씻기는 손해보다 공식 근거가 잘리는 손해가 크므로,
    //   판정 불가일 때는 **적용하지 않는 쪽**이 기본값이다.
    const OFFICIAL_LINES = [
      "타자가 타격을 완료한 뒤 1루에 도달하면 안타로 기록한다.",
      "kbo.co.kr/rule/2026",
      "다만 야수의 실책으로 출루한 경우는 안타로 기록하지 않는다.",
    ].join("\n");

    // tier1 공식 근거: 도메인 줄이 있어도 **앞뒤 조문이 살아남아야** 한다.
    const official = sanitizeEvidenceContent(OFFICIAL_LINES, {
      sourceKind: "kbo_ebook",
      canonicalUrl: "https://www.kbo.co.kr/rule/2026",
    });
    assert.match(official, /타격을 완료한 뒤 1루에 도달하면 안타/,
      "공식 조문이 나무위키 광고 규칙에 잘렸다");
    assert.match(official, /야수의 실책으로 출루한 경우는 안타로 기록하지 않는다/,
      "도메인 줄 다음 조문이 나무위키 광고 규칙에 잘렸다");

    // 위키피디아(tier2)도 나무위키가 아니므로 무변조여야 한다.
    const wiki = sanitizeEvidenceContent(OFFICIAL_LINES, {
      sourceKind: "wikipedia_document",
      canonicalUrl: "https://ko.wikipedia.org/wiki/LG_트윈스",
    });
    assert.match(wiki, /야수의 실책으로 출루한 경우/, "위키피디아 본문이 나무위키 규칙에 잘렸다");

    // 반대편: 같은 입력이라도 **나무위키 문서면** 광고 슬롯으로 보고 제거해야 한다.
    //   이게 없으면 "전부 무변조" 로 바꾼 극단 변이도 위 단언을 GREEN 으로 만든다.
    const namu = sanitizeEvidenceContent(
      ["명품시계대출", "blog.naver.com/nicewatch_kr", "당일대출 가능", "천보성 감독이 이끌었다."].join("\n"),
      { sourceKind: "namu_document", canonicalUrl: "https://namu.wiki/w/LG%20트윈스" },
    );
    assert.doesNotMatch(namu, /대출/, "나무위키 광고 슬롯이 제거되지 않았다");
    assert.match(namu, /천보성 감독/, "광고 제거가 인접 본문까지 먹었다");

    // sourceKind 가 없어도 canonicalUrl 호스트로 판정한다(레거시 호출 경로).
    assert.equal(shouldStripNamuChrome({ canonicalUrl: "https://namu.wiki/w/LG" }), true);
    assert.equal(shouldStripNamuChrome({ canonicalUrl: "https://www.kbo.co.kr/rule" }), false);
    // 판정 불가 → 무변조(fail-safe). 나무위키가 아닌 것을 자르는 쪽이 더 위험하다.
    assert.equal(shouldStripNamuChrome({}), false);
    assert.equal(shouldStripNamuChrome({ canonicalUrl: "not-a-url" }), false);
    // sourceKind 가 있으면 URL 보다 우선한다.
    assert.equal(
      shouldStripNamuChrome({ sourceKind: "kbo_ebook", canonicalUrl: "https://namu.wiki/w/X" }),
      false,
      "sourceKind 가 tier1 인데 URL 만 보고 나무위키 규칙을 적용했다",
    );

    // 🔴 여기까지는 sanitizeEvidenceContent 를 **직접** 부른 검증이라, 실제 서빙 경로가
    //   source 를 안 넘겨도 GREEN 이 된다(자체 mutation M22 로 실측 확인).
    //   그래서 실제 호출부인 selectEvidence 를 태워 **배선 자체**를 고정한다.
    const selectedOfficial = selectEvidence([{
      content: OFFICIAL_LINES,
      pageTitle: "야구규칙",
      canonicalUrl: "https://www.kbo.co.kr/rule/2026",
      revision: "etag:rule",
      sectionPath: "야구규칙/기록",
      asOf: "2026-08-05",
      sourceGrade: "tier1",
      sourceKind: "kbo_ebook",
    }]);
    assert.equal(selectedOfficial.length, 1, "공식 근거가 통째로 탈락했다");
    assert.match(selectedOfficial[0].content, /야수의 실책으로 출루한 경우/,
      "selectEvidence 가 source 를 안 넘겨 공식 조문이 나무위키 규칙에 잘렸다");

    const selectedNamu = selectEvidence([{
      content: ["명품시계대출", "blog.naver.com/nicewatch_kr", "당일대출 가능", "천보성 감독이 이끌었다. 1997 시즌 한국시리즈에 진출했다."].join("\n"),
      pageTitle: "LG 트윈스",
      canonicalUrl: "https://namu.wiki/w/LG%20트윈스",
      revision: "etag:lg",
      sectionPath: "LG 트윈스/역사",
      asOf: "2026-08-05",
      sourceGrade: "tier2",
      sourceKind: "namu_document",
    }]);
    assert.equal(selectedNamu.length, 1);
    assert.doesNotMatch(selectedNamu[0].content, /대출/,
      "selectEvidence 경로에서 나무위키 광고가 살아남았다");

    ok("나무위키 정제 범위 — source_kind 한정, tier1/위키피디아 무변조 + selectEvidence 배선 고정");
  }

  {
    // ⑥ **production 배선 종단** — server RPC row → rank → selectEvidence 까지 sourceKind 가
    //    살아서 흐르는가 (삼순 2026-08-07 9라운드 P0-3).
    //
    //    ⚠️ 앞 블록(§5)은 `selectEvidence()` 직전에 sourceKind 를 **직접 주입**해서
    //    검증했다. 그래서 production 경로가 그 값을 도중에 버려도 GREEN 이었다.
    //    실제로 두 군데서 버리고 있었다:
    //      · `createProductionRagSearchRuntime` 의 row mapping (RPC 는 source_kind 를 주는데 안 실음)
    //      · `rankEvidenceByQuery` 가 새 객체를 만들면서 필드 누락
    //    여기서는 **배포되는 팩토리를 그대로 실행**해 RPC 응답부터 최종 근거까지 태운다.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= "team-rag-wiring-smoke-key";
    const { createProductionRagSearchRuntime } = await import("../../src/lib/baseball-qa/server");

    // 광고 3줄 + 본문. 나무위키로 판정되면 광고가 지워지고 본문만 남아야 한다.
    const NAMU_ROW_CONTENT = [
      "명품시계대출",
      "blog.naver.com/nicewatch_kr",
      "당일대출 가능",
      "천보성 감독이 이끌었고 1997 시즌 한국시리즈에 진출한 구단이다.",
    ].join("\n");

    const unitVector = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    const runtime = createProductionRagSearchRuntime({
      rpc: async () => ({
        data: [{
          content: NAMU_ROW_CONTENT,
          page_title: "LG 트윈스",
          canonical_url: "https://namu.wiki/w/LG%20트윈스",
          revision: "etag:lg",
          section_path: "LG 트윈스/역사",
          as_of: "2026-08-05",
          source_grade: "tier2",
          source_kind: "namu_document",
          embedding: JSON.stringify(unitVector),
        }],
        error: null,
      }),
    } as unknown as Parameters<typeof createProductionRagSearchRuntime>[0]);

    const rows = await runtime.fetchBySourceKind(
      { entityType: "team", entityId: "1", name: "LG" } as never,
      "namu_document",
      4,
      unitVector,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceKind, "namu_document",
      "server row mapping 이 source_kind 를 버렸다");

    // rank → select 를 그대로 통과시켜, 중간 단계가 필드를 떨어뜨리지 않는지 본다.
    const ranked = rankEvidenceByQuery(rows, unitVector);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].sourceKind, "namu_document",
      "rankEvidenceByQuery 가 sourceKind 를 버렸다(새 객체 생성 시 필드 누락)");

    const finalEvidence = selectEvidence(ranked);
    assert.equal(finalEvidence.length, 1, "정제 후 근거가 통째로 탈락했다");
    assert.doesNotMatch(finalEvidence[0].content, /대출/,
      "production 종단에서 나무위키 광고가 근거로 살아남았다");
    assert.match(finalEvidence[0].content, /천보성 감독/, "광고 제거가 본문까지 먹었다");

    ok("production 배선 종단 — RPC row → rank → selectEvidence 까지 source_kind 보존");
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
