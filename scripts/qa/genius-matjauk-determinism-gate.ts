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
 *       **request fingerprint** = model + 실제 buildRagLlmRequest 요청 전체, 삼순 P0-①).
 *       **flappy provider**(1회차 grounded, 2회차부터 insufficient) fixture 에서도
 *       20회×2세션 순차 + **동시 8-way 첫 miss**(삼순 P0-②, claim/대기/재조회) 종단 답이
 *       전부 동일하고 LLM 소비는 전 구간 합산 정확히 1회다.
 *   [C] 문구 계약 — `model_insufficient` 는 "이해 못함"(UNCLEAR)이 아니라 "자료 부족"
 *       문구로 나간다. 단 맛자욱 exact 는 근거 결속 후 그 분기로 절대 가지 않는다.
 *
 * 실행:      npx tsx scripts/qa/genius-matjauk-determinism-gate.ts
 * selftest:  npx tsx scripts/qa/genius-matjauk-determinism-gate.ts --selftest
 *   (결함주입을 in-process 로 돌려 게이트가 실제로 RED 를 낼 수 있음을 증명한다)
 * mutation:  --mutate-noreplay  → replay 저장소 제거: flappy provider 에서 반드시 실패(RED)
 *            --mutate-unbind    → 참조 근거 결속 제거: 채수빈 종단이 반드시 실패(RED)
 *            --mutate-noclaim   → 선점(claim) 제거: 동시 첫 miss 에서 반드시 실패(RED)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { answerQuestion, RAG_INSUFFICIENT_ANSWER, SYSTEM_ERROR_ANSWER, UNCLEAR_ANSWER, type GlossaryEntry, type PlayerRef, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
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
  ragRequestFingerprint,
  type VerifiedRagAnswerClaim,
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

// ── [B] 동일입력 결정론 (flappy provider + replay + 선점) ────────────────────
interface DeterminismOptions {
  withReplayStore: boolean;
  withEvidence: boolean;
  /** 선점(claim) 제공 여부 — false 면 동시 첫 miss 에서 결정론이 깨져야 한다(mutation 축). */
  withClaim: boolean;
  /**
   * 느린 winner 재현(삼순 2차 NO-GO) — 1회차 LLM 응답을 이만큼 지연시켜 waiter 들이
   * 여러 폴링을 거치게 한다. 이 구간에서 waiter 가 직접 생성으로 새면 LLM 중복이 난다.
   */
  slowWinnerMs?: number;
}

interface MemoryStoreOptions {
  withClaim: boolean;
  /** lease 기간(ms). 이 시간이 지난 pending 은 다음 claim 이 token 교체로 인수한다. */
  leaseMs?: number;
  /** 🔴 결함주입(mutation staleowner): release/settle 이 token 검증을 생략한다. */
  ignoreOwnerToken?: boolean;
  /**
   * 🔴 결함주입(mutation markrelease): markInsufficient 가 flight-terminal 마킹 대신
   * release 처럼 행을 지운다 — 삼순 3차 NO-GO 의 역방향 플립(같은 동시입력 2답·LLM 2회)을
   * 재현한다. 역방향 flappy 결정론 테스트가 반드시 RED 여야 한다.
   */
  markBehavesAsRelease?: boolean;
}

/** production 스키마(pending/settled + owner-token CAS)의 in-memory 등가물. */
function memoryStore(options: MemoryStoreOptions): VerifiedRagAnswerStore {
  const settled = new Map<string, VerifiedRagAnswerRecord>();
  const pending = new Map<string, { token: string; at: number }>();
  const leaseMs = options.leaseMs ?? 60_000;
  let seq = 0;
  const keyOf = (key: VerifiedRagAnswerKey) =>
    [key.entityType, key.entityId, key.questionNorm, key.evidenceFingerprint, key.requestFingerprint].join("\u0000");
  const store: VerifiedRagAnswerStore = {
    pollDelayMs: 5,
    pollAttempts: 200,
    get: async (key) => settled.get(keyOf(key)) ?? null,
    // settle — token CAS + first-writer-wins. settled 는 어떤 경우에도 덮어쓰지 않는다.
    put: async (key, record, ownerToken) => {
      const k = keyOf(key);
      if (settled.has(k)) return false;
      if (options.withClaim) {
        const current = pending.get(k);
        if (!options.ignoreOwnerToken && (!current || current.token !== ownerToken)) return false;
        settled.set(k, record);
        pending.delete(k);
        return true;
      }
      // claim 미지원(레거시 테스트 전용) — 첫 쓰기만 고정.
      settled.set(k, record);
      return true;
    },
  };
  if (options.withClaim) {
    const insufficient = new Map<string, { token: string; at: number; answer: string }>();
    store.claim = async (key): Promise<VerifiedRagAnswerClaim> => {
      const k = keyOf(key);
      if (settled.has(k)) return { verdict: "hit" };
      const terminal = insufficient.get(k);
      if (terminal) {
        // flight-terminal: TTL 내에는 같은 폐기 문구 재생, TTL 후엔 새 flight 로 인수.
        if (Date.now() - terminal.at < leaseMs) return { verdict: "insufficient", answer: terminal.answer };
        insufficient.delete(k);
      }
      const current = pending.get(k);
      if (current && Date.now() - current.at < leaseMs) return { verdict: "wait" };
      // 신규 선점 또는 lease 만료 인수 — **token 교체**(fencing).
      const token = `owner-${(seq += 1)}`;
      pending.set(k, { token, at: Date.now() });
      return { verdict: "winner", ownerToken: token };
    };
    store.markInsufficient = async (key, ownerToken, answer) => {
      const k = keyOf(key);
      const current = pending.get(k);
      if (!options.ignoreOwnerToken && (!current || current.token !== ownerToken)) return false;
      pending.delete(k);
      // 🔴 mutation markrelease: 마킹 없이 행만 지운다(=release) → waiter 가 새 winner 로
      // 재생성해 역방향 플립이 재현된다.
      if (!options.markBehavesAsRelease) insufficient.set(k, { token: ownerToken, at: Date.now(), answer });
      return true;
    };
    store.release = async (key, ownerToken) => {
      const k = keyOf(key);
      const current = pending.get(k);
      if (options.ignoreOwnerToken || (current && current.token === ownerToken)) pending.delete(k);
    };
  }
  return store;
}

async function runDeterminism(evidence: RagEvidence, options: DeterminismOptions): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  const gja = players.find((p) => p.name === "구자욱");
  assert.ok(gja, "로스터에 구자욱이 없다 — 로더 결함");
  const GLOSSARY: GlossaryEntry[] = [];
  const store = options.withReplayStore ? memoryStore({ withClaim: options.withClaim }) : undefined;
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
      //   slowWinnerMs 가 설정되면 1회차 응답을 지연시켜 느린 정상 winner 를 재현한다.
      callRagLlm: async () => {
        llmCalls += 1;
        if (llmCalls === 1) {
          if (options.slowWinnerMs) {
            await new Promise((resolve) => setTimeout(resolve, options.slowWinnerMs));
          }
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

  // 🔴 동시 첫 miss (삼순 P0-②): 서로 다른 messageId 8개가 같은 키의 첫 miss 를
  //   동시에 본다. claim 이 없으면 모두 LLM 을 부르고(flappy 라 2회차부터 INSUFFICIENT)
  //   서로 다른 답을 반환한다 — 그 경로가 이 단계에서 RED 가 된다(--mutate-noclaim).
  const CONCURRENCY = 8;
  const concurrent = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) =>
      answerQuestion(`u-matjauk-concurrent-${index}`, QUESTION, makeDeps()),
    ),
  );
  for (const result of concurrent) {
    answers.push(result.answer ?? "");
    sources.push(result.source ?? "");
  }

  // 순차 20회×2세션 — 세션마다 새 deps(새 캐시·새 컨텍스트), 세션당 10회.
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
  assert.equal(llmCalls, 1, `LLM 소비 ${llmCalls}회 (기대 1 — 동시 ${CONCURRENCY} + 순차 20 합산) — 선점/replay 가 일하지 않는다`);
  assert.equal(genericCalls, 0, `generic 경로 누수 ${genericCalls}회`);
  // fingerprint 안정성 — 같은 근거는 같은 fingerprint (검색 결정론의 관측 축).
  assert.equal(ragEvidenceFingerprint([evidence]), ragEvidenceFingerprint([{ ...evidence }]));
}

