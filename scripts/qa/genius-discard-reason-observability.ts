/**
 * 생성 RAG **관측 3칸** 계약 게이트 (2026-08-16 하린아빠 "0부터 착수" + 삼순 1차 NO-GO 반영).
 *
 * ## 왜 이 게이트가 필요한가
 *
 * tier2 경로(선수·구단·뉴스)는 답변에 유니코드 숫자가 하나라도 있으면 답 전체를 폐기한다.
 * 그런데 폐기된 건 로그에 `match_path='unsure'`(구단 수치질문은 `history_hold`)로만 남아
 * **폐기 사유도, 어느 RAG 경로에서 버렸는지도** 구분되지 않았다. 그래서 "숫자 전면 HOLD 가
 * 정확한 답을 얼마나 함께 버리는가"도 "뉴스 손실이 얼마인가"도 수치로 말할 수 없었다.
 *
 * 이 PR 은 그 분모를 만든다. 이 게이트는 그 계측이 **실제로 켜져 있는지**를 종단으로 본다.
 *
 * ## 이 게이트가 지키는 원칙 (M90 `게이트가 종단 실행 경로를 안 태우면 통과는 무의미`)
 *  ① 판정을 **재구현하지 않는다** — `validateRagResponse` 와 `answerQuestion` 을 실제로 태운다.
 *  ② migration CHECK 집합을 게이트가 **다시 적지 않는다** — 코드 상수를 import 해 SQL 문면과 대조한다.
 *  ③ **네 경로 전부** 종단으로 태운다 (삼순 ③ — team 한 경로만 보면 나머지 셋이 죽어도 GREEN).
 *  ④ **crash replay** 도 태운다 (삼순 ② — store 성공 후 log 전 crash 시 관측이 유실되는 축).
 *  ⑤ 검출력은 별도 mutation runner 가 증명한다 (`qa:genius-discard-reason:mutations`).
 *
 * 실행: npm run qa:genius-discard-reason
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerQuestion,
  packStoredQaFinal,
  unpackStoredQaFinal,
  NEWS_UNAVAILABLE_ANSWER,
  type GlossaryEntry,
  type LlmResult,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import {
  RAG_ATTEMPT_PATHS,
  RAG_DISCARD_REASONS,
  RAG_GROUNDED_SENTINEL,
  numericTokenCount,
  validateRagResponse,
  type RagAttemptPath,
  type RagDiscardReason,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260816140000_genius_question_logs_rag_discard_reason.sql",
);

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

/** 관측 3칸만 뽑은 로그 항목. */
interface LogEntry {
  matchPath: string;
  ragAttemptPath: RagAttemptPath | null | undefined;
  ragDiscardReason: RagDiscardReason | null | undefined;
  ragDiscardNumericCount: number | null | undefined;
}

/**
 * pipeline 이 `deps.log` 로 넘긴 **원본 항목 전체**.
 *
 * ⚠️ 4칸만 추려 담으면 "원문이 로그로 새는가"(삼순 익명집계 조건)를 **구조적으로 못 본다** —
 * 게이트가 보지 않는 필드로 본문이 흘러도 GREEN 이다. 그래서 전체를 보관해 직렬화 대조한다.
 */
type RawLogEntry = Record<string, unknown>;

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["balk"], answer: "투수의 부정 투구 동작입니다." },
];

const TEAM_EVIDENCE: RagEvidence = {
  content: "LG 트윈스는 1990년 MBC 청룡을 인수해 창단했다. 창단 첫 해 한국시리즈에서 우승했다.",
  pageTitle: "LG 트윈스",
  canonicalUrl: "https://namu.wiki/w/LG%20%ED%8A%B8%EC%9C%88%EC%8A%A4",
  revision: "etag:lg-history",
  sectionPath: "LG 트윈스/역사",
  asOf: "2026-08-16",
  sourceGrade: "tier2",
};

const PLAYER_EVIDENCE: RagEvidence = {
  content: "문보경은 LG 트윈스 소속 내야수로 팬들 사이에서 '문학소년'이라는 별명으로 불린다.",
  pageTitle: "문보경",
  canonicalUrl: "https://namu.wiki/w/%EB%AC%B8%EB%B3%B4%EA%B2%BD",
  revision: "etag:moon",
  sectionPath: "본문",
  asOf: "2026-08-16",
  sourceGrade: "tier2",
};

