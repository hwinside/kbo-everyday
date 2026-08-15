/**
 * A17 corpus(JSONL) → Supabase 적재.
 *
 * 실행: `npm run rag:load-corpus -- --file=/path/to/corpus.jsonl \
 *   --mac-recovery-file=/path/to/recovered.jsonl [--limit=N]`
 *
 * 기본은 판정 dry-run이고, `--apply`에서 source resolve → claim → 100% chunk → embed →
 * expected-count complete를 수행한다. 전량 전에는 반드시 `--limit=5 --apply` canary로
 * 실제 쓰기 경계를 먼저 증명한다.
 *
 * ── 왜 별도 경로인가 ──────────────────────────────────────────────────────
 * 기존 `ingest-rag-sources.ts`의 namu 분기는 맥미니 Playwright로 실크롤한다. 그런데 맥미니
 * 홈 IP는 Cloudflare 403이라(2026-08-02 실 Chrome 교차확인: 3건 중 2건 차단) 그 경로가 막혀 있다.
 * 수집은 A17 모바일망에서만 가능하고, 결과물은 폰 로컬 JSONL로만 쌓인다.
 * 이 스크립트는 그 corpus를 **재크롤 없이** 적재하는 seam이다.
 *
 * ── 계약 ─────────────────────────────────────────────────────────────────
 * (1) **신원 게이트 필수** — corpus는 이름 문자열만으로 수집돼 오염이 섞여 있다(실측 13%).
 *     `verifyCorpusPlayerIdentity`를 통과한 문서만 해당 entity에 귀속한다.
 * (2) **판정 불가는 격리** — 버리지 않고 `ambiguous`로 남긴다(수집 자산 보존).
 * (3) **기본 dry-run** — `--apply` 없이는 DB를 쓰지 않는다. 다만 dry-run은 판정만 검증하며
 *     쓰기 경로를 증명하지 못한다(2026-08-02 교훈). 전량 전에 소량 canary를 실제로 태운다.
 * (4) **부분 반영 금지** — 기대 건수와 실제 반영 건수가 다르면 실패로 종결한다.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildCorpusSourcePlan,
  buildCorpusSourceIdentity,
  buildCorpusPreparedSnapshotFingerprint,
  corpusContentLength,
  corpusRecordHash,
  parseCorpusJsonl,
} from "../../src/lib/baseball-qa/rag/corpus-loader";
import { embedDocument } from "../../src/lib/baseball-qa/rag/embed";
import { prepareTier2DocumentSet } from "../../src/lib/baseball-qa/rag/ingest";

type RosterPlayer = { kboId: string; name: string; birthDate?: string };

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const FILE = argValue("file");
const MAC_RECOVERY_FILE = argValue("mac-recovery-file");
/**
 * `--entities=이름,이름` — corpus 중 해당 entity만 재판정·재적재한다.
 * 2026-08-15 0단계 실측: 양의지·장성우·최형우는 신 게이트(census) 통과인데 live 원장에는
 * 구 게이트 격리가 남아 있다. 재크롤 없이 기존 corpus 문서로 그  3명만 늫는 경로.
 */
const ENTITIES = (argValue("entities") ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const LIMIT = Number(argValue("limit") ?? "0");
const APPLY = args.includes("--apply");
const CONCURRENCY = Math.max(1, Math.min(12, Number(argValue("concurrency") ?? "6") || 6));
const STALE_AFTER_DAYS = 30;
const TEST_EMBEDDING = process.env.NODE_ENV === "test"
  && process.env.RAG_CORPUS_LOADER_FAKE_EMBEDDING === "1";

interface RagSourceStateRow {
  source_key: string;
  source_kind: string;
  entity_type: string;
  entity_id: string;
  page_title: string;
  candidate_urls: string[];
  canonical_url: string;
  source_grade: string;
  identity_fingerprint: string;
  ingestion_status: string;
  revision: string | null;
  content_hash: string | null;
  active_claim_generation: number;
}

interface RagClaimRow {
  source_key: string;
  entity_id: string;
  page_title: string;
  canonical_url: string;
  claim_token: string;
  claim_generation: number;
}

function loadEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index] as T, index);
    }
  }));
  return results;
}

