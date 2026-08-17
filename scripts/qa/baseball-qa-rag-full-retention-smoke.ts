/**
 * 전문 보존(full) 정책 회귀.
 *
 * 하린아빠 2026-08-02 결정: "저장을 100%해줘"·"나무위키도 100%로 해".
 * 근거는 학습용 코퍼스이고 답변 정확성이 우선이라는 것이다.
 *
 * 이 스크립트가 잠그는 계약은 3가지다.
 *   (1) **무손실** — 정리본의 어떤 문단도 유실되지 않는다. 특히 900자를 넘는 문단을
 *       `slice`로 잘라 버리면 "100%"가 거짓이 되므로, 분할되었더라도 이어 붙이면
 *       원문 문자열이 복원되어야 한다.
 *   (2) **서빙 노출 유한** — 저장을 100%로 올려도 답변에 나가는 근거 총량은
 *       `RAG_EVIDENCE_LIMIT × RAG_EVIDENCE_MAX_CHARS`로 고정된 유한값이다.
 *       저장 100% ≠ 노출 100%. 이게 깨지면 원문이 외부로 새는 것이다.
 *   (3) **minimal 계약 무회귀** — 정책을 명시하면 기존 §12.2(c) 상한이 그대로 동작한다.
 *       full 전환이 기존 계약 코드를 삭제한 것이 아님을 증명한다.
 */
import assert from "node:assert/strict";

import {
  ENTITY_RETENTION_MAX_CHARS,
  MAX_CHUNK_CHARS,
  RETENTION_MAX_CHARS,
  RETENTION_POLICY,
  packFullDocumentChunks,
  prepareTier2Chunks,
  prepareTier2DocumentSet,
  stripWikiMarkup,
} from "../../src/lib/baseball-qa/rag/ingest";
import { RAG_EVIDENCE_LIMIT, RAG_EVIDENCE_MAX_CHARS } from "../../src/lib/baseball-qa/rag/retrieve";

let passed = 0;
const ok = (label: string): void => {
  passed += 1;
  console.log(`PASS ${label}`);
};

const doc = (rawText: string, sectionPath = "본문") => ({
  entityType: "player" as const,
  entityId: "69102",
  pageTitle: "문보경",
  canonicalUrl: "https://namu.wiki/w/%EB%AC%B8%EB%B3%B4%EA%B2%BD",
  revision: "crawled:2026-08-02T00:00:00Z",
  sectionPath,
  crawledAt: "2026-08-02T00:00:00Z",
  asOf: "2026-08-02",
  rawText,
});

/** (0) 운영 기본 정책이 full인지. 이 값이 되돌아가면 100% 저장 결정이 조용히 무효가 된다. */
function verifyOperatingPolicy(): void {
  assert.equal(RETENTION_POLICY, "full", "운영 보존 정책이 full이어야 한다(하린아빠 2026-08-02 결정)");
  ok("운영 정책 = full");
}

/** (1) 무손실 — 문단이 900자를 넘어도 잘려 사라지지 않는다. */
function verifyLossless(): void {
  // 실제 나무위키 문서에는 900자를 훌쩍 넘는 문단이 흔하다(실측 평균 18,171자/문서).
  const longParagraph = "문보경의 타격 매커니즘에 대한 아주 긴 서술 문단이다. ".repeat(120); // 약 3,000자
  const shortParagraph = "별명은 문학소년이다.";
  const rawText = [longParagraph, shortParagraph, longParagraph].join("\n\n");
  const clean = stripWikiMarkup(rawText);

  const chunks = packFullDocumentChunks(clean);
  assert.ok(chunks.length > 0, "full 정책에서 chunk가 0건이면 안 된다");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= MAX_CHUNK_CHARS, `chunk가 상한 초과: ${chunk.length} > ${MAX_CHUNK_CHARS}`);
  }

  // 핵심 계약: 공백을 정규화하면 원문 문자가 한 글자도 사라지지 않는다.
  const norm = (value: string): string => value.replace(/\s+/g, "");
  assert.equal(
    norm(chunks.join("")),
    norm(clean),
    "full 정책인데 원문이 유실됐다 — 900자 초과 문단을 잘라버린 것이다(100% 저장 거짓)",
  );
  ok(`무손실 보존 — 정리본 ${clean.length}자 → chunk ${chunks.length}건, 문자 유실 0`);
}

/** (1-b) 스텁 문서도 버리지 않는다 — minimal에서 310건을 fail-close 시킨 그 경로. */
function verifyStubDocumentRetained(): void {
  const stub = "김백산은 두산 베어스 소속 투수이다.";
  const full = prepareTier2Chunks(doc(stub));
  assert.equal(full.ok, true, "full 정책은 스텁 문서도 보존해야 한다");

  const minimal = prepareTier2Chunks(doc(stub), "minimal");
  assert.equal(minimal.ok, false, "minimal 정책에서는 예산 미달로 fail-close 되는 문서여야 한다(대조군)");
  ok("스텁 문서 보존 — full은 저장, minimal은 종전대로 fail-close");
}

