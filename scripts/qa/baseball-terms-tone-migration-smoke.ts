import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

type TermRow = { term: string; answer: string };

const ROOT = process.cwd();
const before = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-before-tone.json"), "utf8"),
) as TermRow[];
const after = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/qa/fixtures/baseball-terms-formal-tone.json"), "utf8"),
) as TermRow[];
const migration = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/20260814121000_baseball_terms_formal_tone.sql"),
  "utf8",
);

async function setup(rows: TermRow[]): Promise<PGlite> {
  const db = new PGlite();
  await db.exec("CREATE TABLE public.baseball_terms (term text PRIMARY KEY, answer text NOT NULL)");
  for (const row of rows) {
    await db.query("INSERT INTO public.baseball_terms(term, answer) VALUES ($1, $2)", [row.term, row.answer]);
  }
  return db;
}

async function readRows(db: PGlite): Promise<TermRow[]> {
  const result = await db.query<TermRow>("SELECT term, answer FROM public.baseball_terms ORDER BY term");
  return result.rows;
}

async function main() {
  assert.equal(before.length, 136);
  assert.deepEqual(before.map(({ term }) => term), after.map(({ term }) => term));

  const successDb = await setup(before);
  await successDb.exec(migration);
  assert.deepEqual(await readRows(successDb), after, "migration post-state must match 136-row after fixture exactly");
  await successDb.close();

  const drifted = before.map((row, index) => index === 0 ? { ...row, answer: `${row.answer}\n검증되지 않은 중간 편집` } : row);
  const driftDb = await setup(drifted);
  await assert.rejects(
    () => driftDb.exec(migration),
    /CAS expected 136 before rows, found 135/,
    "one-row drift must fail closed before UPDATE",
  );
  assert.deepEqual(await readRows(driftDb), drifted, "CAS failure must leave every answer unchanged");
  await driftDb.close();

  console.log("PASS baseball_terms tone migration: UPDATE 136 + exact post-state + one-row drift atomic fail-close");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