async function fetchSourceState(
  url: string,
  headers: Record<string, string>,
  sourceKey: string,
): Promise<RagSourceStateRow> {
  const response = await fetch(
    `${url}/rest/v1/genius_rag_sources?source_key=eq.${encodeURIComponent(sourceKey)}`
      + "&select=source_key,source_kind,entity_type,entity_id,page_title,candidate_urls,canonical_url,"
      + "source_grade,identity_fingerprint,ingestion_status,revision,content_hash,active_claim_generation",
    { headers },
  );
  if (!response.ok) throw new Error(`${sourceKey}: source GET HTTP ${response.status} ${await response.text()}`);
  const rows = await response.json() as RagSourceStateRow[];
  if (rows.length !== 1 || rows[0]?.source_key !== sourceKey) {
    throw new Error(`${sourceKey}: source GET ${rows.length}, expected exact 1`);
  }
  return rows[0];
}

async function countActiveChunks(
  url: string,
  headers: Record<string, string>,
  sourceKey: string,
  claimGeneration: number,
): Promise<number> {
  const response = await fetch(
    `${url}/rest/v1/genius_rag_chunks?select=id`
      + `&source_key=eq.${encodeURIComponent(sourceKey)}`
      + `&claim_generation=eq.${encodeURIComponent(String(claimGeneration))}`,
    { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } },
  );
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`${sourceKey}: chunk count HTTP ${response.status} ${await response.text()}`);
  }
  const total = response.headers.get("content-range")?.split("/")[1];
  if (!/^\d+$/.test(total ?? "")) throw new Error(`${sourceKey}: chunk count invalid total=${total ?? "missing"}`);
  return Number(total);
}