const OFFICIAL_EVIDENCE: RagEvidence = {
  content: "5.09 아웃 — 인필드 플라이가 선고된 타구가 주자에게 닿았을 때는 타자와 주자가 모두 아웃된다.",
  pageTitle: "공식야구규칙",
  canonicalUrl: "https://www.koreabaseball.com/file/deposit/2026_regulation.pdf",
  revision: "rev:2026",
  sectionPath: "5.09",
  asOf: "2026-08-16",
  sourceGrade: "tier1",
};

const NEWS_EVIDENCE: RagEvidence = {
  content:
    "천성호→송찬의→문정빈 홈런 합작…FA 김현수 떠난 자리는\n" +
    "지난해 LG 트윈스는 프로야구 통합 우승을 차지했다. 떠난 주전 외야수 자리를 젊은 타자들이 메우고 있다.",
  pageTitle: "천성호→송찬의→문정빈 홈런 합작…FA 김현수 떠난 자리는",
  canonicalUrl: "https://m.sports.naver.com/kbaseball/article/109/0005585034",
  revision: "article:2b1c9f",
  sectionPath: "2026-08-15",
  asOf: "2026-08-15T09:44:00.000Z",
  sourceGrade: "tier2",
  sourceKind: "news_article",
};

/** 뉴스 recency 판정 기준시각 — `어제` 창이 비지 않도록 한낮으로 고정한다. */
const NOW_MS = Date.parse("2026-08-16T03:00:00.000Z");

/**
 * 네 RAG 경로를 **한 벌의 deps** 로 태운다.
 *
 * 각 경로의 모델 응답을 인자로 받아, 숫자를 넣으면 그 경로가 폐기되고 빼면 서빙된다.
 * ⚠️ 반대경로를 throw 로 막지 않는다 — 그러면 "이 경로가 저 경로를 선점했는가"를 못 본다.
 */
function makeDeps(answers: {
  player?: string;
  official?: string;
  team?: string;
  news?: string;
  officialStatus?: string;
} = {}): {
  deps: QaDeps;
  logs: LogEntry[];
  rawLogs: RawLogEntry[];
  stored: { value: LlmResult | null };
} {
  const logs: LogEntry[] = [];
  const rawLogs: RawLogEntry[] = [];
  const stored: { value: LlmResult | null } = { value: null };
  const deps = {
    enablePlayerRag: true,
    enableTeamRag: true,
    enableNewsRag: true,
    now: () => NOW_MS,
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => rosterPlayers,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => ({
      text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구 이야기입니다." }),
      inputTokens: 1,
      outputTokens: 1,
    }),
    searchRag: async (candidate: { entityType: string }) => (
      candidate.entityType === "team" ? [TEAM_EVIDENCE] : [PLAYER_EVIDENCE]
    ),
    callRagLlm: async () => ({
      text: JSON.stringify({
        status: RAG_GROUNDED_SENTINEL,
        answer: answers.player ?? "문보경 선수는 LG 트윈스 내야수예요.",
      }),
      inputTokens: 10,
      outputTokens: 5,
    }),
    callTeamRagLlm: async () => ({
      text: JSON.stringify({
        status: RAG_GROUNDED_SENTINEL,
        answer: answers.team ?? "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이에요.",
      }),
      inputTokens: 10,
      outputTokens: 5,
    }),
    searchOfficialRag: async () => [OFFICIAL_EVIDENCE],
    callOfficialRagLlm: async () => ({
      text: JSON.stringify({
        status: answers.officialStatus ?? RAG_GROUNDED_SENTINEL,
        answer: answers.official ?? "인필드 플라이 상황에서 타구가 주자에게 닿으면 둘 다 아웃이에요.",
      }),
      inputTokens: 10,
      outputTokens: 5,
    }),
    searchNewsRag: async () => [NEWS_EVIDENCE],
    callNewsRagLlm: async () => ({
      text: JSON.stringify({
        status: RAG_GROUNDED_SENTINEL,
        answer: answers.news ?? "젊은 타자들이 떠난 주전 외야수 자리를 메우고 있어요.",
      }),
      inputTokens: 10,
      outputTokens: 5,
    }),
    storeLlm: async (result: LlmResult) => { stored.value = result; },
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async (entry: {
      matchPath: string;
      ragAttemptPath?: RagAttemptPath | null;
      ragDiscardReason?: RagDiscardReason | null;
      ragDiscardNumericCount?: number | null;
    }) => {
      rawLogs.push({ ...entry });
      logs.push({
        matchPath: entry.matchPath,
        ragAttemptPath: entry.ragAttemptPath,
        ragDiscardReason: entry.ragDiscardReason,
        ragDiscardNumericCount: entry.ragDiscardNumericCount,
      });
    },
  } as unknown as QaDeps;
  return { deps, logs, rawLogs, stored };
}

