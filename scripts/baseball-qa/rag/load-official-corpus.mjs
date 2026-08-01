#!/usr/bin/env node
/**
 * 야잘알봇 RAG 코퍼스 적재기 — JSONL 코퍼스 → 청킹 → batch 임베딩 → Supabase 적재.
 *
 * 실행:
 *   node load-corpus.mjs                          # dry-run (기본). DB·임베딩 API를 호출하지 않는다.
 *   node load-corpus.mjs --emit-sources           # source seed SQL 초안 생성 (파일만, 적용 안 함)
 *   node load-corpus.mjs --apply                  # 실제 적재 (claim → embed → upsert → complete)
 *
 * 옵션:
 *   --corpus=<path>      입력 JSONL (기본 ./kbo-official.jsonl)
 *   --only=<substr>      entity 이름에 substr이 포함된 문서만 처리
 *   --limit-docs=N       처리할 문서(=source) 수 상한
 *   --limit-chunks=N     문서당 chunk 수 상한 (스모크용)
 *   --batch=N            임베딩 배치 크기 (기본 16)
 *   --lease=N            claim lease 초 (기본 900, RPC 상한 1800)
 *   --state=<path>       resume 체크포인트 (기본 ./load-state.json)
 *   --reset-state        체크포인트 무시하고 처음부터
 *
 * ── 계약 메모 (중요) ────────────────────────────────────────────────────────────
 * 1. 이 스크립트는 `supabase/migrations/20260801235000_baseball_genius_rag_kbo_official_ebook.sql`
 *    (source_kind='kbo_ebook', entity_type='document', chunk source_grade tier1 허용,
 *     heartbeat RPC)이 **적용된 뒤에만** --apply가 성립한다. 미적용 DB에서는 claim 단계에서
 *    RPC 부재/CHECK 위반으로 즉시 실패한다 — 조용히 우회하지 않는다.
 * 2. 보존 상한(RETENTION_MAX_RATIO 0.2 / RETENTION_MAX_CHARS 2400)은 **적용하지 않는다**.
 *    그 상한은 나무위키·위키피디아(tier2, 제3자 저작물)의 "원문 전문 미저장" 계약(spec §12.2 c)이다.
 *    KBO 공식 e북은 tier1 1차 출처이고, 규약·규칙·기록은 발췌 20%로는 조문 자체가 잘려
 *    근거로 쓸 수 없다(예: 야구규약 한 조문이 2,400자를 넘는 경우 답이 반쪽이 된다).
 *    대신 청킹 규칙(MAX 900 / MIN 40)은 PR #1044 ingest.ts와 **동일하게** 지킨다.
 *    → 저작권/재배포 판단은 코드가 아니라 사람이 해야 한다. 이 스크립트는 그 판단을 전제로만 동작하며,
 *      전문 저장이 곤란하다는 결론이 나면 `--limit-chunks`나 별도 선별 규칙을 붙여야 한다.
 * 3. canonical_url은 **파일별로 확인되지 않았다**. PDF는 이미 로컬에 있었고 다운로드 URL 기록이 없다.
 *    manifest(`kbo-official-manifest.json`, {"파일명":"https://..."} )가 있으면 그것을 쓰고,
 *    없으면 KBO 간행물 게시판 URL로 대체하며 **metadata.canonicalUrlVerified=false**로 표시한다.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── PR #1044 src/lib/baseball-qa/rag/ingest.ts 규칙 (동일 값) ────────────────
const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 40;

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = flag("apply");
const EMIT_SOURCES = flag("emit-sources");
const CORPUS = path.resolve(HERE, opt("corpus", "kbo-official.jsonl"));
const ONLY = opt("only", null);
const LIMIT_DOCS = Number(opt("limit-docs", "0")) || 0;
const LIMIT_CHUNKS = Number(opt("limit-chunks", "0")) || 0;
const BATCH = Math.max(1, Math.min(Number(opt("batch", "16")) || 16, 100));
const LEASE = Math.max(30, Math.min(Number(opt("lease", "900")) || 900, 1800));
const STATE_PATH = path.resolve(HERE, opt("state", "load-state.json"));
const RESET_STATE = flag("reset-state");

const EBOOK_BOARD_URL = "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx";
const MANIFEST_PATH = path.resolve(HERE, "kbo-official-manifest.json");
const EMBED_MODEL = "gemini-embedding-2";
const EMBED_DIM = 768;
const STALE_AFTER_DAYS = 365; // 공식 e북은 연 단위 개정이다. 30일 재수집은 무의미하다.

const log = (...parts) => console.log(...parts);
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

// ── env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env };
  const candidates = [
    "/Users/harinclaw/Projects/kbo-everyday/.env.local",
    path.resolve(HERE, ".env.local"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!env[key]) env[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

// ── 청킹 (ingest.ts chunkText 이식, 규칙 동일) ────────────────────────────────
function cleanPdfText(raw) {
  return String(raw ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** ingest.ts chunkText와 동일한 분할 규칙 (MAX 900 / MIN 40, 문단 우선 병합). */
