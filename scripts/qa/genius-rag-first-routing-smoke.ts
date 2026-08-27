/**
 * 야잘알봇 **RAG-first 라우팅** 계약 게이트 (하린아빠 2026-08-27 "최대한 RAG을 활용하고
 * LLM을 활용하는 방향으로 전면적으로 수정해줘" — Phase ①).
 *
 * ⚠️ 이 게이트는 **삼순 2026-08-27 NO-GO 로 통째로 다시 썼다.**
 *   1차 버전은 전부 소스 grep 이었다. 그래서 "공식 RAG 진입 조건에서 `isSupportedRuleTermQuestion`
 *   이 빠졌다" 는 것만 보고 GREEN 을 냈는데, 실제로는 `routeQuestion` 이 사전 밖 표현을 전부
 *   `llm_scope_gate` 로 보내고 진입 조건이 `!scopeGate` 라 **같은 문이 그대로 닫혀 있었다.**
 *   즉 제거한 조건은 거의 중복 조건이었고 라우팅은 열리지 않았다 — 소스가 바뀌었다는 사실은
 *   동작이 바뀌었다는 증거가 아니다(M90 `게이트가 종단 실행 경로를 안 태우면 통과는 무의미`).
 *
 *   그래서 판정을 **`answerQuestion` 종단 실행**으로 옮겼다. 아래 positive/negative 는 삼순이
 *   지정한 최소축 그대로다.
 *
 * ── 종단 축 (실행) ──────────────────────────────────────────────────────────
 *   P1  `세이브 조건`       → 공식 검색을 타고 rag 로 서빙된다
 *   P2  `포스아웃 상황`     → 〃
 *   P3  `이닝 교대 조건`    → 〃
 *   N1  `오늘 점심`         → 공식 근거 0건 → official 미서빙
 *   N2  `파워히터`          → 〃
 *   N3  `고춧가루 시리즈`   → 〃
 *   E1~E5 **엔티티 결속 질문은 main 계약 그대로**(하린아빠 2026-08-27 ⓒ) —
 *         이 PR 의 개방은 엔티티가 없는 순수 룰 질문에만 적용된다.
 *
 * ── 구조 축 (실행으로 못 보는 것만) ────────────────────────────────────────
 *   B  거리 임계가 RPC 호출에 실린다 (개수 판정 폐기)
 *   C  임계는 코드 상수 — env 로 무력화 불가 + 실측 경계 안
 *   D  배포 순서 fail-close — PGRST202 는 예외가 아니라 근거 0건
 *   E  구 시그니처 재시도 금지
 *   S  migration 이 상한을 SQL 에서 다시 강제한다 (앱이 임계를 풀 수 없다)
 *   W  소유권 판정 불능(거리 미제공)은 **선수 유지** — migration 이전 배포에서 뒤집히지 않는다
 *
 * ⚠️ 거리 fixture 는 **프로덕션 코퍼스 실측값**이다(2026-08-27, `genius_rag_serving_chunks`
 *   tier1 top1 코사인 거리). 가짜 RPC 는 SQL 이 하는 일과 같은 일만 한다 — 임계 밖 행을
 *   반환하지 않는다. 임계 자체를 시험하는 게 아니라 **임계가 걸린 세계에서 라우팅이 맞는가**
 *   를 시험한다(임계값 타당성은 C 축, SQL 강제는 S 축).
 *
 * `--selftest`: 판정 키가 RED 를 낼 수 있는지 증명한다(검증력 증명은 mutations 가 한다).
 *
 * 실행: npm run qa:genius-rag-first
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  answerQuestion,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  RAG_DOCUMENT_MAX_DISTANCE,
  RAG_GROUNDED_SENTINEL,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

const SELFTEST = process.argv.includes("--selftest");
let passed = 0;
const pass = (name: string) => { passed += 1; console.log(`  PASS ${name}`); };

const src = (rel: string) => readFileSync(new URL(`../../src/lib/baseball-qa/${rel}`, import.meta.url), "utf8");
/** 주석·문서 문면은 blank 처리한다 — 폐기 이력 주석이 assertion 을 만족시키면 false-green 이다(M90). */
const stripComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

