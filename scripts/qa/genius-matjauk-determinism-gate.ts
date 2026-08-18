/**
 * 맛자욱 P0 게이트 — standalone 참조문서 결속 + 동일입력 결정론 (2026-08-19).
 *
 * 배경: `구자욱 별명이 왜 맛자욱이야?` 가 ① 정답 근거(채수빈 유래) 미수집(맛자욱 standalone
 * 문서는 수집기 계약 밖) ② 같은 프롬프트(input_tokens 동일)에서 GROUNDED↔INSUFFICIENT
 * **플립**. 이 게이트는 두 계약을 분리해 잠근다:
 *
 *   [A] 수집 계약 — entity 문서의 닫힌 참조 표기(`<a>X</a> 문서 참고`)에서 standalone
 *       참조문서를 발견·양방향 결속(canonical + 본문 entity 언급) 후 `{root}/참고:{title}`
 *       sectionPath 로 적재하고, 그 chunk 가 **projection 을 생존**해 근거로 도달한다.
 *   [B] 결정론 계약 — temperature 0 + 검증답 replay(entity+정규화 질문+근거 fingerprint+
 *       프롬프트 fingerprint). **flappy provider**(1회차 grounded, 2회차부터 insufficient)
 *       fixture 에서도 20회×2세션 종단 답이 전부 동일하고 LLM 소비는 정확히 1회다.
 *   [C] 문구 계약 — `model_insufficient` 는 "이해 못함"(UNCLEAR)이 아니라 "자료 부족"
 *       문구로 나간다. 단 맛자욱 exact 는 근거 결속 후 그 분기로 절대 가지 않는다.
 *
 * 실행:      npx tsx scripts/qa/genius-matjauk-determinism-gate.ts
 * selftest:  npx tsx scripts/qa/genius-matjauk-determinism-gate.ts --selftest
 *   (결함주입을 in-process 로 돌려 게이트가 실제로 RED 를 낼 수 있음을 증명한다)
 * mutation:  --mutate-noreplay  → replay 저장소 제거: flappy provider 에서 반드시 실패(RED)
 *            --mutate-unbind    → 참조 근거 결속 제거: 채수빈 종단이 반드시 실패(RED)
 */
import assert from "node:assert/strict";