function chunkText(clean) {
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
        buffer = paragraph.slice(offset, offset + MAX_CHUNK_CHARS);
        flush();
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks;
}

// ── 코퍼스 로드 ───────────────────────────────────────────────────────────────
function slugify(value) {
  return value
    .normalize("NFC")
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z가-힣\-]/g, "")
    .toLowerCase()
    .slice(0, 60);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    log(`! manifest 파싱 실패 (${String(error)}) — 무시하고 기본 URL 사용`);
    return null;
  }
}

/**
 * JSONL을 "문서(=source)" 단위로 묶는다.
 * KBO e북: entity(=책 제목) 1권 = source 1건, 페이지가 section_path가 된다.
 * 위키류 JSONL도 동일 구조(entity/title/text)를 가지면 그대로 처리된다.
 */
function loadCorpus() {
  if (!fs.existsSync(CORPUS)) {
    console.error(`코퍼스 없음: ${CORPUS}`);
    process.exit(1);
  }
  const manifest = loadManifest();
  const docs = new Map();
  const skips = { empty_text: 0, malformed_line: 0 };
  let lineNo = 0;

  for (const line of fs.readFileSync(CORPUS, "utf8").split("\n")) {
    lineNo += 1;
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skips.malformed_line += 1;
      continue;
    }
    const text = cleanPdfText(row.text);
    if (!text) {
      skips.empty_text += 1;
      continue;
    }
    const entity = String(row.entity ?? row.title ?? row.doc ?? `unknown#${lineNo}`);
    if (ONLY && !entity.includes(ONLY)) continue;

    if (!docs.has(entity)) {
      const file = String(row.file ?? "");
      docs.set(entity, {
        entity,
        title: String(row.title ?? entity),
        kind: String(row.kind ?? "misc"),
        sourceSystem: String(row.source ?? "kbo_official"),
        file,
        pagesTotal: Number(row.pages_total ?? 0),
        crawledAt: String(row.fetchedAt ?? new Date().toISOString()),
        canonicalUrl: (manifest && manifest[file]) || EBOOK_BOARD_URL,
        canonicalUrlVerified: Boolean(manifest && manifest[file]),
        pages: [],
      });
    }
    const doc = docs.get(entity);
    doc.pages.push({ page: Number(row.page ?? doc.pages.length + 1), text });
  }

  let list = [...docs.values()];
  for (const doc of list) doc.pages.sort((a, b) => a.page - b.page);
  list.sort((a, b) => a.entity.localeCompare(b.entity, "ko"));
  if (LIMIT_DOCS) list = list.slice(0, LIMIT_DOCS);
  return { docs: list, skips };
}

/** 문서 1건을 chunk 배열로 만든다. section_path = "<제목>#p<페이지>". */
function prepareDocument(doc) {
  const fullClean = doc.pages.map((p) => p.text).join("\n\n");
  const documentContentHash = sha256(fullClean);
  const revision = `sha256:${documentContentHash.slice(0, 16)}`;
  const asOf = doc.crawledAt.slice(0, 10);

  const chunks = [];
  const skips = { page_too_short: 0, chunk_too_short: 0 };
  for (const page of doc.pages) {
    const pageChunks = chunkText(page.text);
    if (pageChunks.length === 0) {
      skips.page_too_short += 1;
      continue;
    }
    let index = 0;
    for (const content of pageChunks) {
      if (content.length < MIN_CHUNK_CHARS || content.length > MAX_CHUNK_CHARS) {
        skips.chunk_too_short += 1;
        continue;
      }
      chunks.push({
        sectionPath: `${doc.title}#p${page.page}`,
        chunkIndex: index,
        page: page.page,
        content,
        contentHash: sha256(content),
      });
      index += 1;
    }
  }
  if (LIMIT_CHUNKS && chunks.length > LIMIT_CHUNKS) chunks.length = LIMIT_CHUNKS;

  return {
    sourceKey: `kbo:ebook:${slugify(doc.entity)}`,
    entityId: slugify(doc.entity),
    pageTitle: doc.title,
    canonicalUrl: doc.canonicalUrl,
    canonicalUrlVerified: doc.canonicalUrlVerified,
    revision,
    documentContentHash,
    crawledAt: doc.crawledAt,
    asOf,
    cleanChars: fullClean.length,
    chunks,
    skips,
    doc,
  };
}