async function main(): Promise<void> {
  if (!FILE) throw new Error("--file=<corpus.jsonl> 이 필요하다");

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/baseball-qa/namu-core-manifest.json"), "utf8"),
  );
  const corpusRaw = readFileSync(FILE, "utf8");
  const artifactSha256 = createHash("sha256").update(corpusRaw).digest("hex");
  const parsed = parseCorpusJsonl(corpusRaw);
  if (!MAC_RECOVERY_FILE) {
    throw new Error("--mac-recovery-file=<recovered.jsonl>이 필요하다(collector provenance fail-close)");
  }
  // ⚠️ --entities는 여기(파싱)가 아니라 **적재 대상 선택 단계**에서 필터한다.
  // 파싱 단계에서 records를 자르면 팀/리그 루트가 사라져 plan 빌드 자체가 깨진다(스모크 실측:
  // `team source root absent`). 전체 corpus로 plan을 세우고, 적재만 좁힌다.
  const planned = buildCorpusSourcePlan(parsed.records, roster, manifest);
  const recoveryRecords = MAC_RECOVERY_FILE
    ? parseCorpusJsonl(readFileSync(MAC_RECOVERY_FILE, "utf8")).records
    : [];
  const recoveryHashCounts = new Map<string, number>();
  for (const record of recoveryRecords) {
    const hash = corpusRecordHash(record);
    recoveryHashCounts.set(hash, (recoveryHashCounts.get(hash) ?? 0) + 1);
  }
  const collectorByLedgerRow = planned.ledger.map((row) => {
    const remaining = recoveryHashCounts.get(row.recordHash) ?? 0;
    if (remaining < 1) return "a17_self_cdp" as const;
    recoveryHashCounts.set(row.recordHash, remaining - 1);
    return "mac_direct_recovery" as const;
  });
  const unmatchedRecovery = [...recoveryHashCounts.values()].reduce((sum, count) => sum + count, 0);
  if (unmatchedRecovery > 0) throw new Error(`Mac recovery rows absent from corpus: ${unmatchedRecovery}`);
  const collectorByRecordHash = new Map<string, "a17_self_cdp" | "mac_direct_recovery">();
  planned.ledger.forEach((row, index) => {
    const collector = collectorByLedgerRow[index];
    const previous = collectorByRecordHash.get(row.recordHash);
    if (previous && previous !== collector) {
      throw new Error(`identical corpus row has ambiguous collectors: ${row.recordHash}`);
    }
    collectorByRecordHash.set(row.recordHash, collector);
  });
  console.log(`입력 대조: ${JSON.stringify(parsed.counts)}`);
  console.log(
    `귀속 계획: source ${planned.plans.length}, owner+canonical 관계 ${planned.deduplicated}, ` +
    `적재 관계 ${planned.assignedDocuments}, 격리 관계 ${planned.quarantinedDocuments}` +
    `(선수 ${planned.quarantinedPlayers}명)`,
  );
  const byType = planned.plans.reduce<Record<string, number>>((counts, plan) => {
    counts[plan.entityType] = (counts[plan.entityType] ?? 0) + plan.documents.length;
    return counts;
  }, {});
  console.log(`kind별 귀속 문서: ${JSON.stringify(byType)}`);
  console.log(
    `artifact ${artifactSha256}, collector A17 ${collectorByLedgerRow.filter((x) => x === "a17_self_cdp").length}`
      + ` / Mac recovery ${collectorByLedgerRow.filter((x) => x === "mac_direct_recovery").length}`,
  );

  // --entities 부분 재적재: plan은 전체 corpus로 세우되 적재 대상만 해당 entity로 좁힌다.
  // 요청 entity가 corpus plan에 없으면 조용히 전체로 넘어가지 않고 즉시 실패한다.
  const entityFiltered = (() => {
    if (ENTITIES.length === 0) return planned.plans;
    const wanted = new Set(ENTITIES);
    const filtered = planned.plans.filter((plan) => wanted.has(plan.root.entity));
    const present = new Set(filtered.map((plan) => plan.root.entity));
    const absent = ENTITIES.filter((name) => !present.has(name));
    if (absent.length > 0) {
      throw new Error(`--entities 중 corpus에 없는 entity: ${absent.join(", ")} (fail-close)`);
    }
    console.log(`--entities 필터: ${ENTITIES.join(", ")} → 적재 대상 ${filtered.length}/${planned.plans.length} source`);
    return filtered;
  })();
  const selected = LIMIT > 0 ? entityFiltered.slice(0, LIMIT) : entityFiltered;
  console.log(`적재 대상: ${selected.length}/${planned.plans.length} source${LIMIT > 0 ? ` (--limit=${LIMIT})` : ""}`);
  for (const entry of selected.slice(0, 5)) {
    console.log(`  귀속 확정 ${entry.sourceKey} ← ${entry.root.canonical}`);
  }
  if (!APPLY) {
    console.log("\n[dry-run] DB를 쓰지 않았다. 전량 전 `--limit=5 --apply` canary가 필수다.");
    return;
  }
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !env.GEMINI_API_KEY) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY 미설정");
  }
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const rpc = async <T>(fn: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${fn}: HTTP ${response.status} ${await response.text()}`);
    return await response.json() as T;
  };

  if (ENTITIES.length > 0) {
    // 부분 재적재(P0, 2026-08-15 삼순): 필터된 planned.ledger는 전체 artifact의 부분집합이다.
    // corpus_runs/corpus_records는 **쓰지 않는다**(원장 훼손 방지). 단, 임의 corpus 파일이
    // 이 경로로 재적재되는 것을 막기 위해 해당 artifact SHA의 run이 `ready`임을
    // **읽기 전용으로** exact 확인한다(삼순 2차 계약). 미등록/미완료 artifact는 fail-close.
    const readResponse = await fetch(
      `${url}/rest/v1/genius_rag_corpus_runs?artifact_sha256=eq.${artifactSha256}&select=status,expected_rows`,
      { headers },
    );
    if (!readResponse.ok) throw new Error(`corpus run 읽기 실패: HTTP ${readResponse.status}`);
    const runs = await readResponse.json() as Array<{ status?: string; expected_rows?: number }>;
    if (runs.length !== 1 || runs[0]?.status !== "ready" || runs[0]?.expected_rows !== planned.ledger.length) {
      throw new Error(
        `--entities 부분 재적재는 ledger에 ready로 등록된 artifact만 허용한다 — `
        + `현재 ${artifactSha256.slice(0, 12)}…: ${runs.length === 0 ? "corpus_runs 미등록" : `status=${runs[0]?.status} expected_rows=${runs[0]?.expected_rows}(기대 ${planned.ledger.length})`} (fail-close)`,
      );
    }
    console.log(`LEDGER SKIP — 부분 재적재(--entities ${ENTITIES.length}명). artifact ready 확인(읽기 전용), corpus_runs/원장 쓰기 0.`);
  } else if (LIMIT === 0) {
    const existingResponse = await fetch(
      `${url}/rest/v1/genius_rag_corpus_runs?artifact_sha256=eq.${artifactSha256}`
        + "&select=expected_rows,assigned_rows,quarantined_rows,latest_owner_relations,collector_counts,status",
      { headers },
    );
    if (!existingResponse.ok) throw new Error(`corpus ledger GET HTTP ${existingResponse.status}`);
    const existing = await existingResponse.json() as Array<Record<string, unknown>>;
    const assignedPhysical = planned.ledger.filter((row) => row.disposition === "assigned").length;
    const quarantinedPhysical = planned.ledger.length - assignedPhysical;
    const latestRelations = planned.ledger.filter((row) => row.isLatestOwnerRevision).length;
    const collectorCounts = {
      a17_self_cdp: collectorByLedgerRow.filter((value) => value === "a17_self_cdp").length,
      mac_direct_recovery: collectorByLedgerRow.filter((value) => value === "mac_direct_recovery").length,
    };
    const ledgerReady = existing.length === 1
      && existing[0]?.status === "ready"
      && existing[0]?.expected_rows === planned.ledger.length
      && existing[0]?.assigned_rows === assignedPhysical
      && existing[0]?.quarantined_rows === quarantinedPhysical
      && existing[0]?.latest_owner_relations === latestRelations
      && JSON.stringify(existing[0]?.collector_counts) === JSON.stringify(collectorCounts);
    if (!ledgerReady) {
      const runResponse = await fetch(`${url}/rest/v1/genius_rag_corpus_runs?on_conflict=artifact_sha256`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          artifact_sha256: artifactSha256,
          expected_rows: planned.ledger.length,
          assigned_rows: null,
          quarantined_rows: null,
          latest_owner_relations: null,
          collector_counts: {},
          status: "loading",
          completed_at: null,
        }]),
      });
      if (!runResponse.ok) throw new Error(`corpus run upsert HTTP ${runResponse.status} ${await runResponse.text()}`);
      for (let offset = 0; offset < planned.ledger.length; offset += 10) {
        const rows = planned.ledger.slice(offset, offset + 10).map((row, relativeIndex) => ({
          artifact_sha256: artifactSha256,
          row_index: row.rowIndex,
          record_hash: row.recordHash,
          kind: row.record.kind,
          entity: row.record.entity,
          doc: row.record.doc,
          depth: row.record.depth,
          page_title: row.record.title,
          canonical_url: row.record.canonical,
          fetched_at: row.record.fetchedAt,
          content_length: corpusContentLength(row.record.text),
          raw_text: row.record.text,
          disposition: row.disposition,
          is_latest_owner_revision: row.isLatestOwnerRevision,
          collector: collectorByLedgerRow[offset + relativeIndex],
        }));
        const recordResponse = await fetch(
          `${url}/rest/v1/genius_rag_corpus_records?on_conflict=artifact_sha256,row_index`,
          {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(rows),
          },
        );
        if (!recordResponse.ok) {
          throw new Error(`corpus ledger rows ${offset}: HTTP ${recordResponse.status} ${await recordResponse.text()}`);
        }
      }
      const finalized = await rpc<boolean>("finalize_baseball_genius_rag_corpus_ledger", {
        p_artifact_sha256: artifactSha256,
      });
      if (!finalized) throw new Error("corpus ledger finalize rejected");
      console.log(`LEDGER READY physical=${planned.ledger.length} assigned=${assignedPhysical} quarantined=${quarantinedPhysical}`);
    } else {
      console.log(`LEDGER READY already-loaded physical=${planned.ledger.length}`);
    }
  } else {
    console.log(`LEDGER HOLD canary --limit=${LIMIT}; full run에서 physical ${planned.ledger.length}행을 기록한다.`);
  }

  let completedSources = 0;
  let completedChunks = 0;
  for (const entry of selected) {
    const pageTitle = entry.pageTitle;
    const documents = entry.documents.map((document) => ({
      entityType: entry.entityType,
      entityId: entry.entityId,
      pageTitle,
      canonicalUrl: document.canonical,
      revision: `crawled:${document.fetchedAt}`,
      sectionPath: document.doc,
      crawledAt: document.fetchedAt,
      asOf: document.fetchedAt.slice(0, 10),
      rawText: document.text,
    }));
    const prepared = prepareTier2DocumentSet(documents, "full");
    if (!prepared.ok) throw new Error(`${entry.sourceKey}: prepare:${prepared.reason}`);
    const collectorByDocument = new Map(entry.documents.map((document) => [
      `${document.canonical}\u0000crawled:${document.fetchedAt}`,
      collectorByRecordHash.get(corpusRecordHash(document)),
    ]));
    const preparedChunks = prepared.chunks.map((chunk) => {
      const collector = collectorByDocument.get(`${chunk.meta.canonicalUrl}\u0000${chunk.meta.revision}`);
      if (!collector) throw new Error(`${entry.sourceKey}: chunk collector provenance absent`);
      return { chunk, collector };
    });
    const snapshotFingerprint = buildCorpusPreparedSnapshotFingerprint(preparedChunks.map(({ chunk, collector }) => ({
      canonicalUrl: chunk.meta.canonicalUrl,
      revision: chunk.meta.revision,
      sectionPath: chunk.meta.sectionPath,
      contentHash: chunk.meta.contentHash,
      documentContentHash: chunk.documentContentHash,
      collector,
    })));

    const sourceKey = entry.sourceKey;
    const identity = buildCorpusSourceIdentity(entry);
    const resolved = await rpc<boolean>("resolve_baseball_genius_rag_corpus_source", {
      p_source_key: identity.sourceKey,
      p_source_kind: identity.sourceKind,
      p_entity_type: identity.entityType,
      p_entity_id: identity.entityId,
      p_page_title: identity.pageTitle,
      p_candidate_urls: identity.candidateUrls,
      p_canonical_url: identity.canonicalUrl,
      p_resolution_note: `A17 corpus schema/identity 통과(${entry.root.fetchedAt})`,
      p_identity_fingerprint: identity.identityFingerprint,
    });
    if (!resolved) throw new Error(`${sourceKey}: source resolve rejected`);

    const rootRevision = `crawled:${entry.root.fetchedAt}`;
    const dbSource = await fetchSourceState(url, headers, sourceKey);
    const sourceIdentityMatches = dbSource.source_kind === identity.sourceKind
      && dbSource.entity_type === identity.entityType
      && dbSource.entity_id === identity.entityId
      && dbSource.page_title === identity.pageTitle
      && JSON.stringify(dbSource.candidate_urls) === JSON.stringify(identity.candidateUrls)
      && dbSource.canonical_url === identity.canonicalUrl
      && dbSource.source_grade === "tier2"
      && dbSource.identity_fingerprint === identity.identityFingerprint;
    if (!sourceIdentityMatches) throw new Error(`${sourceKey}: resolved source identity mismatch`);
    if (
      dbSource.ingestion_status === "ready"
      && dbSource.revision === rootRevision
      && dbSource.content_hash === snapshotFingerprint
    ) {
      const activeCount = await countActiveChunks(
        url,
        headers,
        sourceKey,
        dbSource.active_claim_generation,
      );
      if (activeCount !== prepared.chunks.length) {
        throw new Error(`${sourceKey}: ready chunk count expected=${prepared.chunks.length} actual=${activeCount}`);
      }
      completedSources += 1;
      completedChunks += activeCount;
      console.log(`READY ${sourceKey} already-loaded chunks=${activeCount} (DB 실측)`);
      continue;
    }

    if (dbSource.ingestion_status === "ready") {
      const marked = await rpc<boolean>("request_baseball_genius_rag_refresh", {
        p_source_key: sourceKey,
        p_revision: rootRevision,
        p_loader_revision: `corpus-snapshot:${snapshotFingerprint}`,
      });
      if (!marked) throw new Error(`${sourceKey}: snapshot refresh rejected`);
    }

    // claim 전에 embedding을 끝낸다. 느린 외부 API가 lease를 소모해 마지막 chunk에서
    // 만료되는 실패를 막고, embedding 실패 시 DB에는 한 줄도 쓰지 않는다.
    const embedded = await mapConcurrent(preparedChunks, CONCURRENCY, async ({ chunk, collector }) => {
      const result = await embedDocument(
        chunk.content,
        pageTitle,
        TEST_EMBEDDING
          ? async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.01) } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
          : undefined,
      );
      if (!result.ok) throw new Error(`${entry.sourceKey}: embed:${result.reason}`);
      return { chunk, collector, vector: result.vector };
    });

    const claimed = await rpc<RagClaimRow[]>("claim_baseball_genius_rag_batch_scoped", {
      p_limit: 1,
      p_lease_seconds: 1800,
      p_source_keys: [sourceKey],
    });
    if (claimed.length !== 1 || claimed[0]?.source_key !== sourceKey) {
      throw new Error(`${sourceKey}: claim ${claimed.length}, expected exact 1`);
    }
    const source = claimed[0];
    try {
      await mapConcurrent(embedded, CONCURRENCY, async ({ chunk, collector, vector }, chunkIndex) => {
        await rpc("upsert_baseball_genius_rag_chunk", {
          p_source_key: sourceKey,
          p_claim_token: source.claim_token,
          p_claim_generation: source.claim_generation,
          p_entity_type: entry.entityType,
          p_entity_id: entry.entityId,
          p_page_title: pageTitle,
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
          p_embedding: JSON.stringify(vector),
          p_metadata: {
            source: "namu",
            collector,
            entityDocumentCount: documents.length,
            entityCleanChars: prepared.cleanChars,
            entityRetainedChars: prepared.retainedChars,
            documentCanonicalUrl: chunk.meta.canonicalUrl,
          },
        });
      });

      const anchor = prepared.chunks.find((chunk) => chunk.meta.revision === rootRevision);
      if (!anchor) throw new Error(`${sourceKey}: root anchor chunk absent`);
      const completed = await rpc<boolean>("complete_baseball_genius_rag_corpus_source", {
        p_source_key: sourceKey,
        p_claim_token: source.claim_token,
        p_claim_generation: source.claim_generation,
        p_revision: rootRevision,
        p_content_hash: snapshotFingerprint,
        p_crawled_at: entry.root.fetchedAt,
        p_stale_after: new Date(Date.now() + STALE_AFTER_DAYS * 86_400_000).toISOString(),
        p_expected_chunk_count: embedded.length,
      });
      if (!completed) throw new Error(`${sourceKey}: complete rejected`);
    } catch (error) {
      await rpc("fail_baseball_genius_rag_source", {
        p_source_key: sourceKey,
        p_claim_token: source.claim_token,
        p_claim_generation: source.claim_generation,
        p_error: error instanceof Error ? error.message.slice(0, 500) : "unknown corpus ingest failure",
      });
      throw error;
    }
    completedSources += 1;
    completedChunks += embedded.length;
    console.log(`READY ${sourceKey} documents=${documents.length} chunks=${embedded.length}`);
  }
  console.log(`\nAPPLY 완료: source ${completedSources}/${selected.length}, chunk ${completedChunks}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
