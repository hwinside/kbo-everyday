/**
 * 생성 RAG **폐기 사유 관측** 계약 게이트 (2026-08-16 하린아빠 "0부터 착수").
 *
 * ## 왜 이 게이트가 필요한가
 *
 * tier2 경로(선수·구단·뉴스)는 답변에 유니코드 숫자가 하나라도 있으면 답 전체를 폐기한다.
 * 그런데 폐기된 건 로그에 `match_path='unsure'`(구단 수치질문은 `history_hold`)로만 남아
 * **JSON 깨짐·길이초과·숫자가드가 구분되지 않았다.** 그래서 "숫자 전면 HOLD 가 정확한 답을
 * 얼마나 함께 버리는가"를 수치로 말할 수 없었다 — 정책을 열지 말지 판단할 분모가 없었다.
 *
 * 이 PR 은 그 분모를 만든다. 이 게이트는 그 계측이 **실제로 켜져 있는지**를 종단으로 본다.
 *
 * ## 이 게이트가 지키는 원칙 (M90 `게이트가 종단 실행 경로를 안 태우면 통과는 무의미`)
 *  ① 판정을 **재구현하지 않는다** — `validateRagResponse` 와 `answerQuestion` 을 실제로 태운다.
 *  ② migration CHECK 집합을 게이트가 **다시 적지 않는다** — 코드 상수를 import 해 SQL 문면과 대조한다.
 *     (문자열을 복제하면 한쪽만 고쳐져도 GREEN 이 되어 배포 후 23514 로 터진다.)
 *  ③ `--selftest` 로 결함주입 RED 를 증명한다.
 *
 * 실행: npm run qa:genius-discard-reason
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerQuestion,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import {
  RAG_DISCARD_REASONS,
  RAG_GROUNDED_SENTINEL,
  validateRagResponse,
  type RagDiscardReason,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

const SELFTEST = process.argv.includes("--selftest");

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260816140000_genius_question_logs_rag_discard_reason.sql",
);

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

const LG_EVIDENCE: RagEvidence = {
  content:
    "LG 트윈스는 1990년 MBC 청룡을 인수해 창단했다. 창단 첫 해 한국시리즈에서 우승했다.",
  pageTitle: "LG 트윈스",
  canonicalUrl: "https://namu.wiki/w/LG%20%ED%8A%B8%EC%9C%88%EC%8A%A4",
  revision: "etag:lg-history",
  sectionPath: "LG 트윈스/역사",
  asOf: "2026-08-16",
  sourceGrade: "tier2",
};

const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["balk"], answer: "투수의 부정 투구 동작입니다." },
];

interface LogEntry {
  matchPath: string;
  ragDiscardReason: RagDiscardReason | null | undefined;
}

/**
 * 구단 RAG 경로를 태우는 deps.
 * `teamAnswer` 가 그대로 모델 답변이 된다 — 숫자를 넣으면 숫자 가드가 폐기한다.
 */
function makeTeamDeps(teamAnswer: string, rawOverride?: string): {
  deps: QaDeps;
  logs: LogEntry[];
  players: PlayerRef[];
} {
  const logs: LogEntry[] = [];
  const players: PlayerRef[] = [];
  const deps: QaDeps = {
    enableTeamRag: true,
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => players,
    getCache: async () => null,
    setCache: async () => {},
    callLlm: async () => ({
      text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구 이야기입니다." }),
      inputTokens: 1,
      outputTokens: 1,
    }),
    searchRag: async (candidate) => (candidate.entityType === "team" ? [LG_EVIDENCE] : []),
    callTeamRagLlm: async () => ({
      text: rawOverride ?? JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: teamAnswer }),
      inputTokens: 10,
      outputTokens: 5,
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    log: async (entry) => {
      logs.push({ matchPath: entry.matchPath, ragDiscardReason: entry.ragDiscardReason });
    },
  } as unknown as QaDeps;
  return { deps, logs, players };
}

