/**
 * A17 corpus(JSONL) → Supabase 적재.
 *
 * 실행: `npm run rag:load-corpus -- --file=/path/to/corpus.jsonl [--limit=N]`
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
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  normalizeCorpusTitle,
  verifyCorpusPlayerIdentity,
} from "../../src/lib/baseball-qa/rag/corpus-identity";
import { embedDocument } from "../../src/lib/baseball-qa/rag/embed";
import { prepareTier2DocumentSet } from "../../src/lib/baseball-qa/rag/ingest";

type CorpusRecord = {
  doc: string;
  kind: string;
  entity: string;
  depth: number;
  title: string;
  canonical: string;
  len: number;
  text: string;
  fetchedAt: string;
};

type RosterPlayer = { kboId: string; name: string; birthDate?: string };

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const FILE = argValue("file");
const LIMIT = Number(argValue("limit") ?? "0");
const APPLY = args.includes("--apply");
const CONCURRENCY = Math.max(1, Math.min(12, Number(argValue("concurrency") ?? "6") || 6));
const STALE_AFTER_DAYS = 30;

interface RagSourceRow {
  source_key: string;
  entity_id: string;
  page_title: string;
  canonical_url: string;
  claim_token: string;
  claim_generation: number;
}

/**
 * corpus 읽기 (삼순 NO-GO ②).
 *
 * 손상된 행을 **조용히 무시하면 안 된다.** 크롤 중간에 끊긴 행이 생기면 그 문서는
 * 수집됐는데도 적재에서 사라지고, 아무도 모르는 채 커버리지가 줄어든다.
 *
 * 마지막 행은 크롤이 돌는 중이면 잘려 있을 수 있는 정상 상황이므로 구분해서 보고하고,
 * **중간 행 손상은 실패로 종결**한다(조용한 누락이 가장 나쁜 실패다).
 */
function readCorpus(file: string): { records: CorpusRecord[]; brokenMiddle: number; brokenTail: number } {
  const records: CorpusRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let brokenMiddle = 0;
  let brokenTail = 0;
  let lastNonEmptyIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      lastNonEmptyIndex = index;
      break;
    }
  }
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CorpusRecord);
    } catch {
      if (index === lastNonEmptyIndex) brokenTail += 1;
      else brokenMiddle += 1;
    }
  }
  return { records, brokenMiddle, brokenTail };
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

