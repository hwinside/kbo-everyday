/**
 * 야잘알봇 **거절·범위 안내 계약** — `answerQuestion()` 실제 실행 결과로 검증한다.
 *
 * ⚠️ 이 게이트가 생긴 이유 (2026-08-08 운영 로그 전수 판독, 최근 3일 미답변 196건).
 *
 * 사고는 두 가지였고 **둘 다 문구가 실제 능력과 어긋난 것**이었다.
 *
 *   ① 거절 문구가 출시 초기 범위(`야구 룰/용어만`)에 멈춰 있었다. 그 사이 구단 RAG(#1110)·
 *      선수 RAG·시즌 기록(`kbo_structured`)·최신 기사 RAG(#1127)가 전부 배포돼 봇은 이미
 *      그것들을 답한다. 안내가 실제보다 좁으면 유저는 **답할 수 있는 질문을 아예 안 한다**.
 *   ② 그 좁은 안내를 유저가 그대로 따라 `야구 룰` 이라고 물으면 다시 되물었다 —
 *      `야구 룰`(4) `야구 규칙`(3) `야구 룰 알려줘`(3) … 3일간 **16건**. 우리 안내문이
 *      만든 질문에 우리가 답을 못 한 것이다.
 *
 * 그래서 이 게이트는 **문자열이 존재하는지**를 보지 않는다(그건 주석에도 걸린다 — #1127
 * M15 false-green). 두 가지를 본다:
 *   (a) 실제 배포 상수의 **문구**가 `ANSWER_PATH_SCOPE_WORD` SSOT 의 범위어를 전부 담는가.
 *       SSOT 는 `MATCH_PATH_REPLY_KIND` 에서 `answer` 로 선언된 경로에 타입으로 묶여 있어,
 *       새 답변 경로를 추가하면 범위어가 늘고 → 이 게이트가 문구 갱신을 강제한다.
 *   (b) 배포 `answerQuestion()` 을 실제로 호출했을 때 그 문장이 **어느 경로로 끝나고
 *       무슨 문자열을 돌려주는가**. 라우팅만 보면 뒤에서 덮이는 걸 못 본다(#1127 2차 NO-GO).
 *
 * 실행: npm run qa:genius-refusal-scope
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  routeQuestion,
  isScopeAskPhrase,
  isAckPhrase,
  BLOCKED_ANSWER,
  UNCLEAR_ANSWER,
  UNSURE_ANSWER,
  SCOPE_GUIDE_ANSWER,
  CONTEXT_MISSING_ANSWER,
  SERVICE_REDIRECT_ANSWER,
  ACK_ANSWER,
  type GlossaryEntry,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  ANSWER_PATH_SCOPE_WORD,
  MATCH_PATH_REPLY_KIND,
} from "../../src/lib/constants/baseball-genius";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
function check(name: string, fn: () => void) {
  fn();
  pass += 1;
  console.log(`PASS ${name}`);
}

/** top-level await 을 못 쓰는 tsx(cjs) 환경이라 전부 main() 안에서 돈다. */
async function main() {

/** 로스터는 **실제 배포 로더**로 읽는다 — 자체 fixture 는 loader 결함을 GREEN 으로 만든다. */
let players: PlayerRef[] = [];
const GLOSSARY: GlossaryEntry[] = [
  { term: "보크", aliases: ["보크"], answer: "투수의 부정 투구 동작이에요." },
];

interface Calls {
  llm: number;
  cache: number;
  quota: number;
}

/**
 * 외부 의존은 전부 카운트한다 — 결정론 경로가 외부를 안 타는 것도 계약이다.
 * (범위 안내를 LLM 으로 만들면 매번 토큰을 쓰고 문구가 흔들린다.)
 */
function makeDeps(): { deps: QaDeps; logs: { matchPath: string; answer: string | null }[]; calls: Calls } {
  const logs: { matchPath: string; answer: string | null }[] = [];
  const calls: Calls = { llm: 0, cache: 0, quota: 0 };
  const deps: QaDeps = {
    loadGlossary: async () => GLOSSARY,
    loadPlayers: async () => players,
    getCache: async () => {
      calls.cache += 1;
      return null;
    },
    setCache: async () => {},
    callLlm: async () => {
      calls.llm += 1;
      return {
        text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "LLM 생성답입니다." }),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    reserveDaily: async () => {
      calls.quota += 1;
      return { allowed: true, remaining: 19 };
    },
    log: async (entry) => {
      logs.push({ matchPath: entry.matchPath, answer: entry.answer });
    },
  } as unknown as QaDeps;
  return { deps, logs, calls };
}

async function ask(question: string) {
  const { deps, logs, calls } = makeDeps();
  const result = await answerQuestion("u-refusal-gate", question, deps);
  return { result, logs, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 문구가 실제 답변 능력을 전부 담는가 (SSOT 대조)
// ─────────────────────────────────────────────────────────────────────────────

players = loadRosterPlayers();

check("SSOT — ANSWER_PATH_SCOPE_WORD 는 `answer` 경로를 빠짐없이 덮는다", () => {
  const answerPaths = Object.entries(MATCH_PATH_REPLY_KIND)
    .filter(([, kind]) => kind === "answer")
    .map(([path]) => path)
    .sort();
  const scoped = Object.keys(ANSWER_PATH_SCOPE_WORD).sort();
  assert.deepEqual(
    scoped,
    answerPaths,
    `답변 경로와 범위어 표가 어긋났다. answer=${answerPaths.join(",")} / scope=${scoped.join(",")}`,
  );
  // 표가 비어 있으면 아래 대조가 전부 공허하게 통과한다 — 하한을 못 박는다.
  assert.ok(answerPaths.length >= 7, `답변 경로가 ${answerPaths.length}개뿐이다 — 표가 유실됐다`);
});

const SCOPE_WORDS = [...new Set(Object.values(ANSWER_PATH_SCOPE_WORD))];

check("범위밖 안내문이 답변 가능한 범위를 전부 밝힌다", () => {
  for (const word of SCOPE_WORDS) {
    assert.ok(
      BLOCKED_ANSWER.includes(word),
      `거절 문구에 범위어 "${word}" 가 없다 — 실제로 답할 수 있는데 못 한다고 말하고 있다.\n문구: ${BLOCKED_ANSWER}`,
    );
  }
});

check("범위 되묻기 안내문이 답변 가능한 범위를 전부 밝힌다", () => {
  for (const word of SCOPE_WORDS) {
    assert.ok(
      SCOPE_GUIDE_ANSWER.includes(word),
      `범위 안내문에 범위어 "${word}" 가 없다.\n문구: ${SCOPE_GUIDE_ANSWER}`,
    );
  }
});

check("범위 안내문은 나열로 끝나지 않고 바로 쓸 수 있는 예시를 준다", () => {
  // 범위만 나열하면 유저는 또 뭘 물을지 골라야 하고, 그 부담 때문에 그냥 나간다.
  const examples = (SCOPE_GUIDE_ANSWER.match(/"[^"]+"/g) ?? []).length;
  assert.ok(examples >= 3, `예시가 ${examples}개뿐이다 — 최소 3개는 준다`);
});

check("어느 안내문도 구범위(`룰/용어만`) 표현을 남기지 않는다", () => {
  // 종전 사고의 정확한 문자열. 주석이 아니라 **배포되는 상수 값**만 본다.
  const shipped = {
    BLOCKED_ANSWER,
    UNCLEAR_ANSWER,
    UNSURE_ANSWER,
    SCOPE_GUIDE_ANSWER,
    CONTEXT_MISSING_ANSWER,
    SERVICE_REDIRECT_ANSWER,
  };
  for (const [name, text] of Object.entries(shipped)) {
    assert.ok(
      !/룰\/용어/.test(text),
      `${name} 에 구범위 표현 "룰/용어" 가 남아 있다: ${text}`,
    );
  }
});

check("배포 판정 프롬프트도 판정 기준을 선언 범위와 같게 쓴다", () => {
  // 프롬프트가 범위를 ①~④로 선언해 놓고 마지막 줄에서 "룰/용어가 아니면 UNSURE" 라고
  // 하면, 모델은 마지막 지시를 따라 구단·선수·기록 질문을 UNSURE 로 닫는다.
  // 실측: 최근 3일 미답변 196건 중 unsure 83건(42%).
  assert.ok(
    !/야구 룰\/용어인지 확실하지 않으면/.test(BASEBALL_QA_SYSTEM_PROMPT),
    "판정 프롬프트가 범위를 룰/용어로 좁히는 지시를 그대로 갖고 있다",
  );
  assert.ok(
    /범위 안인지 확실하지 않으면 UNSURE/.test(BASEBALL_QA_SYSTEM_PROMPT),
    "판정 프롬프트가 UNSURE 기준을 선언 범위와 묶지 않았다",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 종단 — 실제 answerQuestion() 실행 결과
// ─────────────────────────────────────────────────────────────────────────────

/** 운영 로그에서 실제로 관측된 범위 되묻기 문장 (최근 3일). */
const OBSERVED_SCOPE_ASKS = [
  "야구 룰",
  "야구 규칙",
  "야구 룰 알려줘",
  "야구룰 설명해줘",
  "야구 룰은 뭐가있어?",
  "야구 규칙에는 뭐가 있어",
  "야구 룰 간단하개",
  "야구 룰이 뭐야?",
];

for (const q of OBSERVED_SCOPE_ASKS) {
  const { result, logs, calls } = await ask(q);
  check(`종단 — "${q}" 는 범위 안내로 답한다 (되묻지 않는다)`, () => {
    assert.equal(
      result.answer,
      SCOPE_GUIDE_ANSWER,
      `되묻기/거절로 끝났다: ${result.answer}`,
    );
    assert.equal(result.source, "ack", `source 가 ack 이 아니다: ${result.source}`);
    assert.deepEqual(
      logs.map((l) => l.matchPath),
      ["ack"],
      `로그 match_path 가 ack 한 건이 아니다: ${JSON.stringify(logs)}`,
    );
    // 결정론 경로다 — 외부 호출이 없어야 한다.
    assert.equal(calls.llm, 0, "LLM 을 호출했다");
    assert.equal(calls.cache, 0, "캐시를 조회했다");
  });
}

check("과차단 0 — 범위어를 포함한 진짜 질문은 안내문이 덮지 않는다", () => {
  // #1127 4차 NO-GO 의 `SCORE_CONTEXT_HEADS` 전역 substring 과차단과 같은 실수를 막는다.
  // 이게 반대가설이다 — 안내문을 내보내는 쪽만 보면 `야구 룰` substring 구현도 GREEN 이다.
  const mustNotMatch = [
    "야구 룰 중에 보크가 뭐야?",
    "야구 규칙에서 3피트 룰 알려줘",
    "야구 룰 배우고 싶은데 인필드 플라이부터 알려줘",
    // 운영 로그의 실제 문장 — 범위어가 들어있지만 물은 대상이 분명히 있다.
    "야구 보는 사람들이 잘 모르는 규칙을 알려줘",
    "야구 룰에서 빨강색 초록색 주황색이 무슨 뜻인지 모겚어 알려조",
    "야구에 대한 모든걸 알려줘",
  ];
  for (const q of mustNotMatch) {
    assert.equal(isScopeAskPhrase(q), false, `진짜 질문을 범위 되묻기로 오판했다: ${q}`);
  }
});

check("판정은 어휘 열거가 아니라 구조다 — 오타·어순 변형을 몸으로 확인한다", () => {
  // 처음엔 문장 폐쇄집합으로 적었다가 이 샘플들을 놓쳐서 구조 판정으로 바꿈.
  // 목록에 없는 변형이 동작해야 "열거가 아니다"는 주장이 증명된다.
  const variants = [
    "야구규칙은 뭔가있어",   // 붙임 + 조사 + 띄어쓰기 무너짐
    "kbo 규칙 전부 설명해줘",  // 영문 메타어 + 다른 꺼풀 조합
    "너 뭐 할 수 있어",         // 범위어가 `너` 뿐인 변형
    "뭐 질문할 수 있어?",      // 물음 자체를 대상으로 삼은 변형
  ];
  for (const q of variants) {
    assert.equal(isScopeAskPhrase(q), true, `목록에 없는 변형을 놓쳬다 (열거형 회귀): ${q}`);
  }
});

check("범위 되묻기와 감사 인사는 서로 침범하지 않는다", () => {
  for (const q of OBSERVED_SCOPE_ASKS) {
    assert.equal(isAckPhrase(q), false, `범위 되묻기가 ack 으로 먼저 잡혔다: ${q}`);
  }
  for (const q of ["고마워", "감사합니다", "땡큐"]) {
    assert.equal(isScopeAskPhrase(q), false, `감사 인사가 범위 되묻기로 잡혔다: ${q}`);
    assert.equal(routeQuestion(q, GLOSSARY, players), "ack", `감사 인사 라우팅이 깨졌다: ${q}`);
  }
});

{
  const { result } = await ask("보크가 뭐야?");
  check("무회귀 — 사전 용어 질문은 그대로 사전이 답한다", () => {
    assert.equal(result.source, "dictionary", `사전 경로가 깨졌다: ${result.source}`);
    assert.notEqual(result.answer, SCOPE_GUIDE_ANSWER);
  });
}

{
  const { result } = await ask("고마워");
  check("무회귀 — 감사 인사는 ack 문구 그대로", () => {
    assert.equal(result.answer, ACK_ANSWER);
    assert.equal(result.source, "ack");
  });
}

  console.log(
    `\n✅ genius refusal scope contract: ${pass} PASS ` +
      `(SSOT 대조/문구 범위/예시/구범위 잔존 0/프롬프트 계약/종단 ${OBSERVED_SCOPE_ASKS.length}문장/경계/무회귀)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