// ── source seed SQL 초안 ─────────────────────────────────────────────────────
const q = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

function emitSourcesSql(prepared) {
  const rows = prepared.map((p) => {
    const fingerprint = sha256(`kbo_ebook|${p.sourceKey}|${p.pageTitle}|${p.doc.file}`);
    const metadata = JSON.stringify({
      retrievalMode: "vector",
      embeddingAllowed: true,
      kind: p.doc.kind,
      file: p.doc.file,
      pagesTotal: p.doc.pagesTotal,
      pagesWithText: p.doc.pages.length,
      canonicalUrlVerified: p.canonicalUrlVerified,
    });
    return `  (${q(p.sourceKey)}, 'kbo_ebook', 'document', ${q(p.entityId)}, ${q(p.pageTitle)}, ARRAY[${q(p.canonicalUrl)}]::text[], ${q(p.canonicalUrl)}, 'resolved', ${q("KBO 공식 간행물 e북 PDF (로컬 추출). canonical은 간행물 게시판 기준")}, 'tier1', 'not_started', ${q(fingerprint)}, ${q(metadata)}::jsonb)`;
  });

  const sql = `-- 초안: KBO 공식 e북 source 시드. **운영 DB 적용 금지** — 리뷰/머지 게이트 뒤 적용한다.
-- 선행 조건: 20260801235000_baseball_genius_rag_kbo_official_ebook.sql (source_kind='kbo_ebook').
-- 생성기: state/rag-corpus/load-corpus.mjs --emit-sources (생성 시각 ${new Date().toISOString()})
INSERT INTO public.genius_rag_sources AS target (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
  canonical_url, resolution_status, resolution_note, source_grade, ingestion_status,
  identity_fingerprint, metadata
) VALUES
${rows.join(",\n")}
ON CONFLICT (source_key) DO UPDATE SET
  page_title = EXCLUDED.page_title,
  candidate_urls = EXCLUDED.candidate_urls,
  canonical_url = EXCLUDED.canonical_url,
  metadata = EXCLUDED.metadata,
  updated_at = now();
`;
  const out = path.resolve(HERE, "kbo-official-sources.seed.sql");
  fs.writeFileSync(out, sql, "utf8");
  log(`source seed SQL 초안 작성: ${out} (${rows.length} rows) — 적용하지 않았다`);
}

// ── 임베딩 (batch + 지수 백오프) ─────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDocumentInput(text, title) {
  const resolved = title && title.trim() ? title.trim() : "none";
  return `title: ${resolved} | text: ${text}`;
}

async function embedBatch(texts, title, apiKey, attempt = 0) {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: formatDocumentInput(text, title) }] },
      outputDimensionality: EMBED_DIM,
    })),
  };
  let status = 0;
  let detail = "";
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      },
    );
    status = response.status;
    if (response.ok) {
      const json = await response.json();
      const vectors = json?.embeddings?.map((entry) => entry?.values);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`malformed_response n=${vectors?.length}`);
      }
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== EMBED_DIM) {
          throw new Error(`dim_mismatch ${vector?.length}`);
        }
      }
      return vectors;
    }
    detail = (await response.text()).slice(0, 300);
  } catch (error) {
    detail = String(error?.message ?? error);
  }

  const retryable = status === 429 || status >= 500 || status === 0;
  if (!retryable || attempt >= 6) {
    throw new Error(`embed_failed status=${status} attempt=${attempt} ${detail}`);
  }
  const waitMs = Math.min(60_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
  log(`  ! embed retry ${attempt + 1}/6 status=${status} wait=${waitMs}ms ${detail.slice(0, 120)}`);
  await sleep(waitMs);
  return embedBatch(texts, title, apiKey, attempt + 1);
}

