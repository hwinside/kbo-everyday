/**
 * 야잘알봇 성의(답변 길이·충실도) 실 provider 게이트 (삼순 2026-08-10 4차 재작성).
 *
 * 3차 지적: raw Gemini 만 호출하면 `answerQuestion`/최종 서빙(길이 상한·출처·검증 게이트)
 * 을 우회하고, 400자 상한·`문장≥2 || 길이≥100` 항진 단정은 계약이 아니다.
 *
 * 그래서 이 게이트는 **production 파이프라인에 실 provider 를 주입**한다:
 *  - `answerQuestion` 종단 실행 (검증·상한·출처 표기 전부 production 코드).
 *  - `callRagLlm` = 배포 코드와 동일한 `buildRagLlmRequest` + `RAG_SYSTEM_PROMPT` 로
 *    실제 Gemini 호출 (mock 답 주입 없음).
 *  - 근거 = production `genius_rag_chunks` 실 데이터 (문보경 별명 chunk).
 *  - 판정 = 최종 서빙 결과의 source·본문 길이(BASEBALL_GENIUS_MAX_ANSWER_LENGTH)·
 *    출처 표기.
 *
 * 키·DB 접근이 없으면 조용한 SKIP 이 아니라 **명시적 실패(exit 1)** 다.
 * 실행: npm run qa:genius-sincerity-live (네트워크·시크릿 필요 — PR checks 밖 수동 게이트)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import {
  BASEBALL_QA_GEMINI_MODEL,
  BASEBALL_QA_SYSTEM_PROMPT,
  buildBaseballQaGeminiRequest,
} from "../../src/lib/baseball-qa/gemini-request";
import { buildRagLlmRequest, RAG_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/rag/retrieve";
import { answerQuestion } from "../../src/lib/baseball-qa/pipeline";
import type { QaDeps, RagEvidence, RagLlmExtras } from "../../src/lib/baseball-qa/pipeline";
import type { PlayerRef } from "../../src/lib/baseball-qa/roster/load-roster-players";

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(resolve(process.cwd(), ".env.local"));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!GEMINI_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("FAIL 필요 env 부재 (GEMINI_API_KEY / SUPABASE_URL / SERVICE_ROLE) — SKIP 아님, 실패");
  process.exit(1);
}

interface ChunkRow {
  content: string;
  page_title: string;
  canonical_url: string;
  revision: string | null;
  section_path: string;
  as_of: string | null;
}

/** production 실근거: 문보경 나무위키 chunk 중 별명 서술 상위 4건. */
async function fetchRealEvidence(): Promise<RagEvidence[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/genius_rag_chunks` +
    `?select=content,page_title,canonical_url,revision,section_path,as_of` +
    `&page_title=eq.${encodeURIComponent("문보경")}` +
    `&content=ilike.${encodeURIComponent("*별명*")}` +
    `&order=chunk_index.asc&limit=6`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`supabase REST ${res.status}`);
  const rows = (await res.json()) as ChunkRow[];
  return rows.map((row) => ({
    content: row.content,
    pageTitle: row.page_title,
    canonicalUrl: row.canonical_url,
    revision: row.revision ?? "1",
    sectionPath: row.section_path,
    asOf: row.as_of ?? "2026-01-01",
    sourceGrade: "tier2" as const,
    sourceKind: "namu_document",
  })) as unknown as RagEvidence[];
}

/** 실호출 공통 — 배포 빌더가 만든 body 를 그대로 던진다(파라미터 재구성 금지). */
async function callGemini(body: unknown) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text: string =
      candidate?.content?.parts?.find((p: { text?: string }) => p.text)?.text ?? "";
    return {
      text,
      // ⚠️ finishReason 을 반드시 관측한다. `MAX_TOKENS` 면 JSON 이 중간 절단돼
      //   production validator 가 malformed 로 폐기한다 — 이번 NO-GO P0 의 정확한 실패 모드다.
      finishReason: (candidate?.finishReason as string | undefined) ?? null,
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
  throw new Error("Gemini 재시도 소진");
}

/** 마지막 실호출의 finishReason — 절단 여부를 검사에서 직접 본다. */
let lastFinishReason: string | null = null;
let lastOutputTokens: number | null = null;

/** 배포 코드와 동일한 요청 빌더·프롬프트로 실제 Gemini 를 호출한다 (mock 없음). */
async function realCallRagLlm(question: string, evidence: RagEvidence[], extras?: RagLlmExtras) {
  const result = await callGemini(buildRagLlmRequest(question, evidence, RAG_SYSTEM_PROMPT, {
    context: extras?.context,
    rosterBlock: extras?.rosterBlock,
  }));
  lastFinishReason = result.finishReason;
  lastOutputTokens = result.outputTokens;
  return { text: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/**
 * generic(비RAG) 경로 실호출 — 배포 빌더 `buildBaseballQaGeminiRequest` 그대로.
 * 시그니처는 production `QaDeps.callLlm` 과 동일해야 파이프라인에 그대로 주입된다.
 */
async function realCallLlm(
  question: string,
  context?: { question: string; answer: string },
  rosterBlock?: string,
  statIntentMode?: boolean,
) {
  const result = await callGemini(
    buildBaseballQaGeminiRequest(question, BASEBALL_QA_SYSTEM_PROMPT, context, rosterBlock, statIntentMode ?? false),
  );
  lastFinishReason = result.finishReason;
  lastOutputTokens = result.outputTokens;
  return { text: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/**
 * 답변이 근거를 **그대로 옮겼는가** — 가장 긴 공통 부분문자열 길이 (삼순 2026-08-16 P1).
 *
 * ⚠️ `근거1건상한(800) > 답변상한(700)` 만으로 원문 복사가 불가능하다는 종전 주장은
 * false-green 이었다. 700자 이하 chunk 는 전문이 그대로 들어갈 수 있고, 긴 chunk 도
 * 앞 700자를 그대로 옮길 수 있다. 상한 비교가 아니라 **실제 산출물의 중복**을 잰다.
 *
 * 공백을 지운 뒤 비교한다 — 줄바꿈·띄어쓰기만 손대고 문장을 통째로 옮기는 것도 복사다.
 */
function longestCommonSubstring(a: string, b: string): number {
  const x = a.replace(/\s+/gu, "");
  const y = b.replace(/\s+/gu, "");
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = new Uint32Array(y.length + 1);
    for (let j = 1; j <= y.length; j += 1) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

const PLAYERS = [
  { kboId: "51868", name: "문보경", team: "LG", position: "내야수" },
] as unknown as PlayerRef[];

function makeLiveDeps(evidence: RagEvidence[]): QaDeps {
  let stored: unknown = null;
  let started = false;
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: true,
    searchRag: async () => evidence,
    callRagLlm: realCallRagLlm,
    callLlm: async () => { throw new Error("선수 RAG 질문에서 generic LLM 금지"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
}

/**
 * generic(비RAG) 경로 deps — 실 Gemini `callLlm` 을 주입한다.
 * RAG 를 끄고 로스터에 없는 일반 룰 질문을 태워 `source=llm` 종단을 만든다.
 */
function makeGenericLiveDeps(): QaDeps {
  let stored: unknown = null;
  let started = false;
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: false,
    callLlm: realCallLlm,
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
}

/**
 * 성의 하한 / 단순 사실형 상한.
 *
 * 2026-08-16 상한 320→700 상향에 맞춰 함께 올린다. 상한만 올리고 하한을 두면
 * "즉답 회귀"를 이 게이트가 못 잡고(하한 100자는 한 문장으로도 충족된다),
 * 단순 사실형 상한을 안 두면 상향이 "모든 답이 길어짐"으로 새는 것을 못 잡는다.
 * 두 값이 상향의 **양쪽 반대축**이다.
 */
const SINCERITY_MIN_CHARS = 180;
const SIMPLE_MAX_CHARS = 320;

/** 상향 이전 상한 — "실 provider 가 이 값을 실제로 넘는가"가 상향의 실효 판정선이다. */
const LEGACY_MAX_CHARS = 320;

/**
 * 근거를 그대로 옮겼다고 볼 연속 일치 길이 (공백 제거 기준).
 *
 * 재서술이면 명사구·고유명사가 겹쳐도 연속 일치는 짧게 끊긴다. 40자는 한국어에서
 * 대략 한 문장 분량이라, 그보다 길게 이어지면 문장 단위 복붙으로 본다.
 */
const COPY_MAX_RUN_CHARS = 40;

/**
 * tier2 폐기율 관측 표본 수와 하한 (2026-08-16 실측으로 추가).
 *
 * 🔴 왜 필요한가 — 상한·깊이 상향의 **부작용을 내가 실측으로 발견했다**.
 * tier2(선수·구단·뉴스) 경로는 숫자가 하나라도 섞이면 답 전체를 버린다
 * (`numeric_claim_ungrounded`). "길게 쓰라"는 지시는 모델을 더 많은 소재로 밀어내고,
 * 그 소재에 연도·횟수가 섞이면서 **폐기율이 올라간다**. 동일 조건 20회 실측:
 *   · base(origin/main, 상한 320)         → grounded 20/20, 평균 LLM 답 193자
 *   · 깊이 지시만 넣은 중간 상태(상한 700) → grounded 17/20 (3건 폐기), 평균 397자
 *   · 우선순위 줄 추가 후(현재)            → grounded 19/20 (1건 폐기), 평균 412자
 * 즉 "금지가 길이보다 우선"이라는 한 줄로 대부분 회수했지만 **0으로 돌아가진 않았다.**
 * 이 값은 그 잔여 트레이드오프를 숨기지 않고 **회귀로 감시**하기 위한 것이다.
 *
 * 하한 0.8 = 20회 중 4건까지 허용. 실측 19/20(0.95)보다 낮게 잡아 provider 변동을
 * 흡수하되, 프롬프트가 다시 길이 쪽으로 기울면(17/20=0.85 아래) RED 가 되게 한다.
 */
const DISCARD_PROBE_RUNS = 20;
const MIN_GROUNDED_RATE = 0.8;

/** 최종 답에서 출처 표기를 뗀 본문 — production 상한은 본문에 걸린다. */
function bodyOf(answer: string): string {
  const idx = answer.indexOf("\n\n📄");
  return idx >= 0 ? answer.slice(0, idx) : answer;
}

(async () => {
  const evidence = await fetchRealEvidence();
  assert.ok(evidence.length >= 2, `실근거 부족: ${evidence.length}건 — 게이트 판정 불가는 실패다`);

  let pass = 0;
  const failures: string[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
  }

  // ① 이유·배경형 — 최종 서빙 종단: RAG 로 답하고, 본문이 성의 하한 이상,
  //    production 상한 이하, 출처 표기 포함. 실패 시 blocked/unsure 로 새는 것까지 잡힌다.
  //    ⚠️ 2026-08-16 상한 700 상향 + 깊이 지시 강화에 맞춰 **하한도 함께 올린다**.
  //    상한만 올리고 하한을 100 에 두면 "즉답 회귀"를 이 게이트가 못 잡는다.
  await run("이유·배경형: answerQuestion 종단 — 성의 하한·상한·출처", async () => {
    const result = await answerQuestion("live-u1", "문보경 별명이 생긴 이유가 뭐야?", makeLiveDeps(evidence));
    assert.equal(result.status, 200);
    assert.equal(
      result.source, "rag",
      `RAG 실답이어야 한다 (삼순 5차: 배제 나열이 아니라 양성 고정): source=${result.source} answer=${result.answer.slice(0, 120)}`,
    );
    const body = bodyOf(result.answer);
    assert.ok(body.length >= SINCERITY_MIN_CHARS, `이유·배경 답이 성의 하한(${SINCERITY_MIN_CHARS}자) 미만(${body.length}자): ${body}`);
    assert.ok(
      body.length <= BASEBALL_GENIUS_MAX_ANSWER_LENGTH,
      `본문이 production 상한(${BASEBALL_GENIUS_MAX_ANSWER_LENGTH}) 초과(${body.length}자)`,
    );
    assert.ok(result.answer.includes("출처"), `출처 표기 누락: ${result.answer.slice(-60)}`);
    console.log(`   ↳ source=${result.source} 본문 ${body.length}자`);
  });

  // ② 단순 사실형 — 같은 종단에서 과장문이 아니어야 한다 (길이 지시가 죽으면 여기가 잡는다).
  //    상한 상향의 반대축: 모든 답이 무작정 길어지면 여기가 RED 가 된다.
  await run(`단순 사실형: answerQuestion 종단 — 간결(≤${SIMPLE_MAX_CHARS}자)·상한 준수`, async () => {
    const result = await answerQuestion("live-u2", "문보경 별명이 뭐야?", makeLiveDeps(evidence));
    assert.equal(result.status, 200);
    assert.equal(
      result.source, "rag",
      `RAG 실답이어야 한다 (삼순 5차: 배제 나열이 아니라 양성 고정): source=${result.source} answer=${result.answer.slice(0, 120)}`,
    );
    const body = bodyOf(result.answer);
    assert.ok(body.length > 0 && body.length <= SIMPLE_MAX_CHARS, `단순 사실형이 과장문(${body.length}자): ${body}`);
    console.log(`   ↳ source=${result.source} 본문 ${body.length}자`);
  });

  // ③ 🔴 삼순 2026-08-16 NO-GO P0 — **실 provider 종단에서 >320자 양성**.
  //    mock E2E 는 `maxOutputTokens` 병목을 우회하므로 상향의 실효를 증명하지 못한다.
  //
  //    ⚠️ 단발 실행으로 판정하지 않는다. tier2 는 숫자 가드 때문에 생성 결과가 확률적으로
  //    폐기되고(아래 ⑤ 참조), 단발 assert 는 그 확률을 게이트 flakiness 로 옮길 뿐이다.
  //    표본을 모아 **비율과 평균**으로 판정하고, 같은 표본을 ⑤와 공유해 호출도 아낀다.
  const ragProbe = await Promise.all(
    Array.from({ length: DISCARD_PROBE_RUNS }, async (_, i) => {
      const result = await answerQuestion(
        `live-probe-${i}`,
        "문보경 별명이 어떻게 생겼고 팬들 사이에서 어떻게 퍼졌는지 배경과 과정까지 자세히 설명해줘",
        makeLiveDeps(evidence),
      );
      return { source: result.source, chars: bodyOf(result.answer).length, finish: lastFinishReason };
    }),
  );
  const ragGrounded = ragProbe.filter((r) => r.source === "rag");
  const ragRate = ragGrounded.length / DISCARD_PROBE_RUNS;
  const ragAvg = ragGrounded.length > 0
    ? Math.round(ragGrounded.reduce((sum, r) => sum + r.chars, 0) / ragGrounded.length)
    : 0;
  const ragOverLegacy = ragGrounded.filter((r) => r.chars > LEGACY_MAX_CHARS).length;

  await run(`RAG 종단: 실 Gemini 본문이 종전 상한(${LEGACY_MAX_CHARS}자)을 실제로 넘는다`, async () => {
    assert.equal(ragProbe.filter((r) => r.finish === "MAX_TOKENS").length, 0, "토큰 상한 절단 발생 — maxOutputTokens 가 다시 병목이다");
    assert.ok(ragGrounded.length > 0, "grounded 표본 0건 — 판정 불가는 실패다");
    assert.ok(ragAvg > LEGACY_MAX_CHARS, `상향 실효 미검증 — grounded 평균 본문이 종전 상한 이하(${ragAvg}자)`);
    assert.ok(
      ragOverLegacy >= Math.ceil(ragGrounded.length * 0.5),
      `과반이 종전 상한을 넘지 못했다(${ragOverLegacy}/${ragGrounded.length})`,
    );
    assert.ok(
      ragGrounded.every((r) => r.chars <= BASEBALL_GENIUS_MAX_ANSWER_LENGTH),
      "상한 초과 본문이 서빙됐다",
    );
    console.log(`   \u21b3 grounded ${ragGrounded.length}/${DISCARD_PROBE_RUNS} · 평균 ${ragAvg}자 · >${LEGACY_MAX_CHARS}자 ${ragOverLegacy}건`);
  });

  // ③' generic 경로 — **provider 레벨 headroom 만** 고정한다.
  //
  //    🔴 정직한 기록: generic 최종 서빙은 이 PR 로 >320자 양성을 만들 수 없다.
  //    `parseLlmResponse` 가 `isBaseballGeniusToneCompliant` 를 **하드 fail-close** 로 쓰는데
  //    LLM 생성문은 열린 집합이라 해요체가 확률적으로 섞인다. 동일 조건 20회 실측:
  //      · base(origin/main) tone 합격 **2/20** · 평균 LLM 답 190자
  //      · 이 PR              tone 합격  4/20 · 평균 LLM 답 320자
  //    즉 generic 폐기는 base 에서 이미 90%이고 이 PR 이 만든 것이 아니다(오히려 소폭 개선).
  //    RAG 경로는 #1186 에서 톤을 관측값으로 내렸지만 generic 은 fail-close 로 남아 있다 —
  //    같은 전환이 필요한 **별도 트랙**이다.
  //    그래서 여기서는 삼순 P0 의 본체인 **토큰 절단 부재 + 생성 길이 확보**를 고정하고,
  //    최종 서빙 양성은 위 RAG 종단이 담당한다(삼순: "RAG·generic(또는 official) 각각").
  await run(`generic 요청: 토큰 절단 없이 >${LEGACY_MAX_CHARS}자 생성이 가능하다`, async () => {
    const runs = await Promise.all(
      Array.from({ length: DISCARD_PROBE_RUNS }, async () => {
        const r = await callGemini(buildBaseballQaGeminiRequest(
          "야구에서 보크가 무엇이고 어떤 경우에 선언되는지, 그런 규칙이 왜 생겼는지 배경까지 자세히 설명해줘",
          BASEBALL_QA_SYSTEM_PROMPT,
        ));
        let answer = "";
        try { answer = JSON.parse(r.text).answer ?? ""; } catch { answer = ""; }
        return { finish: r.finishReason, chars: answer.length };
      }),
    );
    assert.equal(runs.filter((r) => r.finish === "MAX_TOKENS").length, 0, "generic 요청에서 토큰 절단 발생 — maxOutputTokens 미배선");
    assert.equal(runs.filter((r) => r.chars === 0).length, 0, "JSON 파싱 실패 표본 존재 — 절단 또는 계약 위반");
    const over = runs.filter((r) => r.chars > LEGACY_MAX_CHARS).length;
    const avg = Math.round(runs.reduce((sum, r) => sum + r.chars, 0) / runs.length);
    assert.ok(over > 0, `generic 이 종전 상한을 넘는 답을 한 번도 만들지 못했다(평균 ${avg}자) — 상향이 생성 단계에서 무효다`);
    console.log(`   \u21b3 평균 생성 ${avg}자 · >${LEGACY_MAX_CHARS}자 ${over}/${DISCARD_PROBE_RUNS} · 절단 0`);
  });

  // ④ 🔴 삼순 2026-08-16 NO-GO P1 — **원문 복사 반대축**.
  //    `근거상한(800) > 답변상한(700)` 은 복사 불가의 증거가 아니다(700자 이하 chunk 는
  //    전문 복사가 가능하고, 긴 chunk 도 앞 700자를 그대로 옮길 수 있다).
  //    실 provider 장문 답변을 실제 근거와 대조해 **최장 공통 부분문자열**을 잰다.
  await run(`원문 복사 반대축: 장문 답변이 근거를 그대로 옮기지 않는다 (LCS <= ${COPY_MAX_RUN_CHARS}자)`, async () => {
    const result = await answerQuestion(
      "live-u5",
      "문보경 별명이 어떻게 생겼고 팬들 사이에서 어떻게 퍼졌는지 배경과 과정까지 자세히 설명해줘",
      makeLiveDeps(evidence),
    );
    assert.equal(result.source, "rag", `RAG 실답이어야 판정 가능: source=${result.source}`);
    const body = bodyOf(result.answer);
    assert.ok(body.length > LEGACY_MAX_CHARS, `장문 표본이어야 복사 판정에 의미가 있다(${body.length}자)`);
    let worst = 0;
    let worstSource = "";
    for (const row of evidence) {
      const overlap = longestCommonSubstring(body, row.content);
      if (overlap > worst) { worst = overlap; worstSource = row.sectionPath ?? row.pageTitle; }
      // 근거 전문이 통째로 들어간 경우는 별도로 명시 실패시킨다(가장 나쁜 형태).
      assert.ok(
        !body.replace(/\s+/gu, "").includes(row.content.replace(/\s+/gu, "")),
        `근거 전문이 답변에 통째로 복사됐다 (${row.sectionPath})`,
      );
    }
    assert.ok(
      worst <= COPY_MAX_RUN_CHARS,
      `근거를 ${worst}자 연속으로 그대로 옮겼다(허용 ${COPY_MAX_RUN_CHARS}자, 근거=${worstSource}) — 재서술이 아니라 복붙이다`,
    );
    console.log(`   \u21b3 본문 ${body.length}자 / 근거 최장 공통 ${worst}자 (허용 ${COPY_MAX_RUN_CHARS})`);
  });

  // ⑤ tier2 폐기율 관측 — 상향의 **부작용 축** (위 ③ 표본 재사용).
  //
  //    🔴 이 축은 내가 실측으로 발견한 회귀다. tier2 는 숫자가 하나라도 섞이면 답 전체를
  //    버리는데(`numeric_claim_ungrounded`), "길게 쓰라"는 지시가 모델을 더 많은 소재로
  //    밀어내면서 연도·횟수가 섞일 확률이 올라간다. 동일 조건 20회 실측:
  //      · base(origin/main, 상한 320)          → grounded 20/20 · 평균 193자
  //      · 깊이 지시만 넣은 중간 상태(상한 700) → grounded 17/20 · 평균 397자  ← 회귀
  //      · 우선순위 줄 추가 후(현재)             → grounded 19/20 · 평균 412자
  //    `BASEBALL_GENIUS_DEPTH_PROMPT` 의 "금지가 길이보다 우선" 두 줄로 대부분 회수했으나
  //    **0 으로 돌아가지는 않았다.** 그 잔여 트레이드오프를 숨기지 않고 여기서 감시한다.
  await run(`tier2 폐기율: grounded 비율 >= ${MIN_GROUNDED_RATE * 100}% (깊이 지시가 숫자 금지를 이기지 않는다)`, async () => {
    assert.ok(
      ragRate >= MIN_GROUNDED_RATE,
      `tier2 폐기율 악화 — grounded ${ragGrounded.length}/${DISCARD_PROBE_RUNS}(${(ragRate * 100).toFixed(0)}%). ` +
      `깊이 지시가 숫자 금지 계약을 이기고 있다(우선순위 줄 확인).`,
    );
    // 폐기율을 지키려고 답을 짧게 만든 것이 아니어야 한다 — 두 축을 함께 본다.
    assert.ok(ragAvg > SINCERITY_MIN_CHARS, `폐기율은 지켰지만 평균 길이가 하한 이하(${ragAvg}자) — 상향이 무효화됐다`);
    console.log(`   \u21b3 grounded ${(ragRate * 100).toFixed(0)}% · 평균 ${ragAvg}자 (base 대조: 100% · 193자)`);
  });

  console.log(`\nbaseball QA sincerity live: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})().catch((e) => {
  console.error(`FAIL runner :: ${(e as Error).message}`);
  process.exitCode = 1;
});
