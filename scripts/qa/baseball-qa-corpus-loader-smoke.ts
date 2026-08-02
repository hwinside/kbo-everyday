import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type FixtureRecord = {
  doc: string;
  kind: "player" | "team" | "baseball_general" | "kbo_league";
  entity: string;
  depth: number;
  title: string;
  canonical: string;
  len: number;
  text: string;
  fetchedAt: string;
};

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(path.join(root, "src/lib/baseball-qa/namu-core-manifest.json"), "utf8"),
) as { sourceKey: string; entityType: string; entityId: string; canonicalTitle: string }[];
const work = mkdtempSync(path.join(tmpdir(), "rag-corpus-loader-"));

function record(
  kind: FixtureRecord["kind"],
  entity: string,
  title: string,
  text: string,
): FixtureRecord {
  const canonical = `https://namu.wiki/w/${encodeURIComponent(title).replace(/%2F/g, "/")}`;
  return {
    doc: title,
    kind,
    entity,
    depth: 1,
    title: `${title} - 나무위키`,
    canonical,
    len: text.length,
    text,
    fetchedAt: "2026-08-02T00:00:00.000Z",
  };
}

const prose = (title: string) => `${title}\n분류야구\n${"야구에 관한 검증 가능한 서술입니다. ".repeat(6)}`;
const fixtures: FixtureRecord[] = [
  record(
    "player",
    "김도영",
    "김도영",
    `김도영\n분류대한민국의 남자 야구 선수2003년 출생\n${"KIA 타이거즈 소속 내야수에 관한 서술입니다. ".repeat(6)}`,
  ),
  record("baseball_general", "야구", "야구", prose("야구")),
  record("kbo_league", "KBO 리그", "KBO 리그", prose("KBO 리그")),
  ...manifest.filter(({ entityType }) => entityType === "team").map(({ canonicalTitle }) =>
    record("team", canonicalTitle, canonicalTitle, prose(canonicalTitle))),
];

function writeJsonl(name: string, rows: unknown[], tail = ""): string {
  const file = path.join(work, name);
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}${tail}`, "utf8");
  return file;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/baseball-qa/load-corpus-sources.ts", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main(): Promise<void> {
const validFile = writeJsonl("valid.jsonl", fixtures, "\n");
const dry = await run([`--file=${validFile}`]);
assert.equal(dry.code, 0, dry.stderr);
assert.match(dry.stdout, /physical.*13/);
assert.match(dry.stdout, /"player":1/);
assert.match(dry.stdout, /"team":10/);
assert.match(dry.stdout, /"league":2/);
console.log("PASS actual CLI dry-run — 4 kind 전부 source 귀속");

const brokenMiddle = writeJsonl("broken-middle.jsonl", [fixtures[0]], "\n{broken\n" + JSON.stringify(fixtures[1]));
const middle = await run([`--file=${brokenMiddle}`]);
assert.equal(middle.code, 1);
assert.match(middle.stderr, /parseRejected.*1/);

const brokenTail = writeJsonl("broken-tail.jsonl", fixtures, "\n{broken");
const tail = await run([`--file=${brokenTail}`]);
assert.equal(tail.code, 1);
assert.match(tail.stderr, /parseRejected.*1/);

const schemaMissing = { ...fixtures[0] } as Partial<FixtureRecord>;
delete schemaMissing.canonical;
const missing = await run([`--file=${writeJsonl("schema-missing.jsonl", [schemaMissing])}`]);
assert.equal(missing.code, 1);
assert.match(missing.stderr, /canonical_absent/);

const foreignHost = { ...fixtures[0], canonical: "https://example.com/w/김도영" };
const host = await run([`--file=${writeJsonl("foreign-host.jsonl", [foreignHost])}`]);
assert.equal(host.code, 1);
assert.match(host.stderr, /canonical_host_invalid/);
console.log("PASS actual CLI fail-close — middle/tail/schema/host 4종 exit 1");

const staged = new Map<string, number>();
const serving = new Map<string, number>();
const seenSources = new Set<string>();
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  response.setHeader("Content-Type", "application/json");
  if (request.method === "PATCH" && request.url?.startsWith("/rest/v1/genius_rag_sources")) {
    const url = new URL(request.url, "http://127.0.0.1");
    const sourceKey = (url.searchParams.get("source_key") ?? "").replace(/^eq\./, "");
    seenSources.add(sourceKey);
    response.end(JSON.stringify([{ source_key: sourceKey }]));
    return;
  }
  const fn = request.url?.split("/").pop();
  if (fn === "claim_baseball_genius_rag_batch_scoped") {
    const sourceKey = body.p_source_keys[0];
    response.end(JSON.stringify([{
      source_key: sourceKey,
      entity_id: "fixture",
      page_title: "fixture",
      canonical_url: "https://namu.wiki/w/fixture",
      claim_token: "11111111-1111-4111-8111-111111111111",
      claim_generation: 1,
    }]));
    return;
  }
  if (fn === "upsert_baseball_genius_rag_chunk") {
    staged.set(body.p_source_key, (staged.get(body.p_source_key) ?? 0) + 1);
    response.end("null");
    return;
  }
  if (fn === "complete_baseball_genius_rag_source") {
    const actual = staged.get(body.p_source_key) ?? 0;
    const complete = actual === body.p_expected_chunk_count && actual > 0;
    if (complete) serving.set(body.p_source_key, actual);
    response.end(JSON.stringify(complete));
    return;
  }
  if (fn === "fail_baseball_genius_rag_source") {
    response.end("null");
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "unknown mock route" }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  const applied = await run([`--file=${validFile}`, "--apply"], {
    NODE_ENV: "test",
    RAG_CORPUS_LOADER_FAKE_EMBEDDING: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    GEMINI_API_KEY: "fixture-gemini",
  });
  assert.equal(applied.code, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(seenSources.size, 12);
  assert.deepEqual([...seenSources].sort(), [
    "namu:league:kbo",
    "namu:player:52605",
    ...manifest.filter(({ entityType }) => entityType === "team").map(({ sourceKey }) => sourceKey),
  ].sort());
  assert.equal(serving.size, seenSources.size, "complete 전량이 serving 상태여야 한다");
  assert.equal(
    [...serving.values()].reduce((sum, count) => sum + count, 0),
    [...staged.values()].reduce((sum, count) => sum + count, 0),
    "expected-count와 serving chunk 수가 일치해야 한다",
  );
  assert.match(applied.stdout, /APPLY 완료: source 12\/12/);
  console.log("PASS actual E2E — source 12 → chunk stage → expected-count complete → serving 12");
} finally {
  server.close();
}

console.log("\nbaseball QA corpus loader PASS (actual CLI + actual E2E)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