/**
 * 프로덕션 코퍼스 실측 거리 (2026-08-27, tier1 top1).
 *
 * 🔴 **검색어 기준**이다 — 소유권 판정은 이름을 지운 잔여 질문으로 검색하므로
 *   `문보경 보크 규칙` 은 여기 없고 `보크 규칙` 이 있다. 그게 이 PR 의 핵심 설계라
 *   fixture 도 같은 키를 쓴다(원문 키를 넣어두면 잔여 검색을 안 태워도 통과해버린다).
 */
const MEASURED_DISTANCE: Record<string, number> = {
  // 정본이 있는 질문 — 임계 안
  "세이브 조건": 0.3680,
  "포스아웃 상황": 0.2689,
  "이닝 교대 조건": 0.2830,
  "보크 규칙": 0.2849,
  // 🔴 엔티티 결속 질문 — **원문 그대로** 검색된다(소유권 probe 폐기 후 잔여 치환 없음).
  //   전부 서빙 임계 0.42 **안**이라는 것이 E 축의 무대다: 거리로는 안 갈리므로
  //   라우팅을 가르는 것은 사전 계약(`isSupportedRuleTermQuestion`)뿐이다.
  //   즉 이 fixture 는 "개방이 엔티티 질문까지 새면 전부 official 로 간다"는 조건을
  //   실제로 성립시킨다 — 무대가 없으면 E·V 축이 무증상이 된다(M90).
  "문보경 보크 규칙 알려줘": 0.3374,
  "임찬규 투구판 이탈 규칙": 0.3082,
  "LG 경기에서 점수가 같으면 연장전 규칙은?": 0.2953,
  "문보경 별명 알려줘": 0.3090,
  "LG 트윈스 역사 알려줘": 0.3017,
  "문보경 삼진 당한 경기 알려줘": 0.2965,
  "문보경 보크 규칙": 0.3349,
  // 야구 무관 / tier1 에 정의가 없는 질문 — 임계 밖
  "오늘 점심": 0.4480,
  "파워히터": 0.5029,
  "고춧가루 시리즈": 0.4491,
  // 선수 문서가 정본인 잔여 질문
  "별명": 0.4109,
  "별명 알려줘": 0.4399,
  // 🔴 삼순 2026-08-27 ① 이 지목한 **후보 해석기가 null 을 주는** 엔티티 질문 3종.
  //   전부 임계 0.42 **안**이다 — 즉 가드가 "지명 존재"가 아니라 "단일·서빙가능 후보"에
  //   걸려 있으면 이 질문들이 실제로 공식 RAG 를 선점한다. 무대가 성립한다는 실측 근거다.
  //   (2026-08-27 tier1 top1 실측)
  "문보경 어제 무슨 일 있었어?": 0.3210,          // 선수명 있으나 서술 후보 아님
  "문보경이랑 김현수 중에 누가 더 잘해?": 0.3086,  // 복수 선수
  "LG랑 두산 경기 어땠어?": 0.2830,               // 복수 구단
  // 같은 null 집합인데 사전이 룰 질문으로 인정하는 짝 — main 계약이면 official 이 맞다.
  "문보경이랑 김현수 보크 규칙 알려줘": 0.3354,
  "LG랑 두산 연장전 규칙 알려줘": 0.3133,
};

const OFFICIAL_CONTENT =
  "5.09 아웃 — 인필드 플라이가 선고된 타구가 베이스에서 떨어져 있는 주자에게 닿았을 때는 타자와 주자가 모두 아웃된다.";
const PLAYER_CONTENT = "문보경은 LG 트윈스 소속 내야수로 팬들이 부르는 별명이 있다.";

// 김현수를 함께 둔다 — **복수 선수 지명**을 만들려면 로스터에 둘 다 있어야 한다.
// (없으면 `mentionsAnyRosterName` 이 한 명만 보고 "복수" 무대가 성립하지 않는다.)
const PLAYERS: PlayerRef[] = [
  { kboId: "69102", name: "문보경", team: "LG" } as PlayerRef,
  { kboId: "50072", name: "김현수", team: "LG" } as PlayerRef,
];

interface Calls {
  officialSearch: string[];
  officialLlm: number;
  playerSearch: number;
  playerLlm: number;
  genericLlm: number;
  logged: string[];
}