// ── [B'] request fingerprint 결속 (삼순 P0-①) — 생성 입력 어느 하나만 바뀌어도 miss ──
async function runRequestFingerprintChecks(evidence: RagEvidence): Promise<void> {
  const base = ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [evidence]);
  await check("request-fp — 동일 입력은 동일 fingerprint (결정론 전제)", () => {
    assert.equal(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [{ ...evidence }]));
  });
  await check("request-fp — 원문 질문이 다르면 miss (questionNorm 동일해도)", () => {
    assert.notEqual(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야??", [evidence]));
  });
  await check("request-fp — 직전 대화 context 가 다르면 miss", () => {
    assert.notEqual(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [evidence], {
      context: { question: "직전 질문", answer: "직전 답변" },
    }));
  });
  await check("request-fp — rosterBlock 이 다르면 miss", () => {
    assert.notEqual(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [evidence], {
      rosterBlock: "구자욱: 삼성 라이온즈 외야수",
    }));
  });
  await check("request-fp — model 이 다르면 miss (모델 교체 = 과거 답 재생 금지)", () => {
    assert.notEqual(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [evidence], {}, "gemini-other-model"));
  });
  await check("request-fp — 근거 내용이 다르면 miss (corpus 재적재 결속)", () => {
    assert.notEqual(base, ragRequestFingerprint("구자욱 별명이 왜 맛자욱이야?", [{ ...evidence, content: `${evidence.content} 개정됨` }]));
  });
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

// ── [B*] 역방향 flappy (삼순 3·4차 NO-GO) ────────────────────────────────────
// 계약(4차): 역방향 플립(첫 INSUFFICIENT → 이후 GROUNDED)에서도 한 flight 는
// **전원 채수빈 grounded**(owner 내부 재시도 복구) 또는 **전원 시스템 오류**다.
// 자료부족 negative cache 확산 금지. release 회귀(waiter 재생성 → 2답·LLM 초과)도 금지.
interface ReverseFlappyOptions {
  /** provider 가 INSUFFICIENT 를 내는 앞 호출 수. 1=재시도로 복구, 2=owner 재시도까지 실패. */
  insufficientCalls: number;
}