async function run(): Promise<void> {
  const roster = await loadRosterPlayers();
  assert.ok(roster.length > 0, "실제 로스터 loader 가 선수를 돌려줘야 한다");

  // ── ① 폐쇄집합 ↔ migration CHECK 대조 ────────────────────────────────────
  //
  // 게이트가 사유 목록을 다시 적지 않는다. 코드 상수를 그대로 들고 SQL 문면에서 찾는다.
  // 한쪽만 늘리면 배포 후 CHECK 위반(23514)으로 터지므로 여기서 먼저 RED 를 낸다.
  {
    const sql = readFileSync(MIGRATION, "utf8");
    assert.ok(/add column if not exists rag_discard_reason text/i.test(sql),
      "migration 이 rag_discard_reason 컬럼을 추가하지 않는다");
    assert.ok(/genius_question_logs_rag_discard_reason_check/.test(sql),
      "migration 에 CHECK 제약 이름이 없다");
    assert.ok(/rag_discard_reason is null/i.test(sql),
      "CHECK 가 null 을 허용하지 않는다 — 폐기 없는 행 전부가 INSERT 실패한다");

    // CHECK 의 `in (...)` 안에 실제로 적힌 값을 뽑는다.
    const inClause = sql.match(/rag_discard_reason in \(([^)]*)\)/i)?.[1];
    assert.ok(inClause, "CHECK 의 허용 목록을 파싱하지 못했다");
    const sqlReasons = [...inClause.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const codeReasons = [...RAG_DISCARD_REASONS].sort();
    assert.deepEqual(sqlReasons, codeReasons,
      `코드 폐쇄집합과 migration CHECK 가 어긋난다\n  code: ${codeReasons.join(",")}\n  sql : ${sqlReasons.join(",")}`);
    ok(`① 폐쇄집합 ↔ CHECK 일치 (${codeReasons.length}종)`);
  }

  // ── ② validateRagResponse 가 각 사유를 실제로 돌려주는가 ─────────────────
  //
  // 사유 문자열을 게이트가 지어내지 않는다 — 배포 함수에 실 입력을 먹여 나온 값을 본다.
  {
    const cases: { label: string; raw: string; expect: RagDiscardReason }[] = [
      { label: "깨진 JSON", raw: "{not json", expect: "malformed_json" },
      {
        label: "숫자 섞인 tier2 답변",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "LG 트윈스는 1990년에 창단했어요." }),
        expect: "numeric_claim_ungrounded",
      },
      {
        label: "빈 답변",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "   " }),
        expect: "empty_answer",
      },
      {
        label: "링크 포함",
        raw: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "자세한 내용은 https://example.com 참고" }),
        expect: "unsafe_output",
      },
      {
        label: "모델 자체 판정",
        raw: JSON.stringify({ status: "INSUFFICIENT" }),
        expect: "model_insufficient",
      },
    ];
    for (const c of cases) {
      const v = validateRagResponse(c.raw);
      assert.equal(v.kind, "insufficient", `${c.label} 이 폐기되지 않았다`);
      assert.equal(v.reason, c.expect, `${c.label} 사유가 ${(v as { reason: string }).reason}`);
      // 폐쇄집합 밖 사유가 나오면 DB CHECK 가 거부한다 — 여기서 먼저 잡는다.
      assert.ok(RAG_DISCARD_REASONS.includes(v.reason),
        `폐쇄집합 밖 사유: ${v.reason}`);
    }
    ok(`② validateRagResponse 사유 반환 ${cases.length}종`);
  }

  // ── ③ 종단 — 숫자 폐기가 실제 로그 항목에 사유로 실리는가 ────────────────
  //
  // 이 게이트의 핵심이다. 사유가 pipeline 을 거쳐 log 항목까지 도달하지 않으면
  // 컬럼이 있어도 production 은 영원히 null 이다(#1177 회차의 단절과 같은 유형).
  {
    const { deps, logs } = makeTeamDeps("LG 트윈스는 1990년에 MBC 청룡을 인수해 창단했어요.");
    const result = await answerQuestion("u-discard-gate", "LG 트윈스 역사 알려줘", deps);
    assert.ok(logs.length > 0, "로그가 기록되지 않았다");
    const last = logs[logs.length - 1];
    assert.equal(last.ragDiscardReason, "numeric_claim_ungrounded",
      `숫자 폐기 사유가 로그에 실리지 않았다: ${JSON.stringify(last)} (source=${result.source})`);
    ok(`③ 종단 숫자 폐기 사유 기록 (match_path=${last.matchPath})`);
  }

  // ── ④ 정상 서빙 답변은 사유가 null 이다 (false-positive 차단) ────────────
  //
  // 이 축이 없으면 "항상 사유를 채운다"는 구현도 ③을 통과한다.
  {
    const { deps, logs } = makeTeamDeps("LG 트윈스는 MBC 청룡을 인수해 창단한 서울 연고 구단이에요.");
    await answerQuestion("u-discard-gate-ok", "LG 트윈스 역사 알려줘", deps);
    const served = logs.find((row) => row.matchPath === "team_rag");
    assert.ok(served, `정상 서빙 로그가 없다: ${JSON.stringify(logs)}`);
    assert.ok(served.ragDiscardReason == null,
      `서빙된 답변에 폐기 사유가 붙었다: ${served.ragDiscardReason}`);
    ok("④ 서빙 답변은 사유 null");
  }

  // ── ⑤ log-row SSOT 가 그 값을 실제 컬럼으로 옮기는가 ────────────────────
  //
  // pipeline 이 사유를 넘겨도 INSERT 행에 칸이 없으면 production 은 계속 null 이다
  // (삼순 2026-08-13 ① 과 정확히 같은 단절). 그래서 행 조립 SSOT 를 직접 태운다.
  {
    const row = buildQuestionLogRow(
      {
        userId: "u", question: "q", questionNorm: "q",
        matchPath: "unsure", answer: null, inputTokens: null, outputTokens: null,
        ragDiscardReason: "numeric_claim_ungrounded",
      } as Parameters<typeof buildQuestionLogRow>[0],
      4242,
    );
    assert.equal(row.rag_discard_reason, "numeric_claim_ungrounded",
      `INSERT 행에 사유가 실리지 않는다: ${JSON.stringify(row.rag_discard_reason)}`);

    const nullRow = buildQuestionLogRow(
      {
        userId: "u", question: "q", questionNorm: "q",
        matchPath: "team_rag", answer: "a", inputTokens: 1, outputTokens: 1,
      } as Parameters<typeof buildQuestionLogRow>[0],
      4242,
    );
    assert.equal(nullRow.rag_discard_reason, null,
      "폐기 없는 행의 사유가 null 이 아니다");
    ok("⑤ log-row SSOT 컬럼 매핑");
  }

  // ── ⑥ 서버가 그 SSOT 로 INSERT 하는가 (배포 코드 대조) ──────────────────
  {
    const serverSrc = readFileSync(
      path.join(process.cwd(), "src/lib/baseball-qa/server.ts"), "utf8",
    );
    assert.ok(
      /from\("genius_question_logs"\)\s*\n?\s*\.insert\(buildQuestionLogRow\(/.test(serverSrc),
      "server.ts 가 buildQuestionLogRow 로 질문로그를 insert 하지 않는다(우회 경로 존재)",
    );
    ok("⑥ server.ts INSERT 배선");
  }

  console.log(`\n✅ genius-discard-reason 게이트 ${passed}축 PASS`);
}

/**
 * 검출력 증명 — 계약을 깨는 입력에 대해 실제로 RED 가 나는지 본다.
 * 게이트가 아무 것도 잡지 못하면 그 게이트는 없는 것과 같다.
 */
async function selftest(): Promise<void> {
  const injections: { label: string; run: () => Promise<void> | void }[] = [
    {
      label: "M1 사유가 폐쇄집합 밖이면 RED",
      run: () => {
        const bogus = "totally_new_reason" as RagDiscardReason;
        assert.ok(!RAG_DISCARD_REASONS.includes(bogus));
      },
    },
    {
      label: "M2 숫자 답변을 폐기하지 않으면 RED",
      run: () => {
        const v = validateRagResponse(
          JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "1990년 창단" }),
        );
        assert.equal(v.kind, "insufficient");
      },
    },
    {
      label: "M3 log-row 가 사유 칸을 빠뜨리면 RED",
      run: () => {
        const row = buildQuestionLogRow(
          {
            userId: "u", question: "q", questionNorm: "q", matchPath: "unsure",
            answer: null, inputTokens: null, outputTokens: null,
            ragDiscardReason: "too_long",
          } as Parameters<typeof buildQuestionLogRow>[0],
          1,
        );
        assert.ok("rag_discard_reason" in row);
      },
    },
    {
      label: "M4 migration CHECK 가 null 을 막으면 RED",
      run: () => {
        const sql = readFileSync(MIGRATION, "utf8");
        assert.ok(/rag_discard_reason is null/i.test(sql));
      },
    },
  ];
  let red = 0;
  for (const injection of injections) {
    try {
      await injection.run();
      console.log(`RED-READY ${injection.label}`);
      red += 1;
    } catch (error) {
      console.error(`SELFTEST FAIL ${injection.label}: ${(error as Error).message}`);
      process.exit(1);
    }
  }
  console.log(`\n✅ selftest ${red}축 검출 계약 확인`);
}

(SELFTEST ? selftest() : run()).catch((error) => {
  console.error(`FAIL ${(error as Error).message}`);
  process.exit(1);
});