/**
 * 가짜 공식 RPC. **SQL 이 하는 일만 한다** — 실측 거리가 임계 밖이면 행을 돌려주지 않는다.
 * 임계 안이면 `distance` 를 실어 돌려준다(호출자 관측 계약과 동일).
 */
function officialSearchFor(calls: Calls, distanceOverride?: (q: string) => number | undefined) {
  return async (question: string): Promise<RagEvidence[]> => {
    calls.officialSearch.push(question);
    const d = distanceOverride ? distanceOverride(question) : MEASURED_DISTANCE[question];
    if (d === undefined) return [];
    if (d > RAG_DOCUMENT_MAX_DISTANCE) return [];
    return [{
      content: OFFICIAL_CONTENT,
      pageTitle: "2026 공식야구규칙",
      canonicalUrl: "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx",
      revision: "sha256:8f2c6d595f48b",
      sectionPath: "5.09 아 웃",
      asOf: "2026-08-01",
      sourceGrade: "tier1",
      distance: d,
    }];
  };
}

function makeDeps(calls: Calls, overrides: Partial<QaDeps> = {}): QaDeps {
  const glossary: GlossaryEntry[] = [];
  return {
    loadGlossary: async () => glossary,
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    log: async (row) => { calls.logged.push(row.matchPath); },
    now: () => Date.parse("2026-08-27T10:00:00+09:00"),
    callLlm: async () => {
      calls.genericLlm += 1;
      return {
        text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "일반 지식으로 답합니다." }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    searchOfficialRag: officialSearchFor(calls),
    callOfficialRagLlm: async () => {
      calls.officialLlm += 1;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "공식 자료 기준으로 그렇습니다." }),
        inputTokens: 10, outputTokens: 5,
      };
    },
    enablePlayerRag: true,
    searchRag: async () => {
      calls.playerSearch += 1;
      return [{
        content: PLAYER_CONTENT,
        pageTitle: "문보경",
        canonicalUrl: "https://namu.wiki/w/문보경",
        revision: "42103021",
        sectionPath: "본문",
        asOf: "2026-08-01",
        sourceGrade: "tier2",
      }] as RagEvidence[];
    },
    callRagLlm: async () => {
      calls.playerLlm += 1;
      return {
        text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "LG 트윈스 내야수입니다." }),
        inputTokens: 3, outputTokens: 2,
      };
    },
    ...overrides,
  } as QaDeps;
}

async function run(question: string, overrides: Partial<QaDeps> = {}) {
  const calls: Calls = {
    officialSearch: [], officialLlm: 0, playerSearch: 0, playerLlm: 0, genericLlm: 0, logged: [],
  };
  const result = await answerQuestion("u-ragfirst", question, makeDeps(calls, overrides));
  return { result, calls };
}