let rosterPlayers: PlayerRef[] = [];

/** 각 경로를 실제로 태우는 질문 — production 판정기가 그 경로로 보내는 문장이어야 한다. */
const PATH_PROBES: {
  attemptPath: RagAttemptPath;
  question: string;
  /** 숫자를 섞어 폐기시킬 답변. */
  numericAnswer: string;
  /** 서빙되는 정상 답변(숫자 없음). */
  cleanAnswer: string;
  /** 폐기 시 기대 match_path. */
  discardMatchPath: string;
  /** 서빙 시 기대 match_path. */
  servedMatchPath: string;
  key: "player" | "official" | "team" | "news";
}[] = [
  {
    attemptPath: "player",
    question: "문보경 별명 알려줘",
    numericAnswer: "문보경 선수는 2019년에 데뷔한 LG 내야수예요.",
    cleanAnswer: "문보경 선수는 문학소년이라는 별명으로 불려요.",
    discardMatchPath: "unsure",
    servedMatchPath: "rag",
    key: "player",
  },
  {
    attemptPath: "team",
    question: "LG 트윈스 역사 알려줘",
    numericAnswer: "LG 트윈스는 1990년에 MBC 청룡을 인수해 창단했어요.",
    cleanAnswer: "LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이에요.",
    discardMatchPath: "unsure",
    servedMatchPath: "team_rag",
    key: "team",
  },
  {
    attemptPath: "news",
    question: "어제 LG 무슨 일 있었어?",
    numericAnswer: "어제 LG 는 3점을 뽑으며 분위기를 바꿨어요.",
    cleanAnswer: "젊은 타자들이 떠난 주전 외야수 자리를 메우고 있어요.",
    discardMatchPath: "unsure",
    servedMatchPath: "news_rag",
    key: "news",
  },
];