function latestRecords(records: CorpusRecord[]): CorpusRecord[] {
  const latest = new Map<string, CorpusRecord>();
  for (const record of records) {
    const key = `${record.entity}\u0000${record.canonical}`;
    const previous = latest.get(key);
    if (!previous || previous.fetchedAt < record.fetchedAt) latest.set(key, record);
  }
  return [...latest.values()];
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

async function main(): Promise<void> {
  if (!FILE) throw new Error("--file=<corpus.jsonl> 이 필요하다");

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const byName = new Map<string, RosterPlayer[]>();
  for (const player of roster) {
    const list = byName.get(player.name) ?? [];
    list.push(player);
    byName.set(player.name, list);
  }

  const { records, brokenMiddle, brokenTail } = readCorpus(FILE);
  if (brokenTail > 0) {
    console.log(`주의: 마지막 행이 잘려 있다(${brokenTail}행). 크롤이 돌는 중이면 정상이다.`);
  }
  if (brokenMiddle > 0) {
    // 조용한 누락을 만들지 않는다 — 수집된 문서가 적재에서 사라지는 것이다.
    throw new Error(
      `corpus 중간에 손상된 행이 ${brokenMiddle}건 있다. 적재를 중단한다 — ` +
      `이를 무시하면 수집된 문서가 아무도 모르게 빠진다(corpus 재생성 필요).`,
    );
  }
  const playerRecords = latestRecords(records.filter((record) => record.kind === "player"));
  const rootByEntity = new Map<string, CorpusRecord>();
  for (const record of playerRecords.filter((record) => record.depth === 1)) {
    const previous = rootByEntity.get(record.entity);
    if (!previous || previous.fetchedAt < record.fetchedAt) rootByEntity.set(record.entity, record);
  }
  const roots = [...rootByEntity.values()];
  console.log(
    `corpus ${records.length}행 / 중복제거 ${playerRecords.length}행 / ` +
    `선수 루트 ${roots.length}명`,
  );

  const verdicts = { resolved: 0, ambiguous: 0, rejected: 0, unknown_player: 0 };
  const reasons = new Map<string, number>();
  const accepted: { kboId: string; name: string; record: CorpusRecord; documents: CorpusRecord[] }[] = [];

  for (const record of roots) {
    const candidates = byName.get(record.entity) ?? [];
    if (candidates.length === 0) {
      verdicts.unknown_player += 1;
      continue;
    }
    if (candidates.length > 1) {
      // 로스터 동명이인은 이름만으로 kboId를 특정할 수 없다. 추측하지 않는다.
      verdicts.ambiguous += 1;
      reasons.set("roster_name_ambiguous", (reasons.get("roster_name_ambiguous") ?? 0) + 1);
      continue;
    }
    const player = candidates[0];
    const verdict = verifyCorpusPlayerIdentity({
      text: record.text,
      rosterBirthYear: player.birthDate?.slice(0, 4),
      seedName: record.entity,
      documentTitle: record.title,
    });
    if (verdict.ok) {
      verdicts.resolved += 1;
      accepted.push({
        kboId: player.kboId,
        name: player.name,
        record,
        documents: playerRecords.filter((document) =>
          document.entity === record.entity
          && (document.doc === record.doc || document.doc.startsWith(`${record.doc}/`))),
      });
      continue;
    }
    if (verdict.status === "ambiguous") verdicts.ambiguous += 1;
    else verdicts.rejected += 1;
    reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
  }

  console.log(`판정 요약: ${JSON.stringify(verdicts)}`);
  console.log(`사유 분포: ${JSON.stringify(Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])))}`);

  const selected = LIMIT > 0 ? accepted.slice(0, LIMIT) : accepted;
  console.log(`적재 대상: ${selected.length}/${accepted.length}명${LIMIT > 0 ? ` (--limit=${LIMIT})` : ""}`);
  for (const entry of selected.slice(0, 5)) {
    console.log(`  귀속 확정 ${entry.name}(${entry.kboId}) ← ${entry.record.canonical}`);
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

  let completedSources = 0;
  let completedChunks = 0;
  for (const entry of selected) {
    const pageTitle = normalizeCorpusTitle(entry.record.title);
    const documents = entry.documents.map((document) => ({
      entityType: "player" as const,
      entityId: entry.kboId,
      pageTitle,
      canonicalUrl: document.canonical,
      revision: `crawled:${document.fetchedAt}`,
      sectionPath: document.doc,
      crawledAt: document.fetchedAt,
      asOf: document.fetchedAt.slice(0, 10),
      rawText: document.text,
    }));
    const prepared = prepareTier2DocumentSet(documents, "full");
    if (!prepared.ok) throw new Error(`${entry.name}: prepare:${prepared.reason}`);

    // claim 전에 embedding을 끝낸다. 느린 외부 API가 lease를 소모해 마지막 chunk에서
    // 만료되는 실패를 막고, embedding 실패 시 DB에는 한 줄도 쓰지 않는다.
    const embedded = await mapConcurrent(prepared.chunks, CONCURRENCY, async (chunk) => {
      const result = await embedDocument(chunk.content, pageTitle);
      if (!result.ok) throw new Error(`${entry.name}: embed:${result.reason}`);
      return { chunk, vector: result.vector };
    });

    const sourceKey = `namu:player:${entry.kboId}`;
    const sourceResponse = await fetch(
      `${url}/rest/v1/genius_rag_sources?source_key=eq.${encodeURIComponent(sourceKey)}&select=source_key`,
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          canonical_url: entry.record.canonical,
          resolution_status: "resolved",
          resolution_note: `A17 corpus identity 통과(${entry.record.fetchedAt})`,
        }),
      },
    );
    if (!sourceResponse.ok) {
      throw new Error(`${sourceKey}: source PATCH HTTP ${sourceResponse.status} ${await sourceResponse.text()}`);
    }
    const affected = await sourceResponse.json() as { source_key: string }[];
    if (affected.length !== 1 || affected[0]?.source_key !== sourceKey) {
      throw new Error(`${sourceKey}: source affected ${affected.length}, expected 1`);
    }

    const claimed = await rpc<RagSourceRow[]>("claim_baseball_genius_rag_batch_scoped", {
      p_limit: 1,
      p_lease_seconds: 1800,
      p_source_keys: [sourceKey],
    });
    if (claimed.length !== 1 || claimed[0]?.source_key !== sourceKey) {
      throw new Error(`${sourceKey}: claim ${claimed.length}, expected exact 1`);
    }
    const source = claimed[0];
    try {
      await mapConcurrent(embedded, CONCURRENCY, async ({ chunk, vector }, chunkIndex) => {
        await rpc("upsert_baseball_genius_rag_chunk", {
          p_source_key: sourceKey,
          p_claim_token: source.claim_token,
          p_claim_generation: source.claim_generation,
          p_entity_type: "player",
          p_entity_id: entry.kboId,
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
            collector: "A17 self-CDP",
            entityDocumentCount: documents.length,
            entityCleanChars: prepared.cleanChars,
            entityRetainedChars: prepared.retainedChars,
            documentCanonicalUrl: chunk.meta.canonicalUrl,
          },
        });
      });

      const rootRevision = `crawled:${entry.record.fetchedAt}`;
      const anchor = prepared.chunks.find((chunk) => chunk.meta.revision === rootRevision);
      if (!anchor) throw new Error(`${sourceKey}: root anchor chunk absent`);
      const completed = await rpc<boolean>("complete_baseball_genius_rag_source", {
        p_source_key: sourceKey,
        p_claim_token: source.claim_token,
        p_claim_generation: source.claim_generation,
        p_revision: rootRevision,
        p_content_hash: anchor.documentContentHash,
        p_crawled_at: entry.record.fetchedAt,
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
