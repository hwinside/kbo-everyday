/**
 * S2b: resolved 상태인 대상 source를 claim → 수집 → chunk → embed → upsert → complete 한다.
 *
 * 실행: `npm run rag:ingest`  (수동/GitHub Actions. 맥미니 LaunchAgent 금지 — P0)
 *   옵션: `--limit=N`  한 번에 처리할 source 수 (기본 5, 상한 50 — RPC 계약)
 *         `--source=wikipedia|namu`  수집 소스 (기본 wikipedia)
 *
 * 소스 (하린아빠 지시, R3): **위키피디아가 기본, 나무위키는 보조**다.
 *   - wikipedia: 공식 API + 정직한 UA plain fetch. revid가 revision 정본.
 *   - namu: Playwright 실크롤 — 요청마다 실제 Chrome 재기동 + 최소 10초 간격(모듈이 강제).
 *
 * 계약 (spec rev0.7 §12.2):
 *   (a) robots.txt 확인기록 없이는 한 건도 수집하지 않는다 — 시작 전 전역 게이트.
 *   (b) 봇차단은 우회하지 않고 fail RPC로 종료한다. 차단을 만나면 그 배치를 즉시 중단한다.
 *   (c) 원문 전문을 저장하지 않는다 — retrieval snippet + provenance만 저장한다
 *       (보존 상한은 `prepareTier2Chunks`가 강제한다).
 *   (d) canonical은 HTTP 200이 아니라 **최종 URL + rel=canonical + 문서 분류 identity 대조**로 확정한다.
 *       적재 시점에도 다시 대조한다 — resolve 이후 문서가 바뀌면 남의 문서 내용이
 *       이 선수 entity로 귀속될 수 있기 때문이다.
 *
 * claim은 **대상 범위를 DB 경계 안에서 좁히는** scoped RPC를 쓴다. 전역 claim 뒤에 범위 밖을
 * fail로 반납하면 대상 밖 운영 source의 retry 예산이 영구 소진된다(삼순 R1 P0 #3).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { type PlayerDocumentIdentity } from "../../src/lib/baseball-qa/rag/canonical";
import { embedDocument } from "../../src/lib/baseball-qa/rag/embed";
import { assertRobotsAllowed, extractDocumentText } from "../../src/lib/baseball-qa/rag/fetch-namu";
import { fetchWikipediaDocument } from "../../src/lib/baseball-qa/rag/fetch-wikipedia";
import { prepareTier2Chunks, prepareTier2DocumentSet } from "../../src/lib/baseball-qa/rag/ingest";
import { S2B_TARGET_PLAYERS, S2B_TARGET_SOURCE_KEYS } from "../../src/lib/baseball-qa/rag/targets";
import { crawlNamuEntityDocuments } from "./rag/fetch-namu-browser";

interface RagSourceRow {
  source_key: string;
  source_kind: string;
  entity_type: string;
  entity_id: string;
  page_title: string;
  canonical_url: string;
  claim_token: string;
  claim_generation: number;
}

interface RosterPlayer { name: string; kboId: string; birthDate?: string }

const LIMIT = Math.min(
  Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 5) || 5,
  50,
);
const SOURCE = (process.argv.find((arg) => arg.startsWith("--source="))?.split("=")[1] ?? "wikipedia") as
  | "wikipedia"
  | "namu";
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
  let robotsNote = "wikipedia:/w/api.php (공식 API 경로)";
  if (SOURCE === "namu") {
    const robots = await assertRobotsAllowed();
    if (!robots.ok) {
      console.error(`robots.txt 확인 실패(${robots.reason}) — 수집 중단(§12.2 a)`);
      process.exit(1);
    }
    robotsNote = `${robots.allowRule} @ ${robots.checkedAt}`;
    console.log(`robots.txt OK: "${robots.allowRule}" (checked ${robots.checkedAt})`);
  }

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const birthYearByKboId = new Map(roster.map((player) => [player.kboId, player.birthDate?.slice(0, 4) ?? ""]));

  const rpc = async <T>(fn: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${fn} failed: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };

  const scope = S2B_TARGET_SOURCE_KEYS.map((sourceKey) =>
    SOURCE === "namu" ? sourceKey : sourceKey.replace(/^namu:/, "wikipedia:"),
  );
  // 범위는 claim 이전에 DB 경계에서 좁힌다 — 대상 밖 source는 애초에 claim되지 않으므로
  // lease도 ingestion_attempts도 건드리지 않는다(scope skip = retry 예산 0 소비).
  const claimed = await rpc<RagSourceRow[]>("claim_baseball_genius_rag_batch_scoped", {
    p_limit: LIMIT,
    // depth 3 / 문서 30건 상한은 rate 대기만 최대 5분이다. 크롤+임베딩을 포함해 15분 lease.
    p_lease_seconds: 900,
    p_source_keys: scope,
  });
  console.log(`claimed ${claimed.length} source(s) (source=${SOURCE}, scope=${scope.length})`);

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

    const birthYear = birthYearByKboId.get(source.entity_id) ?? "";
    if (!/^\d{4}$/.test(birthYear)) {
      await failWith("identity:roster_birth_year_absent");
      continue;
    }
    const targetName = S2B_TARGET_PLAYERS.find((player) => player.kboId === source.entity_id)?.name
      ?? source.page_title;
    const identity: PlayerDocumentIdentity = { name: targetName, birthYear };

    let prepared: ReturnType<typeof prepareTier2Chunks> | ReturnType<typeof prepareTier2DocumentSet>;
    let snapshotRevision: string;
    let snapshotCrawledAt: string;
    let documentCount = 1;
    let aggregateCleanChars: number | null = null;
    let aggregateRetainedChars: number | null = null;
    let rejectedDocumentCount = 0;
    let documentCanonicalBySectionPath = new Map<string, string>([["본문", source.canonical_url]]);

    if (SOURCE === "namu") {
      const crawled = await crawlNamuEntityDocuments(source.canonical_url, identity);
      if (!crawled.ok) {
        // (b) 봇차단은 우회하지 않는다 — 사유를 남기고, blocked면 배치 전체를 중단한다.
        await failWith(`crawl:${crawled.status}:${crawled.reason}`);
        if (crawled.status === "blocked") {
          console.error("차단 감지 — 남은 source 수집을 중단한다(§12.2 b, 재시도 폭주 금지)");
          break;
        }
        continue;
      }
      const root = crawled.documents[0];
      if (root.canonicalUrl !== source.canonical_url) {
        // 저장된 canonical과 실제 문서 canonical이 다르면 resolution을 다시 받아야 한다.
        await failWith("canonical:stored_canonical_url_drift");
        continue;
      }
      const documents = crawled.documents.map((document) => ({
        entityType: "player" as const,
        entityId: source.entity_id,
        pageTitle: source.page_title,
        canonicalUrl: document.canonicalUrl,
        revision: document.revision,
        sectionPath: document.sectionPath,
        crawledAt: document.crawledAt,
        asOf: document.crawledAt.slice(0, 10),
        rawText: extractDocumentText(document.html),
      }));
      const namuPrepared = prepareTier2DocumentSet(documents);
      prepared = namuPrepared;
      snapshotRevision = root.revision;
      snapshotCrawledAt = root.crawledAt;
      documentCount = crawled.documents.length;
      rejectedDocumentCount = crawled.rejected.length;
      documentCanonicalBySectionPath = new Map(
        crawled.documents.map((document) => [document.sectionPath, document.canonicalUrl]),
      );
      if (namuPrepared.ok) {
        aggregateCleanChars = namuPrepared.cleanChars;
        aggregateRetainedChars = namuPrepared.retainedChars;
      }
    } else {
      const fetched = await fetchWikipediaDocument(source.page_title, identity);
      if (!fetched.ok) {
        await failWith(`${fetched.status}:${fetched.reason}`);
        if (fetched.status === "blocked") {
          console.error("차단 감지 — 남은 source 수집을 중단한다(§12.2 b)");
          break;
        }
        continue;
      }
      if (fetched.canonicalUrl !== source.canonical_url) {
        await failWith("canonical:stored_canonical_url_drift");
        continue;
      }
      snapshotRevision = `revid:${fetched.revisionId}`;
      snapshotCrawledAt = fetched.crawledAt;
      prepared = prepareTier2Chunks({
        entityType: "player",
        entityId: source.entity_id,
        pageTitle: source.page_title,
        canonicalUrl: source.canonical_url,
        revision: snapshotRevision,
        sectionPath: "본문",
        crawledAt: snapshotCrawledAt,
        asOf: snapshotCrawledAt.slice(0, 10),
        rawText: fetched.extract,
      });
    }

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
        p_canonical_url: chunk.meta.canonicalUrl,
        p_revision: chunk.meta.revision,
        p_section_path: chunk.meta.sectionPath,
        p_chunk_index: chunkIndex,
        p_content: chunk.content,
        p_document_content_hash: chunk.documentContentHash,
        p_content_hash: chunk.meta.contentHash,
        p_source_grade: "tier2",
        p_crawled_at: chunk.meta.crawledAt,
        p_as_of: chunk.meta.asOf,
        p_embedding: JSON.stringify(embedded.vector),
        p_metadata: {
          source: SOURCE,
          robotsNote,
          entityDocumentCount: documentCount,
          entityCleanChars: aggregateCleanChars,
          entityRetainedChars: aggregateRetainedChars,
          rejectedDocumentCount,
          sectionPath: chunk.meta.sectionPath,
          documentCanonicalUrl: documentCanonicalBySectionPath.get(chunk.meta.sectionPath)
            ?? source.canonical_url,
        },
      });
      chunkIndex += 1;
    }
    if (embedFailure) {
      await failWith(embedFailure);
      continue;
    }

    const anchorChunk = prepared.chunks.find((chunk) => chunk.meta.revision === snapshotRevision)
      ?? prepared.chunks[0];
    snapshotRevision = anchorChunk.meta.revision;
    snapshotCrawledAt = anchorChunk.meta.crawledAt;
    const staleAfter = new Date(Date.now() + STALE_AFTER_DAYS * 86_400_000).toISOString();
    const completed = await rpc<boolean>("complete_baseball_genius_rag_source", {
      p_source_key: source.source_key,
      p_claim_token: source.claim_token,
      p_claim_generation: source.claim_generation,
      p_revision: snapshotRevision,
      p_content_hash: anchorChunk.documentContentHash,
      p_crawled_at: snapshotCrawledAt,
      p_stale_after: staleAfter,
    });
    console.log(`${source.source_key} ${completed ? "READY" : "COMPLETE_REJECTED"} documents=${documentCount} chunks=${chunkIndex}`);
    if (!completed) await failWith("complete_rejected");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
