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
 *   ③ 우리가 **서빙하지 않는** 수치(우승 횟수)는 근거가 있으면 답하되, 근거에 없는 숫자는
 *      출력 가드가 막고 안내문으로 닫는다.
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
  RAG_GROUNDED_SENTINEL,
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
}

function makeDeps(overrides: Partial<QaDeps> = {}): {
  deps: QaDeps;
  logs: { matchPath: string; answer: string | null }[];
  calls: Calls;
} {
  const logs: { matchPath: string; answer: string | null }[] = [];
  const calls: Calls = { search: [], teamLlm: [], genericLlm: 0, cacheReads: 0, standingsFetches: 0 };
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
      // 근거에 적힌 값만 쓴다 — 삼성 근거는 `8회`, LG 근거는 `1990년`이 원문에 있다.
      const usesSamsung = evidence.some((row) => row.pageTitle === "삼성 라이온즈");
      return {
        text: JSON.stringify({
          status: RAG_GROUNDED_SENTINEL,
          answer: usesSamsung
            ? "삼성 라이온즈는 통산 한국시리즈 우승 8회를 기록했어요."
            : "LG 트윈스는 1990년 창단해 그 해 한국시리즈에서 우승한 구단이에요.",
        }),
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    callRagLlm: async () => { throw new Error("선수 RAG 는 이 게이트 대상이 아니다"); },
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
    // 서술형 답변에 **근거에 있는 연도**가 남아야 한다 — 숫자 전면금지로 되돌리면 RED.
    assert.match(result.answer, /1990년/, "근거에 적힌 연도는 답변에 남아야 한다");
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

  // ── ④ 미서빙 수치는 근거가 있으면 답하되 근거 밖 숫자는 막는다 ──────────
  {
    const { deps, calls } = makeDeps();
    const result = await answerQuestion("u1", "삼성 우승 몇 번 했어?", deps);
    assert.equal(result.source, "rag", `미서빙 수치가 근거로 안 갔다: ${result.source}`);
    assert.equal(calls.teamLlm.at(-1)?.evidence[0]?.pageTitle, "삼성 라이온즈");
    assert.match(result.answer, /8회/, "근거에 적힌 값이 그대로 나와야 한다");
    assert.match(result.answer, /📄 출처: 나무위키/);
    ok("미서빙 수치 — 근거 있으면 답변 + 근거값 그대로 + 출처");
  }

  // 근거에 없는 숫자를 모델이 지어내면 답으로 인정하지 않는다.
  {
    const { deps, logs, calls } = makeDeps({
      callTeamRagLlm: async (question, evidence) => {
        calls.teamLlm.push({ question, evidence });
        return {
          // 근거에는 8회뿐인데 12회라고 지어냈다.
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "삼성은 통산 12회 우승했어요." }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    const result = await answerQuestion("u1", "삼성 우승 몇 번 했어?", deps);
    assert.notEqual(result.source, "rag", "근거 밖 숫자가 rag 답변으로 나갔다");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("미서빙 수치 환각 — 근거 밖 숫자는 답변 거절 후 안내");
  }

  // ── ④-b 교차 chunk 조합 금지 — 단일 근거가 직접 진술한 사실만 (삼순 2026-08-05) ──
  //
  // ⚠️ 왜 필요한가: 숫자 대조가 근거 4건을 `join("\n")` 으로 **한 덩어리로 합쳐** 보면,
  //   서로 다른 chunk 의 숫자를 이어붙인 새 주장이 "근거에 있음"으로 통과한다.
  //     A: "1994년 태평양 돌핀스를 꺾고 우승했다"
  //     B: "통산 한국시리즈 우승 횟수는 총 8회다"
  //     답: "1994년에 8번째 우승을 했어요"   ← 어느 근거도 이렇게 말한 적 없다
  //   구단 corpus 는 연도·횟수 서술이 여러 문서에 흩어져 있어 이 조합 사고가 가장 잘 난다.
  //   삼순 기준은 "단일 근거가 직접 진술한 역사 사실만 허용, 계산/추정 금지" 이므로
  //   한 chunk 가 답의 수치 주장 **전부**를 담고 있을 때만 인정한다.
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
          // 두 chunk 의 숫자를 이어붙인 조합 주장. 각 숫자는 근거 어딘가에 있지만
          // **한 근거가 이렇게 진술한 적은 없다**.
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
      "여러 chunk 의 숫자를 조합한 주장이 rag 답변으로 나갔다(단일 근거 직접 진술 계약 위반)");
    assert.equal(result.answer, TEAM_STAT_HOLD_ANSWER);
    assert.equal(logs.at(-1)?.matchPath, "history_hold");
    ok("교차 chunk 조합 — 단일 근거가 진술하지 않은 수치 주장은 거절");
  }

  // 반대편 고정 — 한 chunk 가 수치 주장 전부를 담고 있으면 그대로 통과해야 한다.
  // 이게 없으면 위 계약을 "숫자 전면 금지"로 과하게 조여도 GREEN 이 된다.
  {
    const SINGLE_CHUNK: RagEvidence = {
      ...LG_EVIDENCE,
      content: "LG 트윈스는 1990년 창단해 그 해 한국시리즈에서 우승했다.",
      sectionPath: "LG 트윈스/1990년",
    };
    const { deps, calls } = makeDeps({
      searchRag: async (candidate) => {
        calls.search.push(candidate);
        return candidate.entityType === "team" ? [SINGLE_CHUNK, SAMSUNG_TITLE_EVIDENCE] : [];
      },
      callTeamRagLlm: async (question, evidence) => {
        calls.teamLlm.push({ question, evidence });
        return {
          // 수치(`1990년`)가 **첫 chunk 하나 안에** 전부 있다.
          text: JSON.stringify({
            status: RAG_GROUNDED_SENTINEL,
            answer: "LG 트윈스는 1990년에 창단한 구단이에요.",
          }),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    });
    const result = await answerQuestion("u1", "LG 트윈스 역사 알려줘", deps);
    assert.equal(result.source, "rag",
      "한 근거가 직접 진술한 수치까지 막으면 정상 구단 서사가 통째로 폐기된다");
    assert.match(result.answer, /1990년/);
    ok("단일 근거 직접 진술 — 그 chunk 안의 수치는 그대로 통과(과차단 금지)");
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

  console.log(`\n✅ team RAG wiring contract: ${passed} PASS (후보해석 / 근거조회 / 정본우선 / 환각차단 / 양보 / 플래그 / 판정기)`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