async function run(): Promise<void> {
  rosterPlayers = await loadRosterPlayers();
  assert.ok(rosterPlayers.length > 0, "실제 로스터 loader 가 선수를 돌려줘야 한다");

  // ── ① 폐쇄집합 ↔ migration CHECK 대조 ────────────────────────────────────
  //
  // 게이트가 목록을 다시 적지 않는다. 코드 상수를 그대로 들고 SQL 문면에서 찾는다.
  // 한쪽만 늘리면 배포 후 CHECK 위반(23514)으로 터지므로 여기서 먼저 RED 를 낸다.
  {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const column of ["rag_discard_reason text", "rag_attempt_path text", "rag_discard_numeric_count integer"]) {
      assert.ok(
        new RegExp(`add column if not exists ${column}`, "i").test(sql),
        `migration 이 ${column} 컬럼을 추가하지 않는다`,
      );
    }
    // null 허용이 빠지면 "폐기 없음" 행 전부가 INSERT 실패한다 — 서비스가 죽는 축이다.
    for (const nullable of ["rag_discard_reason is null", "rag_attempt_path is null", "rag_discard_numeric_count is null"]) {
      assert.ok(new RegExp(nullable, "i").test(sql), `CHECK 가 ${nullable} 을 허용하지 않는다`);
    }

    const reasonClause = sql.match(/rag_discard_reason in \(([^)]*)\)/i)?.[1];
    assert.ok(reasonClause, "폐기 사유 CHECK 의 허용 목록을 파싱하지 못했다");
    assert.deepEqual(
      [...reasonClause.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      [...RAG_DISCARD_REASONS].sort(),
      "코드 폐쇄집합과 migration 의 폐기 사유 CHECK 가 어긋난다",
    );

    const pathClause = sql.match(/rag_attempt_path in \(([^)]*)\)/i)?.[1];
    assert.ok(pathClause, "경로 CHECK 의 허용 목록을 파싱하지 못했다");
    assert.deepEqual(
      [...pathClause.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      [...RAG_ATTEMPT_PATHS].sort(),
      "코드 경로 집합과 migration CHECK 가 어긋난다",
    );

    assert.ok(/rag_discard_numeric_count >= 0/.test(sql), "숫자 개수 음수 가드가 없다");
    ok(`① 폐쇄집합 ↔ CHECK 일치 (사유 ${RAG_DISCARD_REASONS.length}종 · 경로 ${RAG_ATTEMPT_PATHS.length}종)`);
  }

  // ── ② validateRagResponse 가 각 사유·숫자개수를 실제로 돌려주는가 ────────
  //
  // 사유 문자열을 게이트가 지어내지 않는다 — 배포 함수에 실 입력을 먹여 나온 값을 본다.
  {
    const cases: { label: string; raw: string; expect: RagDiscardReason; count?: number }[] = [
      { label: "깨진 JSON", raw: "{not json", expect: "malformed_json" },
      {
        label: "숫자 섞인 tier2 답변",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "LG 트윈스는 1990년에 창단했어요." }),
        expect: "numeric_claim_ungrounded",
        count: 1,
      },
      {
        label: "수치 나열 tier2 답변",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "1990년 창단, 우승 3회, 준우승 2회예요." }),
        expect: "numeric_claim_ungrounded",
        count: 3,
      },
      {
        label: "빈 답변",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "   " }),
        expect: "empty_answer",
        count: 0,
      },
      {
        label: "링크 포함",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "자세한 내용은 https://example.com 참고" }),
        expect: "unsafe_output",
      },
      { label: "모델 자체 판정", raw: JSON.stringify({ status: "INSUFFICIENT" }), expect: "model_insufficient" },
    ];
    for (const c of cases) {
      const v = validateRagResponse(c.raw);
      assert.equal(v.kind, "insufficient", `${c.label} 이 폐기되지 않았다`);
      assert.equal(v.reason, c.expect, `${c.label} 사유가 ${(v as { reason: string }).reason}`);
      assert.ok(
        (RAG_DISCARD_REASONS as readonly string[]).includes(v.reason),
        `폐쇄집합 밖 사유: ${v.reason}`,
      );
      if (c.count !== undefined) {
        assert.equal(
          (v as { numericCount?: number }).numericCount, c.count,
          `${c.label} 숫자 개수가 ${(v as { numericCount?: number }).numericCount}`,
        );
      }
    }
    // 개수 세는 규칙이 서빙 판정과 같은 토큰 규칙인지 — 다르면 분포 해석이 어긋난다.
    assert.equal(numericTokenCount("1990년 우승 3회"), 2);
    assert.equal(numericTokenCount("타율 0.312"), 1, "소수는 한 토큰이어야 한다");
    assert.equal(numericTokenCount("숫자 없는 문장"), 0);
    ok(`② validateRagResponse 사유·숫자개수 ${cases.length}종`);
  }

  // ── ③ 종단 — 네 경로 전부, 폐기와 서빙 양쪽 (삼순 ③) ────────────────────
  //
  // 이 게이트의 핵심이다. 사유·경로가 pipeline 을 거쳐 log 항목까지 도달하지 않으면
  // 컬럼이 있어도 production 은 영원히 null 이다(#1177 회차의 단절과 같은 유형).
  // ⚠️ 성공 행에도 경로가 실려야 한다 — 폐기에만 실으면 분자만 있고 분모가 없다.
  for (const probe of PATH_PROBES) {
    {
      const { deps, logs } = makeDeps({ [probe.key]: probe.numericAnswer });
      const result = await answerQuestion(`u-discard-${probe.attemptPath}`, probe.question, deps);
      const last = logs.at(-1);
      assert.ok(last, `[${probe.attemptPath}] 로그가 기록되지 않았다`);
      assert.equal(
        last.ragDiscardReason, "numeric_claim_ungrounded",
        `[${probe.attemptPath}] 숫자 폐기 사유가 로그에 없다: ${JSON.stringify(last)} (source=${result.source})`,
      );
      assert.equal(
        last.ragAttemptPath, probe.attemptPath,
        `[${probe.attemptPath}] 폐기 행에 경로가 실리지 않았다: ${JSON.stringify(last)}`,
      );
      assert.ok(
        typeof last.ragDiscardNumericCount === "number" && last.ragDiscardNumericCount > 0,
        `[${probe.attemptPath}] 숫자 개수가 실리지 않았다: ${JSON.stringify(last)}`,
      );
      assert.equal(last.matchPath, probe.discardMatchPath, `[${probe.attemptPath}] 폐기 match_path 가 바뀌었다`);
    }
    {
      const { deps, logs } = makeDeps({ [probe.key]: probe.cleanAnswer });
      const result = await answerQuestion(`u-served-${probe.attemptPath}`, probe.question, deps);
      const served = logs.find((row) => row.matchPath === probe.servedMatchPath);
      assert.ok(served, `[${probe.attemptPath}] 서빙 로그가 없다: ${JSON.stringify(logs)} (source=${result.source})`);
      assert.ok(
        served.ragDiscardReason == null,
        `[${probe.attemptPath}] 서빙 답변에 폐기 사유가 붙었다: ${served.ragDiscardReason}`,
      );
      assert.equal(
        served.ragAttemptPath, probe.attemptPath,
        `[${probe.attemptPath}] **서빙 행에 경로가 없다** — 분모가 없어 폐기율을 못 낸다: ${JSON.stringify(served)}`,
      );
      assert.ok(
        served.ragDiscardNumericCount == null,
        `[${probe.attemptPath}] 서빙 행에 숫자 개수가 붙었다: ${served.ragDiscardNumericCount}`,
      );
    }
    ok(`③ 종단 ${probe.attemptPath} — 폐기(사유+경로+개수) / 서빙(경로만)`);
  }

  // ── ③-b 공식(official) 경로 — GENERAL 출구까지 (다른 셋과 구조가 다르다) ──
  //
  // 공식 경로만 `GENERAL` 출구가 있어 `match_path='llm'` 로 서빙된다. 그 경로도 경로 라벨이
  // 실려야 "공식 근거로는 못 답했지만 일반 지식으로 답한" 비율을 뽑을 수 있다.
  {
    const { deps, logs } = makeDeps({
      official: "인필드 플라이는 1루와 2루에 주자가 있을 때 선고돼요.",
    });
    const result = await answerQuestion("u-discard-official", "인필드 플라이 규칙 알려줘", deps);
    const last = logs.at(-1);
    assert.ok(last, "official 로그가 없다");
    assert.ok(
      last.ragDiscardReason != null,
      `official 폐기 사유가 없다: ${JSON.stringify(last)} (source=${result.source})`,
    );
    assert.equal(last.ragAttemptPath, "official", `official 경로 라벨이 없다: ${JSON.stringify(last)}`);
    ok(`③-b 종단 official — 폐기 사유 ${last.ragDiscardReason} + 경로 라벨`);
  }
  {
    const { deps, logs } = makeDeps();
    await answerQuestion("u-served-official", "인필드 플라이 규칙 알려줘", deps);
    const served = logs.at(-1);
    assert.ok(served, "official 서빙 로그가 없다");
    assert.equal(
      served.ragAttemptPath, "official",
      `official 서빙 행에 경로가 없다: ${JSON.stringify(served)}`,
    );
    assert.ok(served.ragDiscardReason == null, "official 서빙 행에 폐기 사유가 붙었다");
    ok(`③-c 종단 official 서빙 (match_path=${served.matchPath})`);
  }

  // ── ④ crash replay — store 성공 후 log 전 crash 에서 관측이 살아남는가 (삼순 ②) ──
  //
  // 네 경로 모두 final envelope 를 먼저 저장하고 로그를 나중에 쓴다. envelope 에 관측이
  // 없으면 재생 경로가 관측을 null 로 다시 써 계측이 유실된다(`toneCompliant` 와 같은 축).
  {
    const { deps, logs, stored } = makeDeps({ team: "LG 트윈스는 1990년에 창단했어요." });
    await answerQuestion("u-crash-1", "LG 트윈스 역사 알려줘", deps);
    assert.ok(stored.value, "envelope 가 저장되지 않았다");
    const envelope = unpackStoredQaFinal(stored.value.text);
    assert.ok(envelope, "envelope 를 복원하지 못했다");
    assert.equal(
      envelope.ragDiscardReason, "numeric_claim_ungrounded",
      `envelope 에 폐기 사유가 없다 — crash 재생 시 유실된다: ${JSON.stringify(envelope)}`,
    );
    assert.equal(envelope.ragAttemptPath, "team", "envelope 에 경로가 없다");
    assert.ok(
      typeof envelope.ragDiscardNumericCount === "number",
      "envelope 에 숫자 개수가 없다",
    );

    // 실제 재생: `getLlmState` 가 저장된 envelope 를 돌려주는 상태에서 재실행한다.
    const beforeReplay = logs.length;
    const replayDeps = {
      ...(makeDeps().deps as Record<string, unknown>),
      getLlmState: async () => ({ started: true, result: stored.value, ownerActive: false }),
      log: async (entry: {
        matchPath: string;
        ragAttemptPath?: RagAttemptPath | null;
        ragDiscardReason?: RagDiscardReason | null;
        ragDiscardNumericCount?: number | null;
      }) => {
        logs.push({
          matchPath: entry.matchPath,
          ragAttemptPath: entry.ragAttemptPath,
          ragDiscardReason: entry.ragDiscardReason,
          ragDiscardNumericCount: entry.ragDiscardNumericCount,
        });
      },
    } as unknown as QaDeps;
    await answerQuestion("u-crash-1", "LG 트윈스 역사 알려줘", replayDeps);
    const replayed = logs.at(-1);
    assert.ok(logs.length > beforeReplay, "재생이 로그를 쓰지 않았다");
    assert.equal(
      replayed.ragDiscardReason, "numeric_claim_ungrounded",
      `**재생에서 폐기 사유가 유실됐다** — store 성공 후 crash 하면 계측이 사라진다: ${JSON.stringify(replayed)}`,
    );
    assert.equal(replayed.ragAttemptPath, "team", `재생에서 경로가 유실됐다: ${JSON.stringify(replayed)}`);
    assert.ok(
      typeof replayed.ragDiscardNumericCount === "number",
      `재생에서 숫자 개수가 유실됐다: ${JSON.stringify(replayed)}`,
    );
    ok("④ crash replay — envelope 보존 + 재생 로그 관측 유지");
  }

  // ── ④-b 서빙 답변도 재생에서 경로가 살아남는가 (분모 유실 차단) ──────────
  {
    const { deps, logs, stored } = makeDeps();
    await answerQuestion("u-crash-2", "어제 LG 무슨 일 있었어?", deps);
    assert.ok(stored.value, "뉴스 envelope 가 저장되지 않았다");
    const envelope = unpackStoredQaFinal(stored.value.text);
    assert.ok(envelope, "뉴스 envelope 복원 실패");
    assert.equal(envelope.ragAttemptPath, "news", `서빙 envelope 에 경로가 없다: ${JSON.stringify(envelope)}`);
    assert.ok(envelope.ragDiscardReason == null, "서빙 envelope 에 폐기 사유가 붙었다");

    const replayDeps = {
      ...(makeDeps().deps as Record<string, unknown>),
      getLlmState: async () => ({ started: true, result: stored.value, ownerActive: false }),
      log: async (entry: { matchPath: string; ragAttemptPath?: RagAttemptPath | null }) => {
        logs.push({
          matchPath: entry.matchPath,
          ragAttemptPath: entry.ragAttemptPath,
          ragDiscardReason: null,
          ragDiscardNumericCount: null,
        });
      },
    } as unknown as QaDeps;
    await answerQuestion("u-crash-2", "어제 LG 무슨 일 있었어?", replayDeps);
    assert.equal(
      logs.at(-1)?.ragAttemptPath, "news",
      `서빙 재생에서 경로가 유실됐다 — 분모가 깎인다: ${JSON.stringify(logs.at(-1))}`,
    );
    ok("④-b crash replay — 서빙 행 경로 보존");
  }

  // ── ④-c 구버전/오염 envelope 는 폐쇄집합 밖 값을 버린다 ──────────────────
  //
  // envelope 는 **이전 배포**가 쓴 것일 수 있다. 폐쇄집합 밖 값을 그대로 log 로 보내면
  // DB CHECK 위반(23514)으로 로그 INSERT 자체가 죽는다 — 관측 유실이 서빙 실패보다 낫다.
  {
    const poisoned = packStoredQaFinal(
      {
        answer: "테스트 답변이에요.", source: "team_rag",
        ragAttemptPath: "made_up_path" as RagAttemptPath,
        ragDiscardReason: "totally_new_reason" as RagDiscardReason,
        ragDiscardNumericCount: -3,
      },
      { text: "", inputTokens: 1, outputTokens: 1 },
    );
    const restored = unpackStoredQaFinal(poisoned.text);
    assert.ok(restored, "오염 envelope 복원 실패");
    assert.ok(restored.ragAttemptPath === undefined, `폐쇄집합 밖 경로가 살아남았다: ${restored.ragAttemptPath}`);
    assert.ok(restored.ragDiscardReason === undefined, `폐쇄집합 밖 사유가 살아남았다: ${restored.ragDiscardReason}`);
    assert.ok(restored.ragDiscardNumericCount === undefined, `음수 개수가 살아남았다: ${restored.ragDiscardNumericCount}`);
    ok("④-c 오염 envelope 폐쇄집합 밖 값 폐기 (23514 차단)");
  }

  // ── ⑤ log-row SSOT 가 그 값을 실제 컬럼으로 옮기는가 ────────────────────
  //
  // pipeline 이 값을 넘겨도 INSERT 행에 칸이 없으면 production 은 계속 null 이다
  // (삼순 2026-08-13 ① 과 정확히 같은 단절).
  {
    const row = buildQuestionLogRow(
      {
        userId: "u", question: "q", questionNorm: "q",
        matchPath: "unsure", answer: null, inputTokens: null, outputTokens: null,
        ragDiscardReason: "numeric_claim_ungrounded",
        ragAttemptPath: "news",
        ragDiscardNumericCount: 2,
      } as Parameters<typeof buildQuestionLogRow>[0],
      4242,
    );
    assert.equal(row.rag_discard_reason, "numeric_claim_ungrounded", "INSERT 행에 사유가 없다");
    assert.equal(row.rag_attempt_path, "news", "INSERT 행에 경로가 없다");
    assert.equal(row.rag_discard_numeric_count, 2, "INSERT 행에 숫자 개수가 없다");

    const nullRow = buildQuestionLogRow(
      {
        userId: "u", question: "q", questionNorm: "q",
        matchPath: "dictionary", answer: "a", inputTokens: null, outputTokens: null,
      } as Parameters<typeof buildQuestionLogRow>[0],
      4242,
    );
    assert.equal(nullRow.rag_discard_reason, null, "비RAG 행의 사유가 null 이 아니다");
    assert.equal(nullRow.rag_attempt_path, null, "비RAG 행의 경로가 null 이 아니다");
    assert.equal(nullRow.rag_discard_numeric_count, null, "비RAG 행의 개수가 null 이 아니다");
    ok("⑤ log-row SSOT 컬럼 매핑");
  }

  // ── ⑥ 서버가 그 SSOT 로 INSERT 하는가 (배포 코드 대조) ──────────────────
  {
    const serverSrc = readFileSync(path.join(process.cwd(), "src/lib/baseball-qa/server.ts"), "utf8");
    assert.ok(
      /from\("genius_question_logs"\)\s*\n?\s*\.insert\(buildQuestionLogRow\(/.test(serverSrc),
      "server.ts 가 buildQuestionLogRow 로 질문로그를 insert 하지 않는다(우회 경로 존재)",
    );
    ok("⑥ server.ts INSERT 배선");
  }

  // ── ⑦ 원문 비저장 계약 — 폐기 본문이 로그로 새지 않는다 (삼순 익명집계 조건) ──
  {
    // 폐기 답변에만 있는 고유 문자열 — 로그 어디에도 나오면 안 된다.
    const secret = "구단 창단 연도는 1990년이고 우승은 3회예요";
    const made = makeDeps({ team: secret });
    await answerQuestion("u-privacy", "LG 트윈스 역사 알려줘", made.deps);
    // ⚠️ 추린 4칸이 아니라 **pipeline 이 넘긴 항목 전체**를 본다 — 게이트가 안 보는 필드로
    //   본문이 새면 4칸 대조는 통과한다(구조적 false-green).
    const serialized = JSON.stringify(made.rawLogs);
    assert.ok(!serialized.includes(secret), `폐기된 답변 본문이 로그로 샜다: ${serialized}`);
    assert.ok(!serialized.includes("1990"), `폐기된 답변의 숫자 값이 로그로 샜다: ${serialized}`);
    assert.ok(!serialized.includes("우승은 3회"), `폐기된 답변 일부가 로그로 샜다: ${serialized}`);
    ok("⑦ 폐기 본문·숫자 값 비저장 (개수만) — 로그 항목 전수 대조");
  }

  console.log(`\n✅ genius-discard-reason 게이트 ${passed}축 PASS`);
}

run().catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