import { answerQuestion, RAG_INSUFFICIENT_ANSWER, UNCLEAR_ANSWER, type GlossaryEntry, type PlayerRef, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import {
  buildRagLlmRequest,
  RAG_GENERATION_TEMPERATURE,
  RAG_GROUNDED_SENTINEL,
  RAG_INSUFFICIENT_SENTINEL,
  projectPlayerDescriptiveRow,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";
import {
  extractNamuReferenceDocLinks,
  referenceSectionPathFor,
  verifyCanonicalReferenceDocumentIdentity,
} from "../../src/lib/baseball-qa/rag/reference-docs";
import {
  ragEvidenceFingerprint,
  type VerifiedRagAnswerKey,
  type VerifiedRagAnswerRecord,
  type VerifiedRagAnswerStore,
} from "../../src/lib/baseball-qa/rag/verified-answers";
import { extractDocumentText, type FetchDocResult } from "../../src/lib/baseball-qa/rag/fetch-namu";
import { prepareTier2DocumentSet } from "../../src/lib/baseball-qa/rag/ingest";
import { crawlNamuEntityDocuments } from "../baseball-qa/rag/fetch-namu-browser";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";

let pass = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await Promise.resolve(fn());
  pass += 1;
  console.log(`PASS ${name}`);
}

// ── HTML fixtures (실 나무위키 구조 최소 재현) ────────────────────────────────
const ROOT_URL = "https://namu.wiki/w/구자욱";
const REF_URL = "https://namu.wiki/w/맛자욱";

const ROOT_HTML = `<!doctype html><html><head>
<link rel="canonical" href="https://namu.wiki/w/%EA%B5%AC%EC%9E%90%EC%9A%B1">
<meta property="og:title" content="구자욱">
<title>구자욱 - 나무위키</title></head><body>
<a href="/w/%EB%B6%84%EB%A5%98:%EB%8C%80%ED%95%9C%EB%AF%BC%EA%B5%AD%EC%9D%98%20%EC%95%BC%EA%B5%AC%20%EC%84%A0%EC%88%98">분류:대한민국의 야구 선수</a>
<a href="/w/%EB%B6%84%EB%A5%98:1993%EB%85%84%20%EC%B6%9C%EC%83%9D">분류:1993년 출생</a>
<p>구자욱은 삼성 라이온즈의 외야수이다.</p>
<p>여담. 별명 유래는 <a href="/w/%EB%A7%9B%EC%9E%90%EC%9A%B1">맛자욱</a> 문서 참고.</p>
<p>동료 이야기는 <a href="/w/%EA%B9%80%EC%98%81%EC%9B%85">김영웅</a> 선수와 함께한다.</p>
<a href="/w/%ED%8B%80:%EC%82%BC%EC%84%B1%20%EB%9D%BC%EC%9D%B4%EC%98%A8%EC%A6%88">틀:삼성 라이온즈</a> 문서 참고
</body></html>`;

const REF_HTML = `<!doctype html><html><head>
<link rel="canonical" href="https://namu.wiki/w/%EB%A7%9B%EC%9E%90%EC%9A%B1">
<meta property="og:title" content="맛자욱">
<title>맛자욱 - 나무위키</title></head><body>
<p>맛자욱은 구자욱의 대표적인 별명이다.</p>
<p>배우 채수빈이 열애설 보도 당시 열애설을 맛보기한 느낌이라고 말한 데서 유래한 별명이다. 이후 팬덤에서 밈으로 굳어진 표현이다.</p>
</body></html>`;

const IDENTITY = { name: "구자욱", birthYear: "1993" };

function fixtureFetcher(overrides: Record<string, FetchDocResult> = {}) {
  const pages: Record<string, FetchDocResult> = {
    [ROOT_URL]: {
      ok: true, requestedUrl: ROOT_URL, url: ROOT_URL, html: ROOT_HTML,
      revision: "crawled:2026-08-19T00:00:00.000Z", crawledAt: "2026-08-19T00:00:00.000Z",
    },
    [REF_URL]: {
      ok: true, requestedUrl: REF_URL, url: REF_URL, html: REF_HTML,
      revision: "crawled:2026-08-19T00:00:10.000Z", crawledAt: "2026-08-19T00:00:10.000Z",
    },
    ...overrides,
  };
  return async (url: string): Promise<FetchDocResult> =>
    pages[url] ?? { ok: false, status: "missing", reason: "fixture_absent" };
}

// ── [A-1] 닫힌 참조 표기 추출 정밀도 ─────────────────────────────────────────
async function runExtractionChecks(): Promise<void> {
  await check("추출 — `<a>맛자욱</a> 문서 참고` 만 후보다 (닫힌 집합)", () => {
    const links = extractNamuReferenceDocLinks(ROOT_HTML, ROOT_URL, "구자욱");
    assert.equal(links.length, 1, `후보 ${links.length}건 (기대 1): ${JSON.stringify(links)}`);
    assert.equal(links[0].title, "맛자욱");
    assert.equal(links[0].url, REF_URL);
  });
  await check("추출 — 참고 표기 없는 일반 내부링크(김영웅)는 후보가 아니다", () => {
    const links = extractNamuReferenceDocLinks(ROOT_HTML, ROOT_URL, "구자욱");
    assert.ok(!links.some((l) => l.title.includes("김영웅")), "일반 링크가 참조 후보로 샜다");
  });
  await check("추출 — 틀: 네임스페이스는 `문서 참고`가 붙어도 후보가 아니다", () => {
    const links = extractNamuReferenceDocLinks(ROOT_HTML, ROOT_URL, "구자욱");
    assert.ok(!links.some((l) => l.title.startsWith("틀:")), "틀 문서가 후보로 샜다");
  });
  await check("추출 — 하위문서(`구자욱/…`)는 참조 경로가 아니라 기존 경로 몫이다", () => {
    const html = `<a href="/w/%EA%B5%AC%EC%9E%90%EC%9A%B1/%EC%84%A0%EC%88%98%20%EA%B2%BD%EB%A0%A5">구자욱/선수 경력</a> 문서 참고`;
    assert.equal(extractNamuReferenceDocLinks(html, ROOT_URL, "구자욱").length, 0);
  });
  await check("추출 — 앵커 텍스트 ≠ href 제목이면 참조 표기가 아니다", () => {
    const html = `<a href="/w/%EB%A7%9B%EC%9E%90%EC%9A%B1">별명 문서</a> 문서 참고`;
    assert.equal(extractNamuReferenceDocLinks(html, ROOT_URL, "구자욱").length, 0);
  });
}

// ── [A-2] canonical + 양방향 결속 게이트 ─────────────────────────────────────
async function runVerifierChecks(): Promise<void> {
  const base = {
    requestedUrl: REF_URL, finalUrl: REF_URL, html: REF_HTML,
    entityRootTitle: "구자욱", anchorTitle: "맛자욱", entityName: "구자욱",
  };
  await check("결속 — 정상 참조문서는 통과하고 sectionPath 가 `구자욱/참고:맛자욱`", () => {
    const verdict = verifyCanonicalReferenceDocumentIdentity(base);
    assert.ok(verdict.ok, `기각됨: ${!verdict.ok ? verdict.reason : ""}`);
    if (verdict.ok) assert.equal(verdict.sectionPath, referenceSectionPathFor("구자욱", "맛자욱"));
  });
  await check("결속 — 본문이 entity 이름을 언급하지 않으면 기각 (내용 방향 결속)", () => {
    const html = REF_HTML.replace(/구자욱/g, "다른선수");
    const verdict = verifyCanonicalReferenceDocumentIdentity({ ...base, html });
    assert.ok(!verdict.ok && verdict.reason === "reference_body_entity_name_absent", JSON.stringify(verdict));
  });
  await check("결속 — canonical 이 앵커 제목과 다르면 기각 (redirect 오도달 차단)", () => {
    const verdict = verifyCanonicalReferenceDocumentIdentity({ ...base, anchorTitle: "다른문서" });
    assert.ok(!verdict.ok && verdict.reason === "reference_anchor_canonical_mismatch", JSON.stringify(verdict));
  });
  await check("결속 — rel=canonical 부재는 기각 (HTTP 200 단독 금지)", () => {
    const html = REF_HTML.replace(/<link rel="canonical"[^>]*>/, "");
    const verdict = verifyCanonicalReferenceDocumentIdentity({ ...base, html });
    assert.ok(!verdict.ok && verdict.reason === "canonical_link_absent", JSON.stringify(verdict));
  });
}

// ── [A-3] 크롤 → 적재 → projection 생존 (production seam 함수 그대로) ───────
async function crawlFixture() {
  return crawlNamuEntityDocuments(ROOT_URL, IDENTITY, { fetchDocument: fixtureFetcher() });
}

async function runCrawlIngestProjectionChecks(): Promise<RagEvidence> {
  const crawled = await crawlFixture();
  assert.ok(crawled.ok, `크롤 실패: ${!crawled.ok ? crawled.reason : ""}`);
  if (!crawled.ok) throw new Error("unreachable");

  await check("크롤 — 참조문서가 kind=reference 로 수집되고 sectionPath 결속", () => {
    const ref = crawled.documents.find((d) => d.kind === "reference");
    assert.ok(ref, "참조문서 미수집");
    assert.equal(ref!.sectionPath, "구자욱/참고:맛자욱");
    assert.equal(ref!.canonicalUrl, REF_URL);
  });

  const documents = crawled.documents.map((document) => ({
    entityType: "player" as const,
    entityId: "62404",
    pageTitle: "구자욱",
    canonicalUrl: document.canonicalUrl,
    revision: document.revision,
    sectionPath: document.sectionPath,
    crawledAt: document.crawledAt,
    asOf: document.crawledAt.slice(0, 10),
    rawText: extractDocumentText(document.html),
  }));
  const prepared = prepareTier2DocumentSet(documents);
  assert.ok(prepared.ok, `적재 실패: ${!prepared.ok ? prepared.reason : ""}`);
  if (!prepared.ok) throw new Error("unreachable");

  const refChunk = prepared.chunks.find(
    (chunk) => chunk.meta.sectionPath === "구자욱/참고:맛자욱" && chunk.content.includes("채수빈"),
  );
  await check("적재 — 채수빈 유래 서술이 참조 sectionPath chunk 로 보존된다", () => {
    assert.ok(refChunk, `채수빈 chunk 없음: ${prepared.chunks.map((c) => c.meta.sectionPath).join(", ")}`);
  });

  const evidence: RagEvidence = {
    content: refChunk!.content,
    pageTitle: "구자욱",
    canonicalUrl: REF_URL,
    revision: refChunk!.meta.revision,
    sectionPath: refChunk!.meta.sectionPath,
    asOf: refChunk!.meta.asOf,
    sourceGrade: "tier2",
    sourceKind: "namu_document",
  };
  await check("projection — 참조 chunk 가 projection 을 **생존**해 근거로 도달한다 (완화 0)", () => {
    const projected = projectPlayerDescriptiveRow(evidence);
    assert.ok(projected.length >= 20, `projection 이 참조 근거를 죽였다: "${projected}"`);
    assert.ok(projected.includes("채수빈"), `채수빈 서술 소실: "${projected}"`);
    assert.ok(projected.includes("맛보기한 느낌"), `유래 서술 소실: "${projected}"`);
  });
  return { ...evidence, content: projectPlayerDescriptiveRow(evidence) };
}

// ── [B] 20회×2세션 동일입력 결정론 (flappy provider + replay) ────────────────
interface DeterminismOptions {
  withReplayStore: boolean;
  withEvidence: boolean;
}

function memoryStore(): VerifiedRagAnswerStore {
  const map = new Map<string, VerifiedRagAnswerRecord>();
  const keyOf = (key: VerifiedRagAnswerKey) =>
    [key.entityType, key.entityId, key.questionNorm, key.evidenceFingerprint, key.promptFingerprint].join("\u0000");
  return {
    get: async (key) => map.get(keyOf(key)) ?? null,
    put: async (key, record) => {
      if (!map.has(keyOf(key))) map.set(keyOf(key), record);
    },
  };
}

async function runDeterminism(evidence: RagEvidence, options: DeterminismOptions): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  const gja = players.find((p) => p.name === "구자욱");
  assert.ok(gja, "로스터에 구자욱이 없다 — 로더 결함");
  const GLOSSARY: GlossaryEntry[] = [];
  const store = options.withReplayStore ? memoryStore() : undefined;
  let llmCalls = 0;
  let genericCalls = 0;

  const makeDeps = (): QaDeps =>
    ({
      enablePlayerRag: true,
      loadGlossary: async () => GLOSSARY,
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      releaseDaily: async () => {},
      log: async () => {},
      callLlm: async () => {
        genericCalls += 1;
        return { text: JSON.stringify({ status: "BASEBALL_PLAYER", answer: "일반 경로 답변입니다." }), inputTokens: 1, outputTokens: 1 };
      },
      searchRag: async () => (options.withEvidence ? [evidence] : []),
      // 🔴 flappy provider — 1회차만 grounded, 이후 전부 INSUFFICIENT.
      //   temperature 0 이어도 provider 변동은 원리적으로 남는다는 실측(GROUNDED↔INSUFFICIENT
      //   플립)의 재현이다. replay 가 없으면 2회차부터 반드시 흔들린다 → mutation RED 의 축.
      callRagLlm: async () => {
        llmCalls += 1;
        if (llmCalls === 1) {
          return {
            text: JSON.stringify({
              status: RAG_GROUNDED_SENTINEL,
              answer: "구자욱 선수의 별명 맛자욱은 배우 채수빈 님이 열애설 당시 열애설을 맛보기한 느낌이라고 말한 데서 유래했습니다.",
            }),
            inputTokens: 100, outputTokens: 40,
          };
        }
        return { text: JSON.stringify({ status: RAG_INSUFFICIENT_SENTINEL }), inputTokens: 100, outputTokens: 2 };
      },
      ...(store ? { verifiedRagAnswers: store } : {}),
    }) as unknown as QaDeps;

  const QUESTION = "구자욱 별명이 왜 맛자욱이야?";
  const answers: string[] = [];
  const sources: string[] = [];
  // 새 세션 2축 — 세션마다 새 deps(새 캐시·새 컨텍스트), 세션당 10회 = 총 20회.
  for (const sessionUser of ["u-matjauk-session-a", "u-matjauk-session-b"]) {
    for (let run = 0; run < 10; run += 1) {
      const result = await answerQuestion(sessionUser, QUESTION, makeDeps());
      answers.push(result.answer ?? "");
      sources.push(result.source ?? "");
    }
  }

  assert.ok(answers.every((a) => a === answers[0]), `답이 흔들렸다: ${[...new Set(answers)].join(" ||| ")}`);
  assert.ok(sources.every((s) => s === "rag"), `source 가 흔들렸다: ${[...new Set(sources)].join(", ")}`);
  assert.ok(answers[0].includes("채수빈"), `채수빈 누락: ${answers[0]}`);
  assert.ok(answers[0].includes("맛보기한 느낌"), `유래 서술 누락: ${answers[0]}`);
  assert.ok(!answers.some((a) => a.startsWith(UNCLEAR_ANSWER)), "UNCLEAR 상용구가 나갔다");
  assert.ok(!answers.some((a) => a.startsWith(RAG_INSUFFICIENT_ANSWER)), "자료 부족 상용구가 나갔다 — 맛자욱 exact 는 이 분기 금지");
  assert.equal(llmCalls, 1, `LLM 소비 ${llmCalls}회 (기대 1) — replay 가 일하지 않는다`);
  assert.equal(genericCalls, 0, `generic 경로 누수 ${genericCalls}회`);
  // fingerprint 안정성 — 같은 근거는 같은 fingerprint (검색 결정론의 관측 축).
  assert.equal(ragEvidenceFingerprint([evidence]), ragEvidenceFingerprint([{ ...evidence }]));
}

