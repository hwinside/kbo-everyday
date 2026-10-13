// Portable PostgreSQL 17 backend for the same disposable SQL fixture as pg17.sh.
// PGlite is an existing pinned dependency; never connects to a remote database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const fixturePath = process.argv[2];
assert.ok(fixturePath, "SQL fixture path is required");
const sql = await readFile(fixturePath, "utf8");
const db = new PGlite();
try {
  const version = await db.query("SHOW server_version_num");
  assert.equal(
    Math.floor(Number(version.rows[0].server_version_num) / 10000),
    17,
    "PostgreSQL 17 required",
  );
  await db.exec(sql);
  console.log("Backend: PGlite PostgreSQL 17 (same SQL fixture)");
} finally {
  await db.close();
}