async function main() {
  const pipeline = stripComments(src("pipeline.ts"));
  const server = stripComments(src("server.ts"));

  // ── P. 라우팅이 실제로 열렸는가 (종단 실행) ────────────────────────────────
  //   1차 버전이 소스 grep 으로 GREEN 을 냈던 바로 그 자리다. 사전에 없는 표현이
  //   **공식 검색을 태우고 rag 로 서빙되는지**를 실행으로 고정한다.
  for (const q of ["세이브 조건", "포스아웃 상황", "이닝 교대 조건"]) {
    const { result, calls } = await run(q);
    assert.ok(
      calls.officialSearch.includes(q),
      `P(${q}): 공식 RAG 검색을 아예 타지 않는다 — 라우팅이 열리지 않았다. `
      + "사전 밖 표현은 llm_scope_gate 로 가고 진입 조건이 그걸 다시 제외하면 문은 닫힌 채다",
    );
    assert.equal(
      SELFTEST ? "llm" : result.source, "rag",
      `P(${q}): 정본 근거가 있는데 rag 로 서빙되지 않았다 (실제: ${result.source})`,
    );
    assert.equal(calls.genericLlm, 0, `P(${q}): 근거가 있는데 generic LLM 을 태웠다`);
  }
  pass("P 라우팅 개방 — 사전 밖 정본 질문 3종이 공식 근거로 서빙된다");

  // ── N. 열었다고 아무 질문이나 통과시키지 않는다 (거리 임계) ────────────────
  //   RPC 가 상한만큼 무조건 돌려주던 시절엔 개수로 판정이 불가능했다. 임계가 걸린
  //   세계에서 무관한 질문이 official 로 서빙되지 않는지 실행으로 본다.
  for (const q of ["오늘 점심", "파워히터", "고춧가루 시리즈"]) {
    const { result, calls } = await run(q);
    assert.notEqual(
      result.source, "rag",
      `N(${q}): 정본 근거가 없는데 rag 로 서빙됐다 — 거리 임계가 무력화됐다`,
    );
    assert.equal(
      SELFTEST ? 1 : calls.officialLlm, 0,
      `N(${q}): 근거 0건인데 공식 RAG LLM 을 소비했다 (호출 ${calls.officialLlm}회)`,
    );
    // 🔴 **넓히되 뺏지 않는다** 를 종단으로 고정한다 (mutation r12 가 뚫은 자리).
    //   근거가 없으면 공식 경로는 양보하고 종전 경로가 이어져야 한다. 여기서 종결해버리면
    //   `source !== "rag"` 는 여전히 참이라 소스 grep 도, 위 두 assert 도 못 잡는다 —
    //   기존에 답하던 질문이 조용히 unsure 로 바뀌는 기능 퇴행이다.
    assert.ok(
      SELFTEST ? false : calls.genericLlm > 0,
      `N(${q}): 근거가 없는데 종전 경로로 내려가지 않고 여기서 종결했다 `
      + `(source=${result.source}, genericLlm=${calls.genericLlm}) — 라우팅을 넓히는 게 아니라 `
      + "기존 종결을 빼앗는 것이다",
    );
  }
  pass("N 근거 없는 질문 3종 — official 미서빙 + 공식 LLM 0 + 종전 경로 유지");

  // ── E. 엔티티 결속 질문은 main 계약 그대로 (하린아빠 2026-08-27 ⓒ) ────────
  //
  //   🔴 이 PR 은 엔티티(선수·구단)가 결속된 질문의 라우팅을 **바꾸지 않는다.**
  //     앞선 커밋에서 나는 소유권을 근거 거리로 가르려 했는데(잔여 질문 probe + 임계),
  //     실측으로 그 접근이 원리적으로 안 갈린다는 게 확인됐다 — 잔여 질문 상대 비교에서
  //       official 정본 margin 최소 0.0759 (`연장전 규칙 알려줘`)
  //       엔티티 정본 margin 최대 0.0850 (`삼진 당한 경기 알려줘`)
  //     로 **두 분포가 뒤집힌다.** 임베딩 거리는 "무슨 단어가 있나"에 반응하고 "무엇을
  //     묻나"에는 반응하지 않아서, 룰 어휘를 쓴 사건 질문이 진짜 규칙 질문보다 가깝다.
  //
  //   그래서 엔티티 결속 질문은 `isSupportedRuleTermQuestion`(main 계약)이 그대로 가른다.
  //   이 축은 **그 동치가 실제로 성립하는지**를 종단 실행으로 고정한다 — 소유권을 "고쳤다"가
  //   아니라 "건드리지 않았다"가 이 PR 의 주장이므로, 그 주장 자체를 게이트로 만든다.
  //   ⚠️ 삼순 P0-2 가 지적한 개선(`문보경 보크 규칙 알려줘`)은 여기서 해결되지 않는다.
  //     main 과 동일하게 official 로 가고, 진짜 소유권 문제는 별도 PR 로 이월된다.
  const ENTITY_PARITY: Array<{ q: string; want: "official" | "entity"; why: string }> = [
    // 사전이 룰 질문으로 인정 → main 과 동일하게 공식 RAG
    { q: "문보경 보크 규칙 알려줘", want: "official", why: "사전 true(선수 결속) — main 동일" },
    { q: "임찬규 투구판 이탈 규칙", want: "official", why: "사전 true(후보 미결속) — main 동일" },
    { q: "LG 경기에서 점수가 같으면 연장전 규칙은?", want: "official", why: "사전 true(구단 결속) — main 동일" },
    // 사전이 룰 질문으로 안 봄 → main 과 동일하게 엔티티 경로
    { q: "문보경 별명 알려줘", want: "entity", why: "사전 false — 선수 문서가 정본" },
    { q: "LG 트윈스 역사 알려줘", want: "entity", why: "사전 false — 구단 문서가 정본" },
  ];
  for (const { q, want, why } of ENTITY_PARITY) {
    const { calls } = await run(q);
    // 🔴 판정은 **공식 LLM 소비 여부**로 한다. 검색 호출 수가 아니라 "공식 경로가 이 질문을
    //   가져갔는가"가 계약이고, durable LLM 경계를 넘으면 되돌릴 수 없기 때문이다.
    const tookOfficial = calls.officialLlm > 0;
    assert.equal(
      SELFTEST ? !tookOfficial : tookOfficial, want === "official",
      `E(${q}): 기대 ${want} 인데 공식 LLM ${calls.officialLlm}회 — ${why}. `
      + "엔티티 결속 질문의 라우팅은 이 PR 이 바꾸지 않는다(main 계약 유지)",
    );
    if (want === "entity") {
      assert.equal(
        calls.officialLlm, 0,
        `E(${q}): 엔티티 문서가 정본인 질문을 규칙집이 가져갔다 — durable 호출을 소비하면 `
        + "엔티티 경로로 되돌아갈 수 없다",
      );
    }
  }
  pass("E 엔티티 결속 5종 — main 계약(사전 판정) 그대로 라우팅된다");

  // ── V. 엔티티 결속 질문에는 이 PR 의 개방이 적용되지 않는다 ────────────────
  //   `문보경 삼진 당한 경기 알려줘` 는 사전 false 다. 개방이 엔티티 질문까지 새면
  //   이 질문이 공식 RAG 로 가는데, 그건 정확히 삼순 P0-2 가 지적한 선점이다.
  {
    const { calls } = await run("문보경 삼진 당한 경기 알려줘");
    assert.equal(
      SELFTEST ? 1 : calls.officialLlm, 0,
      `V: 사건 질문(사전 false)이 공식 RAG 를 탔다 (${calls.officialLlm}회) — 개방이 `
      + "엔티티 결속 질문까지 샜다. 이 질문의 tier1 거리는 0.2918 로 진짜 규칙 질문보다 "
      + "가까워서, 거리로는 막을 수 없다(그래서 사전 계약을 유지하는 것이다)",
    );
  }
  pass("V 사건 질문(엔티티 결속·사전 false) — 개방이 새지 않는다");

  // ── E3. 후보 해석기가 null 을 주는 엔티티 질문도 막힌다 (삼순 2026-08-27 ①) ──
  //
  //   🔴 이 축이 없어서 직전 exact 가 GREEN 이었다. 가드를
  //     `enabledPlayerCandidate || resolveRagTeamCandidate(...)` 로 두면
  //       · 선수명은 있는데 **서술 후보가 아닌** 질문
  //       · **복수 선수** 지명
  //       · **복수 구단** 지명
  //     이 전부 `false` 로 떨어진다. 후보 해석기의 null 은 "엔티티가 없다" 가 아니라
  //     "**있는데 단일 후보로 못 좁혔다**" 인데, 그 null 을 개방 신호로 읽은 것이다.
  //
  //   무대가 실제로 성립한다 — 세 질문 모두 tier1 top1 거리가 **임계 0.42 안**이다
  //   (0.3210 / 0.3086 / 0.2830, 2026-08-27 실측). 즉 가드가 느슨하면 그냥 이론적
  //   위험이 아니라 **실제로 공식 RAG 가 durable LLM 을 선점한다.**
  //
  //   ⚠️ 사전이 룰 질문으로 인정하는 짝(`… 보크 규칙 알려줘`)도 같이 태운다. "전부
  //     막혔다" 는 것만 보면 가드를 `false` 로 고정해도 통과하므로, main 계약이
  //     살아있다는 반대 방향을 함께 고정해야 축이 판별력을 갖는다.
  {
    const NULL_CANDIDATE: Array<{ q: string; want: "official" | "entity"; why: string }> = [
      { q: "문보경 어제 무슨 일 있었어?", want: "entity", why: "단일 선수·비후보 (사전 false)" },
      { q: "문보경이랑 김현수 중에 누가 더 잘해?", want: "entity", why: "복수 선수 (사전 false)" },
      { q: "LG랑 두산 경기 어땠어?", want: "entity", why: "복수 구단 (사전 false)" },
      { q: "문보경이랑 김현수 보크 규칙 알려줘", want: "official", why: "복수 선수·사전 true — main 동일" },
      { q: "LG랑 두산 연장전 규칙 알려줘", want: "official", why: "복수 구단·사전 true — main 동일" },
    ];
    for (const { q, want, why } of NULL_CANDIDATE) {
      const { calls } = await run(q);
      const tookOfficial = calls.officialLlm > 0;
      assert.equal(
        SELFTEST ? !tookOfficial : tookOfficial, want === "official",
        `E3(${q}): 기대 ${want} 인데 공식 LLM ${calls.officialLlm}회 — ${why}. `
        + "후보 해석기의 null 은 '엔티티 없음'이 아니라 '단일 후보로 못 좁힘'이다 — "
        + "그 null 을 개방 신호로 쓰면 신규 경로가 durable LLM 을 선점한다",
      );
    }
    pass("E3 후보 null 엔티티 5종 — 지명 존재로 가른다 (비후보·복수선수·복수구단 + 반대축 2)");
  }

  // ── B. 근거 판정이 개수가 아니라 거리다 ───────────────────────────────────
  assert.ok(
    /p_max_distance:\s*RAG_DOCUMENT_MAX_DISTANCE/.test(server),
    "B: RPC 호출에 거리 임계(p_max_distance)가 실리지 않는다 — 개수로만 판정하면 "
    + "무관한 질문도 상한만큼 근거를 받아 100% 통과한다(실측: '오늘 점심 뭐 먹지?' 12건)",
  );
  // 거리를 호출자까지 실어 올리지 않으면 소유권 판정도, 72시간 재보정도 불가능하다(삼순 지적).
  assert.ok(
    /distance:\s*typeof row\.distance === "number" \? row\.distance : undefined/.test(server),
    "B2: RPC 가 준 distance 를 RagEvidence 로 전달하지 않는다 — 임계 재보정 근거가 없고 "
    + "소유권 판정도 불가능하다. 부재를 0 으로 응급처리하는 것도 금지(가장 가까움으로 읽힌다)",
  );
  pass("B 근거 판정 = 거리 임계 + 호출자 관측 전달");

  // ── C. 임계는 코드 상수여야 한다 — env 로 풀 수 있으면 방어가 아니다 ──────
  const retrieveSrc = stripComments(readFileSync(
    new URL("../../src/lib/baseball-qa/rag/retrieve.ts", import.meta.url), "utf8",
  ));
  for (const [name, runtime, lo, hi] of [
    ["RAG_DOCUMENT_MAX_DISTANCE", RAG_DOCUMENT_MAX_DISTANCE, 0.3787, 0.4281],
  ] as const) {
    const decl = new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)\\s*;`).exec(retrieveSrc);
    assert.ok(decl, `C: ${name} 가 리터럴 상수 선언이 아니다`);
    assert.ok(
      !/process\.env/.test(decl![0]),
      `C2(${name}): 임계가 env 로 주입된다 — 운영에서 무력화하면 근거 없는 답이 그대로 나간다`,
    );
    const value = Number(decl![1]);
    assert.equal(value, runtime, `C3(${name}): 선언값과 런타임 값이 다르다`);
    assert.ok(
      SELFTEST ? value > 99 : (value >= lo && value <= hi),
      `C4(${name}): 임계 ${value} 가 실측 경계 [${lo}, ${hi}] 밖이다`,
    );
  }
  pass(`C 임계 코드 상수 고정 (서빙 ${RAG_DOCUMENT_MAX_DISTANCE})`);

  // ── D·E. 배포 순서 방어 + 구 시그니처 재시도 금지 ─────────────────────────
  const fnStart = server.indexOf("export async function searchOfficialRag");
  assert.ok(fnStart > 0, "D0: searchOfficialRag 를 찾지 못했다");
  const fnBody = server.slice(fnStart, fnStart + 2600);
  assert.ok(
    /PGRST202/.test(fnBody) && /return \[\]/.test(fnBody),
    "D: RPC 시그니처 부재(PGRST202)를 근거 0건으로 접지 않는다 — migration 보다 앱이 먼저 "
    + "배포되면 공식 RAG 경로가 통째로 예외가 되어 유저에게 오류가 나간다",
  );
  assert.ok(
    !/p_limit[^}]*\}\s*\)\s*;[\s\S]{0,300}supabaseAdmin\.rpc\(\s*"search_baseball_genius_official_chunks"/.test(fnBody),
    "E: 구 시그니처로 재시도한다 — 구 RPC 는 임계가 없어 무슨 질문이든 상한만큼 돌려준다",
  );
  pass("D·E 배포 순서 fail-close (PGRST202 → 근거 0건, 구 시그니처 재시도 없음)");

  // ── S. SQL 이 상한을 다시 강제한다 ────────────────────────────────────────
  //   앱 상수만으로는 방어가 아니다 — 호출자가 1.0 을 넣으면 임계가 사라진다.
  //   ⚠️ 파일명을 하드코딩하지 않는다 — 이름이 바뀌면 게이트가 ENOENT 로 죽는데, 그건
  //     "계약 위반"이 아니라 "게이트 고장"이라 원인이 흐려진다. 대신 **디렉터리에서 찾고
  //     못 찾으면 명시적으로 FAIL** 한다(조용한 skip 금지).
  const migrationDir = new URL("../../supabase/migrations/", import.meta.url);
  const migrationName = readdirSync(migrationDir)
    .filter((f) => /official_chunk_distance_threshold\.sql$/.test(f))
    .sort()
    .at(-1);
  assert.ok(
    migrationName,
    "S0: 거리 임계 migration 을 찾지 못했다 — RPC 상한 강제 계약을 검증할 수 없다(fail-close)",
  );
  const migration = readFileSync(new URL(migrationName!, migrationDir), "utf8");
  assert.ok(
    /p_max_distance/.test(migration) && /least\s*\(/i.test(migration),
    "S: migration 이 p_max_distance 상한을 clamp 하지 않는다 — 앱이 임계를 무력화할 수 있다",
  );
  assert.ok(
    /distance/.test(migration.slice(migration.indexOf("RETURNS TABLE"), migration.indexOf("LANGUAGE"))),
    "S2: RPC 가 distance 를 반환하지 않는다 — 관측 없이는 재보정도 소유권 판정도 못 한다",
  );
  pass("S migration 이 SQL 에서 상한 재강제 + distance 반환");

  // ── G. 근거가 없으면 종전 경로가 이어진다 ─────────────────────────────────
  const officialCall = pipeline.indexOf("const official = await answerOfficialDocumentQuestion(");
  assert.ok(officialCall > 0, "G0: 공식 RAG 호출 지점을 찾지 못했다 — 게이트 앵커가 깨졌다");
  const afterCall = pipeline.slice(officialCall, officialCall + 300);
  assert.ok(
    /if\s*\(\s*official\s*\)\s*return official\s*;/.test(afterCall),
    "G: 근거가 없어도 공식 RAG 경로에서 종결한다 — 라우팅을 넓히는 게 아니라 "
    + "기존 종결을 빼앗는 것이다(사전·구단·선수 RAG 가 전부 죽는다)",
  );
  pass("G 근거 없으면 종전 경로 유지 (넓히되 뺏지 않는다)");

  console.log(`\ngenius-rag-first-routing-smoke PASS (${passed} checks)`);
}

async function entry() {
  if (SELFTEST) {
    let threw: Error | null = null;
    try { await main(); } catch (e) { threw = e as Error; }
    if (!threw) {
      console.error("\ngenius-rag-first-routing-smoke SELFTEST FAIL: 결함을 주입했는데 통과했다");
      process.exit(1);
    }
    console.log(`\ngenius-rag-first-routing-smoke SELFTEST PASS — 주입 결함 검출: ${threw.message.slice(0, 80)}`);
    return;
  }
  try { await main(); } catch (e) {
    console.error(`\ngenius-rag-first-routing-smoke FAIL: ${(e as Error).message}`);
    process.exit(1);
  }
}

void entry();