// ── Supabase RPC ─────────────────────────────────────────────────────────────
function makeRpc(url, key) {
  return async (fn, body) => {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`${fn} HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

// ── resume 체크포인트 ────────────────────────────────────────────────────────
function loadState() {
  if (RESET_STATE || !fs.existsSync(STATE_PATH)) return { sources: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { sources: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const { docs, skips: corpusSkips } = loadCorpus();
  const prepared = docs.map(prepareDocument);

  const totalChunks = prepared.reduce((sum, p) => sum + p.chunks.length, 0);
  const totalChunkChars = prepared.reduce(
    (sum, p) => sum + p.chunks.reduce((s, c) => s + c.content.length, 0),
    0,
  );
  const totalCleanChars = prepared.reduce((sum, p) => sum + p.cleanChars, 0);
  const skipPageTooShort = prepared.reduce((sum, p) => sum + p.skips.page_too_short, 0);
  const skipChunkTooShort = prepared.reduce((sum, p) => sum + p.skips.chunk_too_short, 0);
  const embedCalls = prepared.reduce((sum, p) => sum + Math.ceil(p.chunks.length / BATCH), 0);

  log("=".repeat(78));
  log(`코퍼스: ${CORPUS}`);
  log(`모드: ${APPLY ? "APPLY (DB 쓰기)" : "DRY-RUN (쓰기 없음)"}  batch=${BATCH}  lease=${LEASE}s`);
  log("=".repeat(78));
  for (const p of prepared) {
    const chars = p.chunks.reduce((s, c) => s + c.content.length, 0);
    log(
      `${p.sourceKey.padEnd(42)} pages=${String(p.doc.pages.length).padStart(5)} ` +
        `clean=${String(p.cleanChars).padStart(9)} chunks=${String(p.chunks.length).padStart(6)} ` +
        `chunkChars=${String(chars).padStart(9)} rev=${p.revision.slice(0, 20)}` +
        `${p.canonicalUrlVerified ? "" : " [canonical 미검증]"}`,
    );
  }
  log("-".repeat(78));
  log(`문서(source) 수 : ${prepared.length}`);
  log(`총 chunk        : ${totalChunks.toLocaleString()}`);
  log(`chunk 총 문자수 : ${totalChunkChars.toLocaleString()} (원문 정리본 ${totalCleanChars.toLocaleString()}자 대비 ${(totalChunkChars / Math.max(1, totalCleanChars) * 100).toFixed(1)}%)`);
  log(`임베딩 호출 수  : ${embedCalls.toLocaleString()} (batch=${BATCH})`);
  log(`예상 임베딩 시간: ${(embedCalls * 1.5 / 60).toFixed(1)}분 ~ ${(embedCalls * 5.5 / 60).toFixed(1)}분 (호출당 1.5s 실측 ~ 5.5s 보수)`);
  log(`스킵 — 코퍼스 빈 텍스트 : ${corpusSkips.empty_text}`);
  log(`스킵 — JSONL 파싱 실패  : ${corpusSkips.malformed_line}`);
  log(`스킵 — 페이지에서 40자 이상 chunk 미생성 : ${skipPageTooShort}`);
  log(`스킵 — chunk 길이 범위 밖(40~900)         : ${skipChunkTooShort}`);
  log("-".repeat(78));

  if (EMIT_SOURCES) emitSourcesSql(prepared);

  if (!APPLY) {
    log("DRY-RUN 종료 — DB·임베딩 API 호출 없음. 실제 적재는 --apply.");
    log(`소요 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = env.GEMINI_API_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정");
  if (!apiKey) throw new Error("GEMINI_API_KEY 미설정 — embedding NOT NULL이라 chunk 저장 불가");
  const rpc = makeRpc(url, key);
  const state = loadState();

  for (const p of prepared) {
    const saved = state.sources[p.sourceKey];
    // 같은 revision + 유효한 claim이 남아 있으면 이어서 진행한다(resume).
    let claim = null;
    if (saved && saved.revision === p.revision && saved.done !== true) {
      claim = { claim_token: saved.claimToken, claim_generation: saved.claimGeneration };
      const alive = await rpc("heartbeat_baseball_genius_rag_lease", {
        p_source_key: p.sourceKey,
        p_claim_token: claim.claim_token,
        p_claim_generation: claim.claim_generation,
        p_lease_seconds: LEASE,
      });
      if (!alive) {
        log(`${p.sourceKey}: 이전 claim 만료 — 재claim`);
        claim = null;
      } else {
        log(`${p.sourceKey}: resume (chunk ${saved.nextIndex}/${p.chunks.length})`);
      }
    }
    if (saved?.done === true && saved.revision === p.revision) {
      log(`${p.sourceKey}: 이미 완료 — 건너뜀`);
      continue;
    }

    let nextIndex = claim ? saved.nextIndex : 0;
    if (!claim) {
      const claimed = await rpc("claim_baseball_genius_rag_batch_scoped", {
        p_limit: 1,
        p_lease_seconds: LEASE,
        p_source_keys: [p.sourceKey],
      });
      if (!Array.isArray(claimed) || claimed.length === 0) {
        log(`${p.sourceKey}: claim 실패 (resolved/attempts/lease 조건 미충족) — 건너뜀`);
        continue;
      }
      claim = claimed[0];
      nextIndex = 0;
    }

    const failWith = async (reason) => {
      try {
        await rpc("fail_baseball_genius_rag_source", {
          p_source_key: p.sourceKey,
          p_claim_token: claim.claim_token,
          p_claim_generation: claim.claim_generation,
          p_error: reason,
        });
      } catch (error) {
        log(`  ! fail RPC 실패: ${String(error).slice(0, 200)}`);
      }
      log(`${p.sourceKey} FAIL ${reason}`);
    };

    state.sources[p.sourceKey] = {
      revision: p.revision,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      nextIndex,
      done: false,
    };
    saveState(state);

    const t0 = Date.now();
    try {
      for (let start = nextIndex; start < p.chunks.length; start += BATCH) {
        const slice = p.chunks.slice(start, start + BATCH);
        const vectors = await embedBatch(slice.map((c) => c.content), p.pageTitle, apiKey);

        for (let i = 0; i < slice.length; i += 1) {
          const chunk = slice[i];
          await rpc("upsert_baseball_genius_rag_chunk", {
            p_source_key: p.sourceKey,
            p_claim_token: claim.claim_token,
            p_claim_generation: claim.claim_generation,
            p_entity_type: "document",
            p_entity_id: p.entityId,
            p_page_title: p.pageTitle,
            p_canonical_url: p.canonicalUrl,
            p_revision: p.revision,
            p_section_path: chunk.sectionPath,
            p_chunk_index: chunk.chunkIndex,
            p_content: chunk.content,
            p_document_content_hash: p.documentContentHash,
            p_content_hash: chunk.contentHash,
            p_source_grade: "tier1",
            p_crawled_at: p.crawledAt,
            p_as_of: p.asOf,
            p_embedding: JSON.stringify(vectors[i]),
            p_metadata: {
              source: p.doc.sourceSystem,
              kind: p.doc.kind,
              file: p.doc.file,
              page: chunk.page,
              pagesTotal: p.doc.pagesTotal,
              canonicalUrlVerified: p.canonicalUrlVerified,
              embeddingModel: EMBED_MODEL,
            },
          });
        }

        const done = Math.min(start + BATCH, p.chunks.length);
        state.sources[p.sourceKey].nextIndex = done;
        saveState(state);

        const elapsed = (Date.now() - t0) / 1000;
        const rate = done - nextIndex > 0 ? (done - nextIndex) / elapsed : 0;
        log(
          `  ${p.sourceKey} ${done}/${p.chunks.length} ` +
            `(${((done / p.chunks.length) * 100).toFixed(1)}%) ${rate.toFixed(1)} chunk/s ` +
            `elapsed=${elapsed.toFixed(0)}s`,
        );

        // lease 연장 — e북은 chunk가 수천 건이라 단일 lease(최대 1800s)로 부족하다.
        const alive = await rpc("heartbeat_baseball_genius_rag_lease", {
          p_source_key: p.sourceKey,
          p_claim_token: claim.claim_token,
          p_claim_generation: claim.claim_generation,
          p_lease_seconds: LEASE,
        });
        if (!alive) throw new Error("lease_lost");
      }
    } catch (error) {
      await failWith(`load:${String(error?.message ?? error).slice(0, 200)}`);
      continue;
    }

    const staleAfter = new Date(Date.now() + STALE_AFTER_DAYS * 86_400_000).toISOString();
    let completed = false;
    try {
      completed = await rpc("complete_baseball_genius_rag_source", {
        p_source_key: p.sourceKey,
        p_claim_token: claim.claim_token,
        p_claim_generation: claim.claim_generation,
        p_revision: p.revision,
        p_content_hash: p.documentContentHash,
        p_crawled_at: p.crawledAt,
        p_stale_after: staleAfter,
      });
    } catch (error) {
      await failWith(`complete:${String(error?.message ?? error).slice(0, 200)}`);
      continue;
    }
    if (!completed) {
      await failWith("complete_rejected");
      continue;
    }
    state.sources[p.sourceKey].done = true;
    saveState(state);
    log(`${p.sourceKey} READY chunks=${p.chunks.length} ${(Date.now() - t0) / 1000}s`);
  }

  log(`전체 소요 ${((Date.now() - started) / 1000 / 60).toFixed(1)}분`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
