import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const USER = "00000000-0000-4000-8000-000000001186";
const OTHER = "00000000-0000-4000-8000-000000001187";
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260814154000_baseball_genius_positive_ending_ledger.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8")
  .replace(/^REVOKE[\s\S]*?;\s*$/gmu, "")
  .replace(/^GRANT[\s\S]*?;\s*$/gmu, "");

type Claim = { answer: string; used_signature: boolean };

async function claim(db: PGlite, messageId: number, userId = USER): Promise<Claim> {
  const result = await db.query<Claim>(
    "select * from public.claim_baseball_genius_positive_ending($1, $2::uuid, $3)",
    [messageId, userId, "도움이 됐다니 기쁩니다!"],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function main() {
  const db = new PGlite();
  await db.exec("create table public.dm_messages(id bigint primary key)");
  await db.exec("insert into public.dm_messages(id) select generate_series(1, 8)");
  await db.exec(migration);

  const first = await claim(db, 1);
  assert.equal(first.used_signature, true);
  assert.match(first.answer, /승리를 위하여!$/u);
  assert.deepEqual(await claim(db, 1), first, "same message claim must be idempotent");
  await assert.rejects(() => claim(db, 1, OTHER), /owner mismatch/);

  const cooldown = [];
  for (let messageId = 2; messageId <= 6; messageId += 1) cooldown.push(await claim(db, messageId));
  assert.deepEqual(cooldown.map((row) => row.used_signature), [false, false, false, false, false]);
  assert.equal((await claim(db, 7)).used_signature, true, "signature returns only after five later positive endings");

  const rows = await db.query<{ count: number }>("select count(*)::int as count from public.genius_positive_endings");
  assert.equal(rows.rows[0].count, 7, "idempotent retry must not duplicate the ledger");
  await db.close();
  console.log("PASS genius positive ending DB: idempotency + owner fence + exact five-ending cooldown");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
