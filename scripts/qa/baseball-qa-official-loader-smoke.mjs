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

t("적재량이 complete swap 의 원자 조건이다 (삼순 R4 #1050-2)", () => {
  if (!/p_expected_chunk_count:\s*p\.chunks\.length/.test(src)) {
    throw new Error("complete RPC 에 기대 chunk 수를 넘기지 않는다 — swap 뒤 검증은 이미 늦다");
  }
  const completeIdx = src.indexOf('rpc("complete_baseball_genius_rag_source"');
  const countIdx = src.indexOf("countActiveChunks(url, key");
  if (completeIdx < 0 || countIdx < 0) throw new Error("complete/count 호출을 못 찾음");
});

t("READY source 재적재 경로가 있다 (삼순 R4 #1050-1)", () => {
  if (!/flag\("refresh"\)/.test(src)) throw new Error("--refresh 플래그 부재");
  if (!/request_baseball_genius_rag_refresh/.test(src)) throw new Error("재적재 RPC 호출 부재");
  const refreshIdx = src.indexOf('rpc("request_baseball_genius_rag_refresh"');
  const claimIdx = src.indexOf('rpc("claim_baseball_genius_rag_batch_scoped"');
  if (refreshIdx < 0 || claimIdx < 0) throw new Error("refresh/claim 호출을 못 찾음");
  if (refreshIdx > claimIdx) throw new Error("refresh 가 claim 뒤에 있어 재적재가 성립하지 않는다");
  if (!/p_loader_revision:\s*OFFICIAL_LOADER_REVISION/.test(src)) {
    throw new Error("원문 revision과 별개인 loaderRevision을 refresh RPC에 넘기지 않는다");
  }
});

t("source ensure가 APPLY 경로에서 claim보다 먼저 실행된다", () => {
  if (!/ensure_baseball_genius_ebook_sources/.test(src)) throw new Error("source ensure RPC 호출 부재");
  const ensureIdx = src.indexOf("const sourceRows = await ensureAndVerifySources(url, key, rpc, prepared)");
  const claimIdx = src.indexOf('rpc("claim_baseball_genius_rag_batch_scoped"');
  if (ensureIdx < 0 || ensureIdx > claimIdx) throw new Error("source ensure가 claim 전에 실행되지 않는다");
});