/**
 * (2) 서빙 노출량은 **저장 정책과 독립적으로 유한**하다.
 *
 * ⚠️ 2026-08-16 계약 정정. 종전에는 `노출 총량 === RETENTION_MAX_CHARS` 라는 **등식**이었다.
 * 그 등식은 "minimal 보존 상한을 서빙이 실제 소비 가능한 양에 맞춘다"는 §12.2(c) 근거를
 * 굳힌 것이었는데, 근거의 본체는 **"서빙이 쓰지도 않을 원문을 보관하지 않는다"** 라는
 * 부등식(`저장 ≤ 소비가능`)이지 등식이 아니다. 노출량을 올리면(4→6건, 600→800자)
 * 등식은 깨지지만 부등식은 그대로 성립한다 — 오히려 더 보수적인 쪽이다.
 *
 * 그래서 여기서 잠그는 것은 두 가지다.
 *  (a) minimal 보존 상한은 서빙이 소비 가능한 총량을 **넘지 않는다**(§12.2(c) 본체).
 *  (b) 노출 총량은 여전히 **유한하고 고정된 상수의 곱**이다 — 저장 100%가 노출 100%로
 *      새지 않는다는 것이 이 파일이 지키는 진짜 계약이다.
 */
function verifyServingExposureBounded(): void {
  assert.equal(RAG_EVIDENCE_LIMIT, 6, "서빙 근거 건수가 바뀌면 노출량 계약이 깨진다");
  assert.equal(RAG_EVIDENCE_MAX_CHARS, 800, "서빙 근거 길이가 바뀌면 노출량 계약이 깨진다");
  const exposure = RAG_EVIDENCE_LIMIT * RAG_EVIDENCE_MAX_CHARS;
  assert.ok(
    RETENTION_MAX_CHARS <= exposure,
    `minimal 보존 상한(${RETENTION_MAX_CHARS})이 서빙 소비 가능 총량(${exposure})을 넘으면 §12.2(c) 위반이다`,
  );
  ok(`서빙 노출 유한 — 근거 ${RAG_EVIDENCE_LIMIT}건 × ${RAG_EVIDENCE_MAX_CHARS}자 = 최대 ${exposure}자, minimal 보존 상한 ${RETENTION_MAX_CHARS}자 ≤ 그 값 (저장 100%와 무관)`);
}

/** (3) minimal 계약 무회귀 — full 전환이 기존 계약을 지운 것이 아니다. */
function verifyMinimalContractIntact(): void {
  const paragraphs = [
    "문보경은 LG 트윈스 소속 내야수로 별명은 문학소년이다.",
    ...Array.from({ length: 40 }, (_, i) => `무관한 상세 서술 문단 ${i}. 방송 출연과 팬 이벤트 등 retrieval과 관련이 옅은 내용이 길게 이어진다.`),
  ];
  const rawText = paragraphs.join("\n\n");
  const clean = stripWikiMarkup(rawText);

  const minimal = prepareTier2Chunks(doc(rawText), "minimal");
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  const stored = minimal.chunks.reduce((sum, c) => sum + c.contentChars, 0);
  assert.ok(stored <= RETENTION_MAX_CHARS, `minimal 절대 상한 위반: ${stored}`);
  assert.ok(stored <= Math.floor(clean.length * 0.2), `minimal 비율 상한 위반: ${stored}`);

  const full = prepareTier2Chunks(doc(rawText));
  assert.equal(full.ok, true);
  if (!full.ok) return;
  const fullStored = full.chunks.reduce((sum, c) => sum + c.contentChars, 0);
  assert.ok(
    fullStored > stored,
    `full이 minimal보다 많이 저장해야 한다 (full ${fullStored} vs minimal ${stored})`,
  );
  ok(`minimal 무회귀 — 같은 문서에서 minimal ${stored}자(상한 준수) / full ${fullStored}자`);
}

/** (3-b) entity 합산도 full에서는 상한에 걸려 뒷 문서가 유실되지 않는다. */
function verifyEntitySetNotTruncated(): void {
  const documents = Array.from({ length: 20 }, (_, index) =>
    doc(
      Array.from({ length: 30 }, (_, p) => `문보경 선수 경력 ${index}-${p}. 유효한 서술 문단입니다. `.repeat(4)).join("\n\n"),
      `문보경/선수 경력/${2007 + index}년`,
    ));

  const full = prepareTier2DocumentSet(documents);
  assert.equal(full.ok, true);
  if (!full.ok) return;
  const sections = new Set(full.chunks.map((c) => c.meta.sectionPath));
  assert.equal(sections.size, documents.length, "full 정책인데 일부 하위문서가 통째로 빠졌다");
  const retained = full.chunks.reduce((sum, c) => sum + c.contentChars, 0);
  assert.ok(
    retained > ENTITY_RETENTION_MAX_CHARS,
    `full 정책이 여전히 entity 상한(${ENTITY_RETENTION_MAX_CHARS}자)에 묶여 있다: ${retained}`,
  );

  const minimal = prepareTier2DocumentSet(documents, "minimal");
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  const minimalRetained = minimal.chunks.reduce((sum, c) => sum + c.contentChars, 0);
  assert.ok(minimalRetained <= ENTITY_RETENTION_MAX_CHARS, "minimal entity 상한 무회귀");
  ok(`entity 무절단 — full ${documents.length}문서 전부 보존(${retained}자) / minimal ${minimalRetained}자 상한 준수`);
}

function run(): void {
  verifyOperatingPolicy();
  verifyLossless();
  verifyStubDocumentRetained();
  verifyServingExposureBounded();
  verifyMinimalContractIntact();
  verifyEntitySetNotTruncated();
  console.log(`\nbaseball QA RAG full-retention PASS (${passed} 섹션)`);
}

run();
