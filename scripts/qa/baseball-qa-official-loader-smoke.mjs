#!/usr/bin/env node
/**
 * KBO 공식 e북 적재기(load-official-corpus.mjs) 계약 회귀.
 *
 * 고정하는 사고:
 *  1. **조문 단위 입력이 페이지로 뭉개진다** — 조문 836건을 넣었는데 275건만 남았고,
 *     로더는 그런데도 "적재 완료"로 보고했다(생성 수를 찍었을 뿐 DB를 안 봤다).
 *  2. **파서가 `section`을 흘린다** — prepareDocument가 조문 모드를 판정하는 유일한 신호인데
 *     JSONL → doc.pages 변환에서 빠뜨리면 1번이 그대로 재현된다.
 *  3. **UNIQUE 키 충돌이 조용한 덮어쓰기가 된다** — upsert가 앞 행을 지우면 유실을 사후에
 *     증명할 수 없다. 적재 전에 막아야 한다.
 *
 * 이 스모크는 실제 배포되는 스크립트의 함수를 소스에서 뽑아 평가한다(사본 검증 금지).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, "..", "baseball-qa", "rag", "load-official-corpus.mjs");
const src = readFileSync(TARGET, "utf8");

/** 소스에서 함수 1개를 균형 중괄호로 잘라낸다. */
function pick(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} 없음 — 스크립트 구조가 바뀌었다`);
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`${name}: 중괄호 불균형`);
}

const prelude = `
import crypto from "node:crypto";
const MIN_CHUNK_CHARS = 40, MAX_CHUNK_CHARS = 900, LIMIT_CHUNKS = 0;
function sha256(t){return crypto.createHash("sha256").update(t,"utf8").digest("hex");}
function slugify(s){return String(s).trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g,"-").replace(/^-+|-+$/g,"");}
`;
const mod = prelude + pick("chunkText") + "\n" + pick("prepareDocument") + "\nexport { prepareDocument };";
const { prepareDocument } = await import(
  "data:text/javascript;base64," + Buffer.from(mod).toString("base64")
);

let pass = 0;
const fails = [];
const t = (name, fn) => {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fails.push(`${name}: ${e.message}`); console.error("FAIL", name, e.message); }
};
const body = (n) => "가나다라마바사아자차카타파하".repeat(Math.ceil(n / 14)).slice(0, n);
const doc = (pages, title = "규칙") => ({
  title, entity: title, crawledAt: "2026-08-01T00:00:00Z",
  canonicalUrl: "https://example.test", canonicalUrlVerified: false, pages,
});

t("사고 재현 — 같은 페이지의 조문 3개가 각각 살아남는다", () => {
  const p = prepareDocument(doc([
    { page: 10, section: "5.09 아 웃", text: body(300) },
    { page: 10, section: "5.10 교 대", text: body(310) },
    { page: 10, section: "5.11 지명타자", text: body(320) },
  ]));
  if (p.chunks.length !== 3) throw new Error(`3건이어야 하는데 ${p.chunks.length}건 — 페이지로 뭉개짐`);
  const paths = new Set(p.chunks.map((c) => c.sectionPath));
  if (paths.size !== 3) throw new Error(`section_path 고유 3개여야 하는데 ${paths.size}개`);
  if (![...paths].some((x) => x.includes("5.09"))) throw new Error("조문 번호가 section_path에 없음");
});

t("페이지 단위 입력은 종전 규칙 유지 (회귀 방지)", () => {
  const p = prepareDocument(doc([{ page: 7, text: body(300) }, { page: 8, text: body(300) }], "연감"));
  if (p.chunks.length !== 2) throw new Error(`2건이어야 하는데 ${p.chunks.length}`);
  if (p.chunks[0].sectionPath !== "연감#p7") throw new Error(`페이지 규칙 깨짐: ${p.chunks[0].sectionPath}`);
});

t("긴 조문이 분할돼도 키가 충돌하지 않는다", () => {
  const p = prepareDocument(doc([
    { page: 3, section: "제22조", text: body(2500) },
    { page: 3, section: "제23조", text: body(2500) },
  ], "규약"));
  const keys = new Set(p.chunks.map((c) => `${c.sectionPath}#${c.chunkIndex}`));
  if (keys.size !== p.chunks.length) throw new Error(`키 충돌: ${p.chunks.length}건 중 고유 ${keys.size}`);
  if (p.chunks.length < 4) throw new Error(`분할이 안 됨: ${p.chunks.length}`);
});

t("section 혼용이면 페이지 모드로 fail-safe", () => {
  const p = prepareDocument(doc([
    { page: 1, section: "제1조", text: body(300) },
    { page: 2, text: body(300) },
  ], "혼용"));
  if (!p.chunks.every((c) => /#p\d+$/.test(c.sectionPath))) {
    throw new Error("혼용이면 페이지 규칙이어야 한다");
  }
});

t("RED — section을 흘리면 키 충돌로 예외가 난다 (조용한 덮어쓰기 금지)", () => {
  // 파서가 section을 전달하지 않는 상황을 그대로 재현한다.
  const stripped = [
    { page: 10, text: body(300) },
    { page: 10, text: body(310) },
    { page: 10, text: body(320) },
  ];
  let threw = false;
  try { prepareDocument(doc(stripped)); } catch (e) {
    threw = true;
    if (!/키 충돌/.test(e.message)) throw new Error(`다른 예외: ${e.message}`);
  }
  if (!threw) throw new Error("키가 충돌하는데 예외가 나지 않았다 — 적재하면 조용히 유실된다");
});

t("파서가 section을 실어 보낸다 (소스 계약)", () => {
  // prepareDocument만 고쳐도 파서가 흘리면 사고가 그대로 재현된다.
  // 실제 배포 스크립트의 파서 라인을 직접 확인한다.
  const line = src.split("\n").find((l) => l.includes("doc.pages.push("));
  if (!line) throw new Error("doc.pages.push 라인을 못 찾음 — 구조 변경");
  if (!/section/.test(line)) {
    throw new Error("파서가 section을 전달하지 않는다 — 조문 입력이 페이지로 뭉개진다");
  }
});

t("적재량 검증이 DB 실측이다 (로더 자기 출력 금지)", () => {
  if (!/countActiveChunks\s*\(/.test(src)) throw new Error("countActiveChunks 부재");
  if (!/chunk_count_mismatch/.test(src)) throw new Error("불일치 시 실패 처리 부재");
  if (/READY chunks=\$\{p\.chunks\.length\}/.test(src)) {
    throw new Error("READY 로그가 여전히 로더 생성 수를 찍는다");
  }
});

t("claim 0건 스킵이 종료코드로 드러난다", () => {
  if (!/skippedSources/.test(src)) throw new Error("skippedSources 부재");
  if (!/process\.exitCode\s*=\s*1/.test(src)) throw new Error("부분 실패가 exit 0으로 끝난다");
});

console.log(`\nofficial loader contract: PASS=${pass} FAIL=${fails.length}`);
if (fails.length) { fails.forEach((f) => console.error(" -", f)); process.exit(1); }