async function runReverseFlappyDeterminism(
  evidence: RagEvidence,
  storeOptions: MemoryStoreOptions,
  flappy: ReverseFlappyOptions,
): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  const store = memoryStore(storeOptions);
  let llmCalls = 0;
  // 로그 측면까지 검증한다 (삼순 5차 NO-GO-①) — answer 만 보면 source/matchPath 가
  // unsure 로 샐는 회귀를 못 잡는다(false-GREEN).
  const logs: Array<{ matchPath: string; inputTokens: number | null; outputTokens: number | null }> = [];
  const makeDeps = (): QaDeps =>
    ({
      enablePlayerRag: true,
      loadGlossary: async () => [],
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      releaseDaily: async () => {},
      log: async (entry: { matchPath: string; inputTokens: number | null; outputTokens: number | null }) => {
        logs.push({ matchPath: entry.matchPath, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens });
      },
      callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_PLAYER", answer: "일반 답변입니다." }), inputTokens: 1, outputTokens: 1 }),
      searchRag: async () => [evidence],
      // 🔴 역방향 flappy — 앞 insufficientCalls 회만 INSUFFICIENT, 이후 전부 GROUNDED.
      callRagLlm: async () => {
        llmCalls += 1;
        if (llmCalls <= flappy.insufficientCalls) {
          return { text: JSON.stringify({ status: RAG_INSUFFICIENT_SENTINEL }), inputTokens: 100, outputTokens: 2 };
        }
        return {
          text: JSON.stringify({
            status: RAG_GROUNDED_SENTINEL,
            answer: "구자욱 선수의 별명 맛자욱은 배우 채수빈 님이 열애설 당시 열애설을 맛보기한 느낌이라고 말한 데서 유래했습니다.",
          }),
          inputTokens: 100, outputTokens: 40,
        };
      },
      verifiedRagAnswers: store,
    }) as unknown as QaDeps;

  const QUESTION = "구자욱 별명이 왜 맛자욱이야?";
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      answerQuestion(`u-reverse-concurrent-${index}`, QUESTION, makeDeps()),
    ),
  );
  const answers = concurrent.map((r) => r.answer ?? "");
  assert.ok(answers.every((a) => a === answers[0]),
    `역방향 플립 — 동일 동시입력이 2답으로 갈렸다: ${[...new Set(answers)].join(" ||| ")}`);
  assert.ok(!answers.some((a) => a === RAG_INSUFFICIENT_ANSWER || a === UNCLEAR_ANSWER),
    `일시 플립이 자료부족/이해못함 negative cache 로 확산됐다: ${answers[0]}`);

  if (flappy.insufficientCalls === 1) {
    // 플립 1회 = owner 내부 재시도가 복구 — 첫 사용자부터 전원 채수빈 grounded (4차 계약).
    assert.ok(answers.every((a) => a.includes("채수빈")),
      `첫 사용자부터 채수빈 grounded 가 아니다: ${answers[0]}`);
    assert.equal(llmCalls, 2, `LLM 소비 ${llmCalls}회 (기대 2 — 초호출+재시도 1회, waiter 재생성 0회)`);
    // settled 재생 — LLM 불변.
    const replayed = await answerQuestion("u-reverse-replay", QUESTION, makeDeps());
    assert.ok(replayed.answer?.includes("채수빈"), `settled 재생 실패: ${replayed.answer}`);
    assert.equal(llmCalls, 2, `settled 재생이 LLM 을 소비했다(${llmCalls})`);
    return;
  }
  // 플립 2회(재시도까지 실패) = 전원 시스템 오류 — 자료부족 확산도, 채수빈 유출도 없다.
  assert.ok(answers.every((a) => a === SYSTEM_ERROR_ANSWER),
    `재시도 실패 flight 가 전원 시스템 오류가 아니다: ${[...new Set(answers)].join(" ||| ")}`);
  // 🔴 answer 만으로는 부족하다 (삼순 5차 NO-GO-①) — 반환 source 와 로그 matchPath 까지
  // error 여야 장애가 자료부족/판정불명으로 집계되지 않는다.
  const sources = concurrent.map((r) => r.source);
  assert.ok(sources.every((s) => s === "error"),
    `재시도 실패 flight 의 source 가 error 가 아니다: ${[...new Set(sources)].join(", ")}`);
  const errorLogs = logs.filter((entry) => entry.matchPath === "error");
  assert.equal(errorLogs.length, 8, `error 로그 ${errorLogs.length}건 (기대 8 — unsure 등 타 경로 집계 금지: ${logs.map((entry) => entry.matchPath).join(",")})`);
  assert.ok(!logs.some((entry) => entry.matchPath === "unsure"),
    "시스템 오류 종결이 unsure 로 집계됐다(5차 NO-GO-① 회귀)");
  // 🔴 재시도 토큰 합산 보존 (5차 NO-GO-②) — winner 의 error 로그에 초호출+재시도가 합산된다.
  assert.ok(errorLogs.some((entry) => entry.inputTokens === 200 && entry.outputTokens === 4),
    `winner error 로그에 합산 토큰(200/4)이 없다: ${JSON.stringify(errorLogs)}`);
  assert.equal(llmCalls, 2, `LLM 소비 ${llmCalls}회 (기대 2 — 초호출+재시도, waiter 재생성 금지)`);
  // TTL 내 재질문 — 같은 시스템 오류 공유, LLM 불변, source 도 error.
  const withinTtl = await answerQuestion("u-reverse-within-ttl", QUESTION, makeDeps());
  assert.equal(withinTtl.answer, SYSTEM_ERROR_ANSWER, `TTL 내 재질문이 다른 답: ${withinTtl.answer}`);
  assert.equal(withinTtl.source, "error", `TTL 내 재질문 source 가 ${withinTtl.source}`);
  assert.equal(llmCalls, 2, `TTL 내 재질문이 LLM 을 소비했다(${llmCalls})`);
  // lease TTL 만료 → 새 flight 가 재생성 — 이번엔 GROUNDED(3회차부터), 채수빈 필수.
  await new Promise((resolve) => setTimeout(resolve, (storeOptions.leaseMs ?? 60_000) + 30));
  const recovered = await answerQuestion("u-reverse-recovered", QUESTION, makeDeps());
  assert.ok(llmCalls >= 3, `TTL 후 새 flight 가 재생성하지 않았다(LLM ${llmCalls}회) — 실패 영구 고정`);
  assert.equal(recovered.source, "rag", `복구 답 source 가 ${recovered.source}`);
  assert.ok(recovered.answer?.includes("채수빈"), `맛자욱 정상 종결에 채수빈이 없다: ${recovered.answer}`);
  const finalLlm = llmCalls;
  const replayed = await answerQuestion("u-reverse-replay", QUESTION, makeDeps());
  assert.ok(replayed.answer?.includes("채수빈"), `settled 재생 실패: ${replayed.answer}`);
  assert.equal(llmCalls, finalLlm, `settled 재생이 LLM 을 소비했다(${llmCalls})`);
}