// ── [C] model_insufficient 문구 분리 ─────────────────────────────────────────
async function runCopySeparationCheck(evidence: RagEvidence): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  const deps = {
    enablePlayerRag: true,
    loadGlossary: async () => [],
    loadPlayers: async () => players,
    getCache: async () => null,
    setCache: async () => {},
    reserveDaily: async () => ({ allowed: true, remaining: 19 }),
    releaseDaily: async () => {},
    log: async () => {},
    callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_PLAYER", answer: "일반 답변입니다." }), inputTokens: 1, outputTokens: 1 }),
    searchRag: async () => [evidence],
    callRagLlm: async () => ({ text: JSON.stringify({ status: RAG_INSUFFICIENT_SENTINEL }), inputTokens: 10, outputTokens: 2 }),
  } as unknown as QaDeps;
  await check("문구 — model_insufficient 는 '자료 부족'으로 나간다 (UNCLEAR 아님)", async () => {
    const result = await answerQuestion("u-matjauk-copy", "구자욱 별명이 왜 맛자욱이야?", deps);
    assert.equal(result.answer, RAG_INSUFFICIENT_ANSWER, `기대 자료부족 문구, 실제: ${result.answer}`);
    assert.notEqual(result.answer, UNCLEAR_ANSWER);
    assert.notEqual(RAG_INSUFFICIENT_ANSWER, UNCLEAR_ANSWER, "두 문구가 같으면 분리가 아니다");
  });
}

