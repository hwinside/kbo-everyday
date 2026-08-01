/**
 * S2b: resolved 상태인 대상 source를 claim → 크롤 → chunk → embed → upsert → complete 한다.
 *
 * 실행: `npm run rag:ingest`  (수동/GitHub Actions. 맥미니 LaunchAgent 금지 — P0)
 *   옵션: `--limit=N` 한 번에 처리할 source 수 (기본 5, 상한 50 — RPC 계약)
 *
 * 계약 (spec rev0.7 §12.2):
 *   (a) robots.txt 확인기록 없이는 한 건도 수집하지 않는다 — 시작 전 전역 게이트.
 *   (b) 봇차단은 우회하지 않고 fail RPC로 종료한다.
 *   (c) 원문 전문을 저장하지 않는다 — retrieval에 필요한 snippet + provenance만 저장한다
 *       (보존 상한은 `prepareNamuChunks`가 강제한다).
 *   (d) canonical은 HTTP 200이 아니라 **최종 URL + rel=canonical + 제목/entity 대조**로 확정한다.
 *       적재 시점에도 다시 대조한다 — resolve 이후 문서가 리다이렉트되면 남의 문서 내용이
 *       이 선수 entity로 귀속될 수 있기 때문이다.
 *
 * claim은 **대상 범위를 DB 경계 안에서 좀히는** scoped RPC를 쓴다. 전역 claim 뒤에 범위 밖을
 * fail로 반납하면 대상 밖 운영 source의 retry 예산이 영구 소진된다(삼순 R1 P0 #3).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { expectedPlayerTitles, verifyCanonicalIdentity } from "../../src/lib/baseball-qa/rag/canonical";
import { embedDocument } from "../../src/lib/baseball-qa/rag/embed";
import {
  assertRobotsAllowed,
  extractDocumentText,
  fetchNamuDocument,
  RAG_FETCH_INTERVAL_MS,
} from "../../src/lib/baseball-qa/rag/fetch-namu";
import { prepareNamuChunks } from "../../src/lib/baseball-qa/rag/ingest";
import { S2B_TARGET_SOURCE_KEYS } from "../../src/lib/baseball-qa/rag/targets";

interface RagSourceRow {
  source_key: string;
  entity_type: string;
  entity_id: string;
  page_title: string;
  canonical_url: string;
  claim_token: string;
  claim_generation: number;
}

const LIMIT = Math.min(
  Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 5) || 5,
  50,
);
/** 재수집 주기 — 성공한 source는 이 기간 뒤 stale로 다시 잡힌다. */
const STALE_AFTER_DAYS = 30;

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!env[key]) env[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // CI에서는 환경변수 주입.
  }
  return env;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정");
    process.exit(1);
  }
  if (!env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY 미설정 — 임베딩 없이 chunk를 저장할 수 없다(embedding NOT NULL)");
    process.exit(1);
  }
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;

  // (a) robots 확인기록 게이트 — 실패하면 한 건도 수집하지 않는다.
  const robots = await assertRobotsAllowed();
  if (!robots.ok) {
    console.error(`robots.txt 확인 실패(${robots.reason}) — 수집 중단(§12.2 a)`);
    process.exit(1);
  }
  console.log(`robots.txt OK: "${robots.allowRule}" (checked ${robots.checkedAt})`);

  const rpc = async <T>(fn: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${fn} failed: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };

  // 범위는 claim 이전에 DB 경계에서 좀힌다 — 대상 밖 source는 애초에 claim되지 않으므로
  // lease도 ingestion_attempts도 건드리지 않는다(scope skip = retry 예산 0 소비).
  const claimed = await rpc<RagSourceRow[]>("claim_baseball_genius_rag_batch_scoped", {
    p_limit: LIMIT,
    p_lease_seconds: 300,
    p_source_keys: S2B_TARGET_SOURCE_KEYS,
  });
  console.log(`claimed ${claimed.length} source(s) (scope=${S2B_TARGET_SOURCE_KEYS.length})`);

  for (const source of claimed) {
    const failWith = async (reason: string) => {
      await rpc("fail_baseball_genius_rag_source", {
        p_source_key: source.source_key,
        p_claim_token: source.claim_token,
        p_claim_generation: source.claim_generation,
        p_error: reason,
      });
      console.log(`${source.source_key} FAIL ${reason}`);
    };

    const fetched = await fetchNamuDocument(source.canonical_url);
    await sleep(RAG_FETCH_INTERVAL_MS);
    if (!fetched.ok) {
      // (b) 봇차단은 우회하지 않는다 — 사유를 남기고 종료한다.
      await failWith(`${fetched.status}:${fetched.reason}`);
      continue;
    }

    // (d) 적재 시점 canonical 재대조. HTTP 200이어도 redirect/soft-200으로 남의 문서가 왔으면
    // 그 내용을 이 선수 entity로 저장하지 않는다(entity filter는 이 오염을 막지 못한다).
    const identity = verifyCanonicalIdentity({
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.url,
      html: fetched.html,
      expectedTitles: expectedPlayerTitles(source.page_title),
    });
    if (!identity.ok) {
      await failWith(`canonical:${identity.reason}`);
      continue;
    }
    if (identity.canonicalUrl !== source.canonical_url) {
      // 저장된 canonical과 실제 문서 canonical이 다르면 resolution을 다시 받아야 한다.
      // 임의로 갱신하면 canonical 확정 경로(§12.2 d)를 ingestion이 우회하는 셈이다.
      await failWith("canonical:stored_canonical_url_drift");
      continue;
    }

    const asOf = fetched.crawledAt.slice(0, 10);
    const prepared = prepareNamuChunks({
      entityType: "player",
      entityId: source.entity_id,
      pageTitle: source.page_title,
      canonicalUrl: source.canonical_url,
      revision: fetched.revision,
      sectionPath: "본문",
      crawledAt: fetched.crawledAt,
      asOf,
      rawText: extractDocumentText(fetched.html),
    });
    if (!prepared.ok) {
      await failWith(`prepare:${prepared.reason}`);
      continue;
    }

    let chunkIndex = 0;
    let embedFailure: string | null = null;
    for (const chunk of prepared.chunks) {
      const embedded = await embedDocument(chunk.content, source.page_title);
      if (!embedded.ok) {
        embedFailure = `embed:${embedded.reason}`;
        break;
      }
      await rpc("upsert_baseball_genius_rag_chunk", {
        p_source_key: source.source_key,
        p_claim_token: source.claim_token,
        p_claim_generation: source.claim_generation,
        p_entity_type: "player",
        p_entity_id: source.entity_id,
        p_page_title: source.page_title,
        p_canonical_url: source.canonical_url,
        p_revision: fetched.revision,
        p_section_path: "본문",
        p_chunk_index: chunkIndex,
        p_content: chunk.content,
        p_document_content_hash: chunk.documentContentHash,
        p_content_hash: chunk.meta.contentHash,
        p_source_grade: "tier2",
        p_crawled_at: fetched.crawledAt,
        p_as_of: asOf,
        p_embedding: JSON.stringify(embedded.vector),
        p_metadata: { robotsAllowRule: robots.allowRule, robotsCheckedAt: robots.checkedAt },
      });
      chunkIndex += 1;
    }
    if (embedFailure) {
      await failWith(embedFailure);
      continue;
    }

    const staleAfter = new Date(Date.now() + STALE_AFTER_DAYS * 86_400_000).toISOString();
    const completed = await rpc<boolean>("complete_baseball_genius_rag_source", {
      p_source_key: source.source_key,
      p_claim_token: source.claim_token,
      p_claim_generation: source.claim_generation,
      p_revision: fetched.revision,
      p_content_hash: prepared.chunks[0].documentContentHash,
      p_crawled_at: fetched.crawledAt,
      p_stale_after: staleAfter,
    });
    console.log(`${source.source_key} ${completed ? "READY" : "COMPLETE_REJECTED"} chunks=${chunkIndex}`);
    if (!completed) await failWith("complete_rejected");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