// ── [B''] store 계약 — lease takeover · stale owner fencing (삼순 2차 NO-GO) ──────
function storeContractKey(): VerifiedRagAnswerKey {
  return {
    entityType: "player",
    entityId: "62404",
    questionNorm: "구자욱 별명이 왜 맛자욱이야",
    evidenceFingerprint: "fp-evidence-contract",
    requestFingerprint: "fp-request-contract",
  };
}

async function runStoreOwnerTokenContract(store: VerifiedRagAnswerStore): Promise<void> {
  const key = storeContractKey();
  const record = (answer: string) => ({ answer, sourceUrl: null, toneCompliant: true });
  const first = await store.claim!(key);
  assert.equal(first.verdict, "winner", "첫 claim 이 winner 가 아니다");
  const tokenA = first.verdict === "winner" ? first.ownerToken : "";
  // lease 만료 대기 → takeover 가 **token 을 교체**해야 한다(fencing).
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = await store.claim!(key);
  assert.equal(second.verdict, "winner", "lease 만료 인수가 winner 가 아니다");
  const tokenB = second.verdict === "winner" ? second.ownerToken : "";
  assert.notEqual(tokenB, tokenA, "takeover 가 token 을 교체하지 않았다 — fencing 부재");
  // 구 winner 의 stale release 는 새 claim 을 지우지 못한다(no-op).
  await store.release!(key, tokenA);
  const afterStaleRelease = await store.claim!(key);
  assert.equal(afterStaleRelease.verdict, "wait",
    `stale release 가 새 claim 을 지웠다 — 판정 ${afterStaleRelease.verdict}`);
  // 구 winner 의 stale settle 은 CAS 패배다.
  assert.equal(await store.put(key, record("구 winner 의 답"), tokenA), false, "stale settle 이 성공했다");
  // 새 winner 의 settle 만 성공하고, settled 는 재쓰기 불가(first-writer-wins).
  assert.equal(await store.put(key, record("canonical 답"), tokenB), true, "정당 winner settle 이 실패했다");
  assert.equal(await store.put(key, record("덮어쓰기 시도"), tokenB), false, "settled 가 덮어쓰여졌다");
  const settled = await store.get(key);
  assert.equal(settled?.answer, "canonical 답", "canonical 이 보존되지 않았다");
  const afterSettle = await store.claim!(key);
  assert.equal(afterSettle.verdict, "hit", "settle 후 claim 이 hit 가 아니다");
}