// ── temperature 계약 ─────────────────────────────────────────────────────────
async function runTemperatureCheck(evidence: RagEvidence): Promise<void> {
  await check("temperature — RAG 생성은 0 고정 (문면 grep 아니라 값 결속)", () => {
    assert.equal(RAG_GENERATION_TEMPERATURE, 0);
    const request = buildRagLlmRequest("구자욱 별명이 왜 맛자욱이야?", [evidence]);
    assert.equal(request.generationConfig.temperature, 0, "buildRagLlmRequest 가 0 이 아니다");
  });
}

async function runAll(options: DeterminismOptions): Promise<void> {
  await runExtractionChecks();
  await runVerifierChecks();
  const evidence = await runCrawlIngestProjectionChecks();
  await runTemperatureCheck(evidence);
  await check(
    `결정론 — 20회×2세션 동일답 + LLM 1회 (replay=${options.withReplayStore}, 결속=${options.withEvidence})`,
    () => runDeterminism(evidence, options),
  );
  await runCopySeparationCheck(evidence);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    // 결함주입 자기증명 — 이 게이트가 실제로 RED 를 낼 수 있는가.
    const expectRed = async (label: string, options: DeterminismOptions) => {
      const evidence = await runCrawlIngestProjectionChecks();
      let failed = false;
      try {
        await runDeterminism(evidence, options);
      } catch {
        failed = true;
      }
      if (!failed) {
        console.error(`SELFTEST FAIL — mutation [${label}] 이 GREEN 이다 (검증력 없음)`);
        process.exit(1);
      }
      console.log(`SELFTEST RED 확인 — ${label}`);
    };
    await expectRed("replay 제거(noreplay)", { withReplayStore: false, withEvidence: true });
    await expectRed("근거 결속 제거(unbind)", { withReplayStore: true, withEvidence: false });
    console.log("✅ selftest 통과 (mutation RED 2축 증명)");
    return;
  }
  const options: DeterminismOptions = {
    withReplayStore: !argv.includes("--mutate-noreplay"),
    withEvidence: !argv.includes("--mutate-unbind"),
  };
  await runAll(options);
  console.log(`✅ 맛자욱 P0 게이트 통과 (${pass}건)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