// ── 실제 DB(PGlite)에서 원자성 검증 ─────────────────────────────────────────
// 소스 문자열 검사만으로는 "불일치 시 last-good 이 보존되는가"를 증명할 수 없다.
{
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { readdirSync } = await import("node:fs");
  const db = new PGlite({ extensions: { vector } });
  // migration 이 pgvector 를 `WITH SCHEMA extensions` 로 만든다. 그러면 타입이
  // `extensions.vector` 라 search_path 에 그 스키마가 없으면 `vector` 를 못 찾는다.
  await db.exec("CREATE SCHEMA IF NOT EXISTS extensions;");
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
  await db.exec("SET search_path = public, extensions;");
  const migDir = path.join(HERE, "..", "..", "supabase", "migrations");
  // ⚠️ 사전순 그대로 적용한다. 손으로 순서를 정하면 실제 배포와 달라진다.
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql") && /baseball_genius_rag/.test(x)).sort()) {
    const sql = readFileSync(path.join(migDir, f), "utf8");
    if (!/genius_rag_sources|genius_rag_chunks|complete_baseball_genius_rag/.test(sql)) continue;
    await db.exec(sql);
  }

  const KEY = "kbo:ebook:test-0";
  const vec = () => JSON.stringify(Array.from({ length: 768 }, () => 0.01));
  const sourcePayload = Array.from({ length: 10 }, (_, index) => ({
    source_key: `kbo:ebook:test-${index}`,
    source_kind: "kbo_ebook",
    entity_type: "document",
    entity_id: `doc-${index}`,
    page_title: `규칙 ${index}`,
    candidate_urls: [`https://example.test/${index}`],
    canonical_url: `https://example.test/${index}`,
    resolution_status: "resolved",
    resolution_note: "fixture",
    source_grade: "tier1",
    identity_fingerprint: crypto.createHash("sha256").update(`fixture-${index}`).digest("hex"),
    metadata: { kind: "fixture", loaderRevision: "kbo-ebook-sections-v1" },
  }));
  const ensured = await db.query(
    "SELECT public.ensure_baseball_genius_ebook_sources($1::jsonb) AS n",
    [JSON.stringify(sourcePayload)],
  );
  const ensuredRows = await db.query(
    `SELECT source_key, source_kind, entity_type, entity_id, page_title, canonical_url,
            resolution_status, source_grade, identity_fingerprint, metadata
     FROM public.genius_rag_sources WHERE source_kind='kbo_ebook' ORDER BY source_key`,
  );
  t("source 10건 원자 ensure + 필드 exact", () => {
    if (ensured.rows[0].n !== 10 || ensuredRows.rows.length !== 10) {
      throw new Error(`ensure=${ensured.rows[0].n} rows=${ensuredRows.rows.length}`);
    }
    for (let index = 0; index < 10; index++) {
      const actual = ensuredRows.rows[index];
      const expected = sourcePayload[index];
      for (const field of ["source_key", "source_kind", "entity_type", "entity_id", "page_title", "canonical_url", "resolution_status", "source_grade", "identity_fingerprint"]) {
        if (actual[field] !== expected[field]) throw new Error(`${index}.${field} 불일치`);
      }
      if (actual.metadata.loaderRevision !== "kbo-ebook-sections-v1") throw new Error(`${index}.loaderRevision 불일치`);
    }
  });

  let invalidRejected = false;
  try {
    await db.query(
      "SELECT public.ensure_baseball_genius_ebook_sources($1::jsonb)",
      [JSON.stringify([
        { ...sourcePayload[0], source_key: "kbo:ebook:atomic-valid", entity_id: "atomic-valid" },
        { ...sourcePayload[1], source_key: "namu:player:takeover", entity_id: "atomic-invalid" },
      ])],
    );
  } catch {
    invalidRejected = true;
  }
  const atomicRows = await db.query(
    "SELECT count(*)::int AS n FROM public.genius_rag_sources WHERE entity_id LIKE 'atomic-%'",
  );
  t("source ensure는 혼합 오염 입력 전체를 원자 rollback", () => {
    if (!invalidRejected) throw new Error("비 kbo source_key가 통과했다");
    if (atomicRows.rows[0].n !== 0) throw new Error(`부분 반영 ${atomicRows.rows[0].n}건`);
  });

  // 기존 source ensure 재실행은 active 상태와 완료 loaderRevision을 덮어쓰지 않는다.
  const reensurePayload = sourcePayload.map((row) => ({ ...row, metadata: { ...row.metadata, loaderRevision: "kbo-ebook-sections-v2" } }));
  await db.query("SELECT public.ensure_baseball_genius_ebook_sources($1::jsonb)", [JSON.stringify(reensurePayload)]);
  const preserved = await db.query("SELECT metadata->>'loaderRevision' AS loader_revision FROM public.genius_rag_sources WHERE source_key=$1", [KEY]);
  t("source 재-ensure는 완료 loaderRevision을 선반영하지 않는다", () => {
    if (preserved.rows[0].loader_revision !== "kbo-ebook-sections-v1") throw new Error("refresh 전에 v2로 덮였다");
  });

  // ⚠️ crawled_at 은 **같은 값**을 chunk 와 complete 양쪽에 써야 한다.
  // 각각 now() 를 부르면 값이 달라 complete 의 provenance EXISTS 조건이 깨지고,
  // 구현이 멀쩡한데 "정상 적재가 거부됐다" 로 보인다(내 하니스 결함이었다).
  const CRAWLED_AT = new Date().toISOString();
  const stage = async (n, revision) => {
    const claimed = await db.query(
      "SELECT source_key, claim_token, claim_generation FROM public.claim_baseball_genius_rag_batch_scoped(1, 300, $1)",
      [[KEY]],
    );
    if (claimed.rows.length !== 1) throw new Error(`claim 실패(rows=${claimed.rows.length})`);
    const c = claimed.rows[0];
    for (let i = 0; i < n; i++) {
      await db.query(
        `SELECT public.upsert_baseball_genius_rag_chunk($1,$2,$3,'document','doc-0','규칙 0','https://example.test/0',
           $4,$5,$6,$7,$8,$9,'tier1',$11::timestamptz,current_date,$10::vector,'{}'::jsonb)`,
        [KEY, c.claim_token, c.claim_generation, revision, `sec-${i}`, 0,
         `본문 ${i} `.repeat(20), `dochash-${revision}`, `chunkhash-${revision}-${i}`, vec(), CRAWLED_AT],
      );
    }
    return c;
  };

  // 1차: 정상 적재 → READY (last-good)
  const c1 = await stage(3, "rev1");
  const ok1 = await db.query(
    "SELECT public.complete_baseball_genius_rag_source($1,$2,$3,'rev1','dochash-rev1',$4::timestamptz,now()+interval '30 days',3) AS ok",
    [KEY, c1.claim_token, c1.claim_generation, CRAWLED_AT],
  );
  t("1차 적재 complete 성공", () => {
    if (ok1.rows[0].ok !== true) throw new Error("정상 적재가 거부됐다");
  });

  // 2차: 원문 revision은 같지만 loaderRevision이 바뀌면 1회 stale 전환한다.
  const refresh = await db.query(
    "SELECT public.request_baseball_genius_rag_refresh($1,'rev1','kbo-ebook-sections-v2') AS ok",
    [KEY],
  );
  t("같은 원문 revision + 새 loaderRevision은 refresh", () => {
    if (refresh.rows[0].ok !== true) throw new Error("same-content correction이 stale로 전환되지 않았다");
  });
  const c2 = await stage(3, "rev1");
  const bad = await db.query(
    "SELECT public.complete_baseball_genius_rag_source($1,$2,$3,'rev1','dochash-rev1',$4::timestamptz,now()+interval '30 days',5) AS ok",
    [KEY, c2.claim_token, c2.claim_generation, CRAWLED_AT],
  );
  const after = await db.query(
    "SELECT active_claim_generation, revision FROM public.genius_rag_sources WHERE source_key=$1",
    [KEY],
  );
  const kept = await db.query(
    "SELECT count(*)::int AS n FROM public.genius_rag_chunks WHERE source_key=$1 AND claim_generation=$2",
    [KEY, c1.claim_generation],
  );
  const serving = await db.query(
    "SELECT count(*)::int AS n FROM public.genius_rag_serving_chunks WHERE source_key=$1",
    [KEY],
  );
  t("RED — staged 수 불일치면 swap 0 + last-good 보존", () => {
    if (bad.rows[0].ok !== false) throw new Error("불일치인데 complete 가 성공했다");
    if (Number(after.rows[0].active_claim_generation) !== Number(c1.claim_generation)) {
      throw new Error(`active 가 바뀌었다: ${after.rows[0].active_claim_generation}`);
    }
    if (after.rows[0].revision !== "rev1") throw new Error(`revision 이 바뀌었다: ${after.rows[0].revision}`);
    if (kept.rows[0].n !== 3) throw new Error(`직전 정상본이 삭제됐다(남은 ${kept.rows[0].n}건)`);
    if (serving.rows[0].n !== 3) throw new Error(`서빙 snapshot 이 깨졌다(${serving.rows[0].n}건)`);
  });

  // 3차: 기대 수가 맞으면 정상 swap + 이전 generation 정리
  const good = await db.query(
    "SELECT public.complete_baseball_genius_rag_source($1,$2,$3,'rev1','dochash-rev1',$4::timestamptz,now()+interval '30 days',3) AS ok",
    [KEY, c2.claim_token, c2.claim_generation, CRAWLED_AT],
  );
  const after3 = await db.query(
    "SELECT active_claim_generation, revision FROM public.genius_rag_sources WHERE source_key=$1",
    [KEY],
  );
  const oldGone = await db.query(
    "SELECT count(*)::int AS n FROM public.genius_rag_chunks WHERE source_key=$1 AND claim_generation=$2",
    [KEY, c1.claim_generation],
  );
  t("GREEN — 기대 수 일치면 swap + 이전 generation 정리", () => {
    if (good.rows[0].ok !== true) throw new Error("일치인데 complete 가 거부됐다");
    if (after3.rows[0].revision !== "rev1") throw new Error(`swap 안 됨: ${after3.rows[0].revision}`);
    if (oldGone.rows[0].n !== 0) throw new Error(`이전 generation 이 남았다(${oldGone.rows[0].n}건)`);
  });

  const afterMeta = await db.query("SELECT metadata FROM public.genius_rag_sources WHERE source_key=$1", [KEY]);
  t("complete가 pending loaderRevision을 원자 승격", () => {
    if (afterMeta.rows[0].metadata.loaderRevision !== "kbo-ebook-sections-v2") throw new Error("loaderRevision 승격 안 됨");
    if ("pendingLoaderRevision" in afterMeta.rows[0].metadata) throw new Error("pendingLoaderRevision 잔존");
  });
  const sameRev = await db.query(
    "SELECT public.request_baseball_genius_rag_refresh($1,'rev1','kbo-ebook-sections-v2') AS ok",
    [KEY],
  );
  t("같은 원문+같은 loaderRevision refresh는 false", () => {
    if (sameRev.rows[0].ok !== false) throw new Error("동일 계약인데 stale 로 내렸다");
  });
  await db.close();
}

console.log(`\nofficial loader contract: PASS=${pass} FAIL=${fails.length}`);
if (fails.length) { fails.forEach((f) => console.error(" -", f)); process.exit(1); }