// ── [B'''] 저장소 오류 fail-close · settle CAS 패자 canonical 재조회 ────────────
async function runFailureModeChecks(evidence: RagEvidence): Promise<void> {
  const players: PlayerRef[] = await loadRosterPlayers();
  const baseDeps = (store: Partial<VerifiedRagAnswerStore>, onLlm: () => void) =>
    ({
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
      callRagLlm: async () => {
        onLlm();
        return {
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "생성된 내 답입니다. 채수빈 유래입니다." }),
          inputTokens: 10, outputTokens: 5,
        };
      },
      verifiedRagAnswers: { pollDelayMs: 5, pollAttempts: 10, ...store },
    }) as unknown as QaDeps;

  await check("fail-close — get 오류는 시스템 오류로 닫고 LLM 을 소비하지 않는다", async () => {
    let llm = 0;
    const result = await answerQuestion("u-err-get", "구자욱 별명이 왜 맛자욱이야?", baseDeps({
      get: async () => { throw new Error("db down"); },
      put: async () => true,
    }, () => { llm += 1; }));
    assert.equal(result.source, "error", `오류가 ${result.source} 로 샐다: ${result.answer}`);
    assert.equal(llm, 0, `저장소 오류인데 LLM 을 소비했다(${llm}) — 중복 생성 경로`);
  });
  await check("fail-close — claim 오류는 winner 오인 없이 시스템 오류로 닫는다", async () => {
    let llm = 0;
    const result = await answerQuestion("u-err-claim", "구자욱 별명이 왜 맛자욱이야?", baseDeps({
      get: async () => null,
      put: async () => true,
      claim: async () => { throw new Error("rpc down"); },
      release: async () => {},
    }, () => { llm += 1; }));
    assert.equal(result.source, "error", `claim 오류가 ${result.source} 로 샐다: ${result.answer}`);
    assert.equal(llm, 0, `claim 오류인데 LLM 을 소비했다(${llm})`);
  });
  await check("fail-close — wait 상한 초과(느린 winner 생존) 시 직접 생성하지 않는다", async () => {
    let llm = 0;
    const result = await answerQuestion("u-wait-cap", "구자욱 별명이 왜 맛자욱이야?", baseDeps({
      get: async () => null,
      put: async () => true,
      claim: async () => ({ verdict: "wait" }),
      release: async () => {},
    }, () => { llm += 1; }));
    assert.equal(result.source, "error", `상한 초과가 ${result.source} 로 샐다: ${result.answer}`);
    assert.equal(llm, 0, `claim 없이 생성했다(${llm}) — 느린 winner 중복 호출 축(2차 NO-GO)`);
  });
  // mark 실패 회귀 공통 하니스 — 로그 토큰 합산 보존까지 검증한다 (삼순 5차 NO-GO-②).
  // 🔴 관측 4칸(ragAttemptPath·ragDiscardReason·numeric 2칸)까지 수집해 assert 한다
  // (삼순 6차 NO-GO — 토큰만 보면 관측 유실이 false-GREEN 으로 샐다).
  type ObservedLog = {
    matchPath: string; inputTokens: number | null; outputTokens: number | null;
    ragAttemptPath?: string; ragDiscardReason?: string | null;
    ragQuestionNumericCount?: number; ragDiscardNumericCount?: number | null;
  };
  const pickObserved = (entry: ObservedLog): ObservedLog => ({
    matchPath: entry.matchPath, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
    ragAttemptPath: entry.ragAttemptPath, ragDiscardReason: entry.ragDiscardReason,
    ragQuestionNumericCount: entry.ragQuestionNumericCount, ragDiscardNumericCount: entry.ragDiscardNumericCount,
  });
  // ⚠️ null 은 관측된 유효값이다(discard 수치 부재 등) — 유실(undefined)과 구분해야 한다.
  // typeof === "number" 로 걸면 관측된 null 이 유실로 오판된다(반대로 읽힘).
  const hasFullObservation = (entry: ObservedLog): boolean =>
    entry.ragAttemptPath === "player" && entry.ragDiscardReason !== undefined &&
    typeof entry.ragQuestionNumericCount === "number" && entry.ragDiscardNumericCount !== undefined;
  const runMarkFailure = async (options: {
    user: string;
    markMode: "false" | "throw";
    canonicalAfterMark: boolean;
  }) => {
    let llm = 0;
    let markAttempted = false;
    const logs: ObservedLog[] = [];
    const canonical = { answer: "takeover winner 의 canonical 답입니다. 채수빈 유래입니다.", sourceUrl: null, toneCompliant: true };
    const result = await answerQuestion(options.user, "구자욱 별명이 왜 맛자욱이야?", ({
      enablePlayerRag: true,
      loadGlossary: async () => [],
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      releaseDaily: async () => {},
      log: async (entry: ObservedLog) => {
        logs.push(pickObserved(entry));
      },
      callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_PLAYER", answer: "일반 답변입니다." }), inputTokens: 1, outputTokens: 1 }),
      searchRag: async () => [evidence],
      // 재시도까지 non-grounded — mark 경로로 간다.
      callRagLlm: async () => {
        llm += 1;
        return { text: JSON.stringify({ status: RAG_INSUFFICIENT_SENTINEL }), inputTokens: 10, outputTokens: 2 };
      },
      verifiedRagAnswers: {
        pollDelayMs: 5, pollAttempts: 10,
        get: async () => (options.canonicalAfterMark && markAttempted ? canonical : null),
        put: async () => true,
        claim: async () => ({ verdict: "winner", ownerToken: "my-token" }),
        markInsufficient: async () => {
          markAttempted = true;
          if (options.markMode === "throw") throw new Error("rpc down");
          return false;
        },
        release: async () => {},
      },
    }) as unknown as QaDeps);
    return { result, llm, logs };
  };
  await check("mark CAS 패배(takeover grounded) — canonical 반환 + 소비 토큰 합산 보존 (4·5차 NO-GO-②)", async () => {
    const { result, llm, logs } = await runMarkFailure({ user: "u-mark-false-canonical", markMode: "false", canonicalAfterMark: true });
    assert.equal(result.source, "rag", `mark 패배가 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(result.answer?.includes("takeover winner 의 canonical"), `canonical 이 아니다: ${result.answer}`);
    assert.equal(llm, 2, `LLM 소비 ${llm}회 (기대 2 — 초호출+재시도)`);
    // 🔴 canonical 재생 로그에 합산 토큰(20/4) + 관측 4칸이 보존된다 (5·6차 NO-GO).
    assert.ok(logs.some((entry) => entry.matchPath === "rag" && entry.inputTokens === 20 && entry.outputTokens === 4 && hasFullObservation(entry)),
      `canonical 재생 로그에 합산 토큰·관측 4칸이 없다(유실): ${JSON.stringify(logs)}`);
  });
  await check("mark throw + takeover grounded — canonical 반환(2답 분기 방지) + 토큰 보존 (5차 NO-GO-③ actual)", async () => {
    const { result, llm, logs } = await runMarkFailure({ user: "u-mark-throw-canonical", markMode: "throw", canonicalAfterMark: true });
    assert.equal(result.source, "rag", `mark throw+canonical 이 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(result.answer?.includes("takeover winner 의 canonical"), `canonical 이 아니다: ${result.answer}`);
    assert.equal(llm, 2, `LLM 소비 ${llm}회 (기대 2)`);
    assert.ok(logs.some((entry) => entry.matchPath === "rag" && entry.inputTokens === 20 && entry.outputTokens === 4 && hasFullObservation(entry)),
      `canonical 재생 로그에 합산 토큰·관측 4칸이 없다(유실): ${JSON.stringify(logs)}`);
  });
  await check("mark throw + canonical 없음 — 시스템 오류 종결 + 소비 토큰·관측 보존 (4·5차 NO-GO-②)", async () => {
    const { result, llm, logs } = await runMarkFailure({ user: "u-mark-throw-none", markMode: "throw", canonicalAfterMark: false });
    assert.equal(result.source, "error", `mark throw 가 ${result.source} 로 샐다: ${result.answer}`);
    assert.equal(llm, 2, `LLM 소비 ${llm}회 (기대 2)`);
    // 🔴 error 로그에 합산 토큰(20/4) + 관측 4칸 보존 — failCloseError null 기록 회귀 차단 (5·6차 NO-GO).
    assert.ok(logs.some((entry) => entry.matchPath === "error" && entry.inputTokens === 20 && entry.outputTokens === 4 && hasFullObservation(entry)),
      `error 로그에 합산 토큰·관측 4칸이 없다(유실): ${JSON.stringify(logs)}`);
  });
  await check("settle CAS 패자 — 자기 생성답을 버리고 canonical 을 재조회해 반환한다", async () => {
    let llm = 0;
    let settledByOther = false;
    const canonical = { answer: "먼저 고정된 canonical 답입니다. 채수빈 유래입니다.", sourceUrl: null, toneCompliant: true };
    const result = await answerQuestion("u-cas-loser", "구자욱 별명이 왜 맛자욱이야?", baseDeps({
      get: async () => (settledByOther ? canonical : null),
      claim: async () => ({ verdict: "winner", ownerToken: "my-token" }),
      // lease 인수된 다른 winner 가 먼저 settle 했다 — 내 settle 은 CAS 패배.
      put: async () => { settledByOther = true; return false; },
      release: async () => {},
    }, () => { llm += 1; }));
    assert.equal(result.source, "rag", `CAS 패자가 ${result.source} 로 끝났다: ${result.answer}`);
    assert.ok(result.answer?.includes("먼저 고정된 canonical"), `canonical 이 아니라 내 생성답이 나갔다: ${result.answer}`);
    assert.ok(!result.answer?.includes("생성된 내 답"), `CAS 패자의 자기 답이 발송됐다: ${result.answer}`);
    assert.equal(llm, 1, `LLM 소비 ${llm}회 (기대 1)`);
  });
  await check("put throw(LLM 소비 후 저장 실패) — 시스템 오류 종결에 합산 토큰·관측 보존 (6차 NO-GO-②)", async () => {
    let llm = 0;
    const logs: ObservedLog[] = [];
    const result = await answerQuestion("u-put-throw", "구자욱 별명이 왜 맛자욱이야?", ({
      enablePlayerRag: true,
      loadGlossary: async () => [],
      loadPlayers: async () => players,
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      releaseDaily: async () => {},
      log: async (entry: ObservedLog) => { logs.push(pickObserved(entry)); },
      callLlm: async () => ({ text: JSON.stringify({ status: "BASEBALL_PLAYER", answer: "일반 답변입니다." }), inputTokens: 1, outputTokens: 1 }),
      searchRag: async () => [evidence],
      // grounded 응답 — settle(put) 경로로 간다.
      callRagLlm: async () => {
        llm += 1;
        return {
          text: JSON.stringify({ status: RAG_GROUNDED_SENTINEL, answer: "구자욱 선수의 별명 맛자욱은 배우 채수빈 님 유래입니다." }),
          inputTokens: 30, outputTokens: 12,
        };
      },
      verifiedRagAnswers: {
        pollDelayMs: 5, pollAttempts: 10,
        get: async () => null,
        put: async () => { throw new Error("settle rpc down"); },
        claim: async () => ({ verdict: "winner", ownerToken: "my-token" }),
        release: async () => {},
      },
    }) as unknown as QaDeps);
    assert.equal(result.source, "error", `put throw 가 ${result.source} 로 샐다: ${result.answer}`);
    assert.equal(llm, 1, `LLM 소비 ${llm}회 (기대 1)`);
    // 🔴 LLM 을 이미 소비한 뒤의 저장 실패 — error 로그에 토큰(30/12)과 관측이 보존된다.
    assert.ok(logs.some((entry) => entry.matchPath === "error" && entry.inputTokens === 30 && entry.outputTokens === 12 && entry.ragAttemptPath === "player"),
      `put throw error 로그에 토큰·관측이 없다(유실): ${JSON.stringify(logs)}`);
  });
}

