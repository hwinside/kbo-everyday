import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import {
  buildCorpusSourcePlan,
  corpusContentLength,
  corpusRecordHash,
  parseCorpusJsonl,
} from "../../src/lib/baseball-qa/rag/corpus-loader";

const argValue = (name: string): string | undefined =>
  process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  const corpusFile = argValue("file");
  const recoveryFile = argValue("mac-recovery-file");
  if (!corpusFile || !recoveryFile) {
    throw new Error("--file=<corpus.jsonl> --mac-recovery-file=<recovered.jsonl> are required");
  }

const corpusRaw = readFileSync(corpusFile, "utf8");
const artifactSha256 = createHash("sha256").update(corpusRaw).digest("hex");
const parsed = parseCorpusJsonl(corpusRaw);
const roster = JSON.parse(readFileSync(
  path.join(process.cwd(), "src/lib/constants/players-roster.json"),
  "utf8",
));
const manifest = JSON.parse(readFileSync(
  path.join(process.cwd(), "src/lib/baseball-qa/namu-core-manifest.json"),
  "utf8",
));
const planned = buildCorpusSourcePlan(parsed.records, roster, manifest);

const recoveryRecords = parseCorpusJsonl(readFileSync(recoveryFile, "utf8")).records;
const recoveryHashCounts = new Map<string, number>();
for (const record of recoveryRecords) {
  const hash = corpusRecordHash(record);
  recoveryHashCounts.set(hash, (recoveryHashCounts.get(hash) ?? 0) + 1);
}
const collectors = planned.ledger.map((row) => {
  const remaining = recoveryHashCounts.get(row.recordHash) ?? 0;
  if (remaining < 1) return "a17_self_cdp" as const;
  recoveryHashCounts.set(row.recordHash, remaining - 1);
  return "mac_direct_recovery" as const;
});
assert.equal([...recoveryHashCounts.values()].reduce((sum, count) => sum + count, 0), 0);

const db = new PGlite({ extensions: { vector } });
await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
for (const migration of [
  "20260731_baseball_genius_rag_sources.sql",
  "20260801220000_baseball_genius_rag_wikipedia_source.sql",
  "20260801223000_baseball_genius_rag_multidocument_snapshot.sql",
  "20260802010000_baseball_genius_rag_scoped_claim_wikipedia.sql",
  "20260802020000_baseball_genius_rag_complete_expected_count.sql",
  "20260803030000_baseball_genius_rag_corpus_source_resolution.sql",
  "20260803031000_baseball_genius_rag_corpus_ledger.sql",
]) {
  await db.exec(readFileSync(path.join(process.cwd(), "supabase/migrations", migration), "utf8"));
}

await db.query(
  "INSERT INTO public.genius_rag_corpus_runs(artifact_sha256,expected_rows) VALUES ($1,$2)",
  [artifactSha256, planned.ledger.length],
);
await db.transaction(async (transaction) => {
  for (const [index, row] of planned.ledger.entries()) {
    await transaction.query(
      `INSERT INTO public.genius_rag_corpus_records
       (artifact_sha256,row_index,record_hash,kind,entity,doc,depth,page_title,canonical_url,
        fetched_at,content_length,raw_text,disposition,is_latest_owner_revision,collector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [artifactSha256, row.rowIndex, row.recordHash, row.record.kind, row.record.entity,
       row.record.doc, row.record.depth, row.record.title, row.record.canonical, row.record.fetchedAt,
       corpusContentLength(row.record.text), row.record.text, row.disposition,
       row.isLatestOwnerRevision, collectors[index]],
    );
  }
});
const finalized = await db.query<{ ok: boolean }>(
  "SELECT public.finalize_baseball_genius_rag_corpus_ledger($1) AS ok",
  [artifactSha256],
);
assert.equal(finalized.rows[0]?.ok, true);

const result = await db.query<{
  physical: number;
  latest: number;
  assigned: number;
  quarantined: number;
  a17: number;
  mac: number;
}>(
  `SELECT count(*)::int AS physical,
          count(*) FILTER (WHERE is_latest_owner_revision)::int AS latest,
          count(*) FILTER (WHERE disposition='assigned')::int AS assigned,
          count(*) FILTER (WHERE disposition='quarantined')::int AS quarantined,
          count(*) FILTER (WHERE collector='a17_self_cdp')::int AS a17,
          count(*) FILTER (WHERE collector='mac_direct_recovery')::int AS mac
     FROM public.genius_rag_corpus_records WHERE artifact_sha256=$1`,
  [artifactSha256],
);
assert.deepEqual(result.rows[0], {
  physical: planned.ledger.length,
  latest: planned.ledger.filter((row) => row.isLatestOwnerRevision).length,
  assigned: planned.ledger.filter((row) => row.disposition === "assigned").length,
  quarantined: planned.ledger.filter((row) => row.disposition === "quarantined").length,
  a17: collectors.filter((collector) => collector === "a17_self_cdp").length,
  mac: collectors.filter((collector) => collector === "mac_direct_recovery").length,
});
  console.log(JSON.stringify({ artifactSha256, ...result.rows[0] }));
  await db.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