// ── [B''''] 실제 migration 경쟁 (PGlite — 배포될 SQL 그대로) ──────────────────
async function runPgliteMigrationRaceChecks(): Promise<void> {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
  const sql = readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260819070000_genius_rag_verified_answers.sql"),
    "utf8",
  );
  await db.exec(sql);
  const K = {
    t: "player", id: "62404", q: "구자욱 별명이 왜 맛자욱이야",
    ef: "fp-ev-pg", rf: "fp-req-pg",
  };
  const claim = async (lease = 60) => {
    const res = await db.query<{ v: { verdict: string; owner_token?: string } }>(
      "select claim_genius_rag_verified_answer($1,$2,$3,$4,$5,$6) as v",
      [K.t, K.id, K.q, K.ef, K.rf, lease],
    );
    return res.rows[0].v;
  };
  const settle = async (token: string, answer: string) => {
    const res = await db.query<{ v: boolean }>(
      "select settle_genius_rag_verified_answer($1,$2,$3,$4,$5,$6,$7,$8,$9) as v",
      [K.t, K.id, K.q, K.ef, K.rf, token, answer, null, true],
    );
    return res.rows[0].v;
  };
  const release = async (token: string) => {
    const res = await db.query<{ v: boolean }>(
      "select release_genius_rag_verified_answer($1,$2,$3,$4,$5,$6) as v",
      [K.t, K.id, K.q, K.ef, K.rf, token],
    );
    return res.rows[0].v;
  };

  await check("PGlite — 동시 claim 8회에서 winner 정확히 1명", async () => {
    const verdicts = await Promise.all(Array.from({ length: 8 }, () => claim()));
    const winners = verdicts.filter((entry) => entry.verdict === "winner");
    const waits = verdicts.filter((entry) => entry.verdict === "wait");
    assert.equal(winners.length, 1, `winner ${winners.length}명: ${JSON.stringify(verdicts)}`);
    assert.equal(waits.length, 7, `wait ${waits.length}명`);
    assert.ok(winners[0].owner_token, "winner 에 owner_token 이 없다");
  });

  await check("PGlite — lease 만료 인수가 token 을 교체하고 구 token 은 전부 무효(fencing)", async () => {
    // 현재 pending 의 token 확보 후 lease 를 강제 만료시킨다.
    const staleRow = await db.query<{ owner_token: string }>(
      "select owner_token from genius_rag_verified_answers where request_fingerprint=$1", [K.rf],
    );
    const staleToken = staleRow.rows[0].owner_token;
    await db.query(
      "update genius_rag_verified_answers set claimed_at = now() - interval '10 minutes' where request_fingerprint=$1",
      [K.rf],
    );
    const takeover = await claim();
    assert.equal(takeover.verdict, "winner", `만료 lease 인수 실패: ${JSON.stringify(takeover)}`);
    assert.notEqual(takeover.owner_token, staleToken, "takeover 가 token 을 교체하지 않았다");
    // 구 winner 의 stale release → no-op (새 claim 생존).
    assert.equal(await release(staleToken), false, "stale release 가 성공했다");
    const still = await claim();
    assert.equal(still.verdict, "wait", `stale release 뒤 claim 이 ${still.verdict} — pending 이 지워졌다`);
    // 구 winner 의 stale settle → CAS 패배.
    assert.equal(await settle(staleToken, "구 winner 답"), false, "stale settle 이 성공했다");
    // 새 winner settle → 성공, 이후 first-writer-wins.
    assert.equal(await settle(takeover.owner_token!, "canonical 답입니다"), true, "정당 settle 실패");
    assert.equal(await settle(takeover.owner_token!, "덮어쓰기"), false, "settled 가 다시 settle 됐다");
    const hit = await claim();
    assert.equal(hit.verdict, "hit", `settle 후 claim 이 ${hit.verdict}`);
    const row = await db.query<{ answer: string; status: string }>(
      "select answer, status from genius_rag_verified_answers where request_fingerprint=$1", [K.rf],
    );
    assert.equal(row.rows[0].status, "settled");
    assert.equal(row.rows[0].answer, "canonical 답입니다", "canonical 이 보존되지 않았다");
  });

  await check("PGlite — mark-insufficient token CAS + flight 공유 + TTL 후 pending 복귀 인수", async () => {
    const K2 = { ...K, rf: "fp-req-pg-insufficient" };
    const claim2 = async (lease = 60) => {
      const res = await db.query<{ v: { verdict: string; owner_token?: string; answer?: string } }>(
        "select claim_genius_rag_verified_answer($1,$2,$3,$4,$5,$6) as v",
        [K2.t, K2.id, K2.q, K2.ef, K2.rf, lease],
      );
      return res.rows[0].v;
    };
    const mark2 = async (token: string, answer: string) => {
      const res = await db.query<{ v: boolean }>(
        "select mark_insufficient_genius_rag_verified_answer($1,$2,$3,$4,$5,$6,$7) as v",
        [K2.t, K2.id, K2.q, K2.ef, K2.rf, token, answer],
      );
      return res.rows[0].v;
    };
    const first = await claim2();
    assert.equal(first.verdict, "winner");
    // 타 token 의 mark 는 CAS 패배.
    assert.equal(await mark2("00000000-0000-0000-0000-000000000000", "위조 문구"), false, "타 token mark 가 성공했다");
    // 정당 token 의 mark → 같은 flight 의 claim 은 같은 폐기 문구를 받는다.
    assert.equal(await mark2(first.owner_token!, "자료 부족 문구"), true, "정당 mark 실패");
    const shared = await claim2();
    assert.equal(shared.verdict, "insufficient", `flight 공유 판정이 ${shared.verdict}`);
    assert.equal(shared.answer, "자료 부족 문구", "공유 문구 불일치");
    // settled 가 아니므로 get 은 여전히 빈다 — 오답이 검증답으로 재생되면 안 된다.
    const notSettled = await db.query<{ status: string }>(
      "select status from genius_rag_verified_answers where request_fingerprint=$1", [K2.rf],
    );
    assert.equal(notSettled.rows[0].status, "insufficient");
    // TTL 만료 → 새 flight 가 pending 복귀 + token 교체로 인수(재생성 허용 — 영구 캐시 금지).
    await db.query(
      "update genius_rag_verified_answers set claimed_at = now() - interval '10 minutes' where request_fingerprint=$1", [K2.rf],
    );
    const takeover2 = await claim2();
    assert.equal(takeover2.verdict, "winner", `TTL 후 인수 실패: ${JSON.stringify(takeover2)}`);
    assert.notEqual(takeover2.owner_token, first.owner_token, "인수가 token 을 교체하지 않았다");
    const backToPending = await db.query<{ status: string; answer: string | null }>(
      "select status, answer from genius_rag_verified_answers where request_fingerprint=$1", [K2.rf],
    );
    assert.equal(backToPending.rows[0].status, "pending");
    assert.equal(backToPending.rows[0].answer, null, "pending 복귀가 폐기 문구를 남겼다");
  });

  await check("PGlite — RLS 활성 + 함수 권한이 service_role 로만 제한", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname='genius_rag_verified_answers'",
    );
    assert.equal(rls.rows[0].relrowsecurity, true, "RLS 미활성");
    const acl = await db.query<{ ok: boolean }>(
      "select has_function_privilege('anon', 'claim_genius_rag_verified_answer(text,text,text,text,text,integer)', 'execute') as ok",
    );
    assert.equal(acl.rows[0].ok, false, "anon 이 claim RPC 를 실행할 수 있다");
  });

  await db.close();
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
  await runRequestFingerprintChecks(evidence);
  await check(
    `결정론 — 동시 8-way + 20회×2세션 동일답 + LLM 합산 1회 (replay=${options.withReplayStore}, claim=${options.withClaim}, 결속=${options.withEvidence})`,
    () => runDeterminism(evidence, options),
  );
  await check("결정론 — 느린 winner(응답 지연 > 폴링 여러 회)에서도 동일답 + LLM 1회 (2차 NO-GO 축)", () =>
    runDeterminism(evidence, { ...options, slowWinnerMs: 150 }));
  await check("역방향 flappy(플립 1회) — owner 내부 재시도로 첫 사용자부터 전원 채수빈 grounded + LLM 2회 (4차 NO-GO 축)", () =>
    runReverseFlappyDeterminism(evidence, { withClaim: true, leaseMs: 300 }, { insufficientCalls: 1 }));
  await check("역방향 flappy(재시도까지 실패) — 전원 시스템 오류(negative cache 확산 금지), TTL 후 새 flight 가 채수빈 복구 (3·4차 NO-GO 축)", () =>
    runReverseFlappyDeterminism(evidence, { withClaim: true, leaseMs: 300 }, { insufficientCalls: 2 }));
  await check("store 계약 — lease takeover token 교체 + stale release/settle 무효 + first-writer-wins", () =>
    runStoreOwnerTokenContract(memoryStore({ withClaim: true, leaseMs: 30, ignoreOwnerToken: !options.withClaim && false })));
  await runFailureModeChecks(evidence);
  await runPgliteMigrationRaceChecks();
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
    await expectRed("replay 제거(noreplay)", { withReplayStore: false, withClaim: false, withEvidence: true });
    await expectRed("근거 결속 제거(unbind)", { withReplayStore: true, withClaim: true, withEvidence: false });
    await expectRed("선점 제거(noclaim) — 동시 첫 miss 결정론 붕괴", { withReplayStore: true, withClaim: false, withEvidence: true });
    // 🔴 stale-owner mutation: release/settle 이 token 검증을 생략하면 store 계약 테스트가
    //   반드시 RED 여야 한다 — stale release 가 새 claim 을 지우는 결함(2차 NO-GO 축).
    {
      let failed = false;
      try {
        await runStoreOwnerTokenContract(memoryStore({ withClaim: true, leaseMs: 30, ignoreOwnerToken: true }));
      } catch {
        failed = true;
      }
      if (!failed) {
        console.error("SELFTEST FAIL — mutation [stale-owner(token 검증 생략)] 이 GREEN 이다");
        process.exit(1);
      }
      console.log("SELFTEST RED 확인 — stale-owner(token 검증 생략)");
    }
    // 🔴 mark→release 회귀 mutation (3차 NO-GO 축): non-grounded 종결이 flight-terminal
    //   마킹 대신 release 처럼 행을 지우면 역방향 flappy 동시 8-way 에서 waiter 가 새
    //   winner 로 재생성 → 2답·LLM 2회 — 반드시 RED 여야 한다.
    {
      const evidence = await runCrawlIngestProjectionChecks();
      let failed = false;
      try {
        await runReverseFlappyDeterminism(
          evidence,
          { withClaim: true, leaseMs: 300, markBehavesAsRelease: true },
          { insufficientCalls: 2 },
        );
      } catch {
        failed = true;
      }
      if (!failed) {
        console.error("SELFTEST FAIL — mutation [mark→release 회귀(역방향 플립)] 이 GREEN 이다");
        process.exit(1);
      }
      console.log("SELFTEST RED 확인 — mark→release 회귀(역방향 플립 재생성)");
    }
    console.log("✅ selftest 통과 (mutation RED 5축 증명)");
    return;
  }
  const options: DeterminismOptions = {
    withReplayStore: !argv.includes("--mutate-noreplay"),
    withClaim: !argv.includes("--mutate-noclaim") && !argv.includes("--mutate-noreplay"),
    withEvidence: !argv.includes("--mutate-unbind"),
  };
  await runAll(options);
  console.log(`✅ 맛자욱 P0 게이트 통과 (${pass}건)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
