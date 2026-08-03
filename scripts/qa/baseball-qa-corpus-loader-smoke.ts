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

const prose = (title: string) => `${title}\n분류야구\n🏠 ${"야구에 관한 검증 가능한 서술입니다. ".repeat(6)}`;
const fixtures: FixtureRecord[] = [
  record(
    "player",
    "김도영",
    "김도영",
    `김도영\n분류대한민국의 남자 야구 선수2003년 출생\n${"KIA 타이거즈 소속 내야수에 관한 서술입니다. ".repeat(6)}`,
  ),
  record(
    "player",
    "레이예스",
    "레예스",
    `레예스\n분류베네수엘라의 야구 선수1994년 출생\n${"롯데 자이언츠 외야수에 관한 서술입니다. ".repeat(6)}`,
  ),
  record(
    "player",
    "올러",
    "아담 올러",
    `아담 올러\n분류미국의 야구 선수1994년 출생\n${"KIA 타이거즈 투수에 관한 서술입니다. ".repeat(6)}`,
  ),
  record("baseball_general", "야구", "야구", prose("야구")),
  record("kbo_league", "KBO 리그", "KBO 리그", prose("KBO 리그")),
  ...manifest.filter(({ entityType }) => entityType === "team").map(({ canonicalTitle }) =>
    record("team", canonicalTitle, canonicalTitle, prose(canonicalTitle))),
];
const redirectedGameCanonical = "https://namu.wiki/w/KIA%20%ED%83%80%EC%9D%B4%EA%B1%B0%EC%A6%88/2018%EB%85%84/6%EC%9B%94/3%EC%9D%BC";
const redirectedGameText = prose("KIA 타이거즈/2018년/6월/3일");
fixtures.push(
  {
    ...record("team", "두산 베어스", "두산 베어스/2018년/6월/3일", redirectedGameText),
    title: "KIA 타이거즈/2018년/6월/3일 - 나무위키",
    canonical: redirectedGameCanonical,
  },
  {
    ...record("team", "KIA 타이거즈", "KIA 타이거즈/2018년/6월/3일", redirectedGameText),
    canonical: redirectedGameCanonical,
  },
);
const historicalText = `${fixtures[0].text} 과거 revision`;
fixtures.push({
  ...fixtures[0],
  len: historicalText.length,
  text: historicalText,
  fetchedAt: "2026-08-01T00:00:00.000Z",
});

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
const macRecoveryFile = writeJsonl(
  "mac-recovery.jsonl",
  fixtures.filter((fixture) => fixture.entity === "레이예스" || fixture.entity === "올러"),
  "\n",
);
const dry = await run([`--file=${validFile}`, `--mac-recovery-file=${macRecoveryFile}`]);
assert.equal(dry.code, 0, dry.stderr);
assert.match(dry.stdout, /physical.*18/);
assert.match(dry.stdout, /"player":3/);
assert.match(dry.stdout, /"team":11/);
assert.match(dry.stdout, /"league":1/);
assert.match(dry.stdout, /owner\+canonical 관계 17, 적재 관계 15, 격리 관계 2/);
console.log("PASS actual CLI dry-run — physical 18 / latest relation 17 / redirect owner 격리");

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
const sourceStates = new Map<string, {
  ingestionStatus: "not_started" | "ingesting" | "ready";
  revision: string | null;
  contentHash: string | null;
  activeClaimGeneration: number;
  sourceKind: string;
  entityType: string;
  entityId: string;
  pageTitle: string;
  candidateUrls: string[];
  canonicalUrl: string;
  sourceGrade: string;
  identityFingerprint: string;
}>();
const claimCounts = new Map<string, number>();
const chunkCollectors = new Map<string, Set<string>>();
const ledgerRecords = new Map<number, Record<string, unknown>>();
let ledgerRun: Record<string, unknown> | null = null;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url?.startsWith("/rest/v1/genius_rag_corpus_runs")) {
    response.end(JSON.stringify(ledgerRun?.status === "ready" ? [ledgerRun] : []));
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/rest/v1/genius_rag_corpus_runs")) {
    const row = (body as Record<string, unknown>[])[0];
    assert.ok(row);
    if (ledgerRun?.artifact_sha256 !== row.artifact_sha256) ledgerRecords.clear();
    ledgerRun = { ...row, status: "loading" };
    response.statusCode = 201;
    response.end("null");
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/rest/v1/genius_rag_corpus_records")) {
    for (const row of body as Record<string, unknown>[]) {
      assert.equal(
        row.content_length,
        Array.from(row.raw_text as string).length,
        "ledger content_length는 PostgreSQL char_length와 같은 Unicode code point 단위여야 한다",
      );
      ledgerRecords.set(row.row_index as number, row);
    }
    response.statusCode = 201;
    response.end("null");
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/rest/v1/genius_rag_sources")) {
    const url = new URL(request.url, "http://127.0.0.1");
    const sourceKey = (url.searchParams.get("source_key") ?? "").replace(/^eq\./, "");
    const state = sourceStates.get(sourceKey);
    response.end(JSON.stringify(state ? [{
      source_key: sourceKey,
      source_kind: state.sourceKind,
      entity_type: state.entityType,
      entity_id: state.entityId,
      page_title: state.pageTitle,
      candidate_urls: state.candidateUrls,
      canonical_url: state.canonicalUrl,
      source_grade: state.sourceGrade,
      identity_fingerprint: state.identityFingerprint,
      ingestion_status: state.ingestionStatus,
      revision: state.revision,
      content_hash: state.contentHash,
      active_claim_generation: state.activeClaimGeneration,
    }] : []));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/rest/v1/genius_rag_chunks")) {
    const url = new URL(request.url, "http://127.0.0.1");
    const sourceKey = (url.searchParams.get("source_key") ?? "").replace(/^eq\./, "");
    const count = serving.get(sourceKey) ?? 0;
    response.statusCode = 200;
    response.setHeader("Content-Range", `0-0/${count}`);
    response.end(count > 0 ? JSON.stringify([{ id: `${sourceKey}:0` }]) : "[]");
    return;
  }
  const fn = request.url?.split("/").pop();
  if (fn === "resolve_baseball_genius_rag_corpus_source") {
    const sourceKey = body.p_source_key as string;
    seenSources.add(sourceKey);
    const previous = sourceStates.get(sourceKey);
    const seededPageTitle = sourceKey === "namu:player:54529"
      ? "레이예스"
      : sourceKey === "namu:player:55633" ? "올러" : body.p_page_title;
    const seededFingerprint = previous?.identityFingerprint ?? `seed:${seededPageTitle}`;
    const state = previous ?? {
      ingestionStatus: "not_started" as const,
      revision: null,
      contentHash: null,
      activeClaimGeneration: 0,
      sourceKind: body.p_source_kind,
      entityType: body.p_entity_type,
      entityId: body.p_entity_id,
      pageTitle: seededPageTitle,
      candidateUrls: body.p_candidate_urls,
      canonicalUrl: body.p_canonical_url,
      sourceGrade: "tier2",
      identityFingerprint: seededFingerprint,
    };
    if (state.identityFingerprint !== body.p_identity_fingerprint) {
      state.ingestionStatus = "not_started";
      state.revision = null;
      state.contentHash = null;
      state.activeClaimGeneration = 0;
      serving.delete(sourceKey);
    }
    state.sourceKind = body.p_source_kind;
    state.entityType = body.p_entity_type;
    state.entityId = body.p_entity_id;
    state.pageTitle = body.p_page_title;
    state.candidateUrls = body.p_candidate_urls;
    state.canonicalUrl = body.p_canonical_url;
    state.identityFingerprint = body.p_identity_fingerprint;
    sourceStates.set(sourceKey, state);
    response.end("true");
    return;
  }
  if (fn === "claim_baseball_genius_rag_batch_scoped") {
    const sourceKey = body.p_source_keys[0];
    const state = sourceStates.get(sourceKey);
    if (!state || state.ingestionStatus === "ready") {
      response.end("[]");
      return;
    }
    state.ingestionStatus = "ingesting";
    state.activeClaimGeneration += 1;
    staged.set(sourceKey, 0);
    claimCounts.set(sourceKey, (claimCounts.get(sourceKey) ?? 0) + 1);
    response.end(JSON.stringify([{
      source_key: sourceKey,
      entity_id: state.entityId,
      page_title: state.pageTitle,
      canonical_url: state.canonicalUrl,
      claim_token: "11111111-1111-4111-8111-111111111111",
      claim_generation: state.activeClaimGeneration,
    }]));
    return;
  }
  if (fn === "upsert_baseball_genius_rag_chunk") {
    const state = sourceStates.get(body.p_source_key);
    assert.ok(state);
    assert.equal(body.p_entity_type, state.entityType);
    assert.equal(body.p_entity_id, state.entityId);
    assert.equal(body.p_page_title, state.pageTitle);
    assert.ok(
      body.p_canonical_url === state.canonicalUrl
      || body.p_canonical_url.startsWith(`${state.canonicalUrl}/`),
      `${body.p_source_key}: canonical owner mismatch`,
    );
    staged.set(body.p_source_key, (staged.get(body.p_source_key) ?? 0) + 1);
    const collectors = chunkCollectors.get(body.p_source_key) ?? new Set<string>();
    collectors.add(body.p_metadata.collector);
    chunkCollectors.set(body.p_source_key, collectors);
    response.end("null");
    return;
  }
  if (fn === "complete_baseball_genius_rag_corpus_source") {
    const actual = staged.get(body.p_source_key) ?? 0;
    const complete = actual === body.p_expected_chunk_count && actual > 0;
    if (complete) {
      serving.set(body.p_source_key, actual);
      const state = sourceStates.get(body.p_source_key);
      assert.ok(state);
      state.ingestionStatus = "ready";
      state.revision = body.p_revision;
      state.contentHash = body.p_content_hash;
    }
    response.end(JSON.stringify(complete));
    return;
  }
  if (fn === "fail_baseball_genius_rag_source") {
    response.end("null");
    return;
  }
  if (fn === "request_baseball_genius_rag_refresh") {
    const state = sourceStates.get(body.p_source_key);
    if (!state || state.ingestionStatus !== "ready") {
      response.end("false");
      return;
    }
    state.ingestionStatus = "not_started";
    response.end("true");
    return;
  }
  if (fn === "finalize_baseball_genius_rag_corpus_ledger") {
    assert.ok(ledgerRun);
    assert.equal(ledgerRecords.size, ledgerRun.expected_rows);
    const rows = [...ledgerRecords.values()];
    ledgerRun = {
      ...ledgerRun,
      assigned_rows: rows.filter((row) => row.disposition === "assigned").length,
      quarantined_rows: rows.filter((row) => row.disposition === "quarantined").length,
      latest_owner_relations: rows.filter((row) => row.is_latest_owner_revision === true).length,
      collector_counts: {
        a17_self_cdp: rows.filter((row) => row.collector === "a17_self_cdp").length,
        mac_direct_recovery: rows.filter((row) => row.collector === "mac_direct_recovery").length,
      },
      status: "ready",
    };
    response.end("true");
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "unknown mock route" }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  const applyEnv = {
    NODE_ENV: "test",
    RAG_CORPUS_LOADER_FAKE_EMBEDDING: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    GEMINI_API_KEY: "fixture-gemini",
  };
  const commonApplyArgs = [`--file=${validFile}`, `--mac-recovery-file=${macRecoveryFile}`];
  const canary = await run([...commonApplyArgs, "--limit=5", "--apply"], applyEnv);
  assert.equal(canary.code, 0, `${canary.stdout}\n${canary.stderr}`);
  assert.match(canary.stdout, /APPLY 완료: source 5\/5/);
  assert.equal([...sourceStates.values()].filter((state) => state.ingestionStatus === "ready").length, 5);

  const applied = await run([...commonApplyArgs, "--apply"], applyEnv);
  assert.equal(applied.code, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(seenSources.size, 14);
  assert.deepEqual([...seenSources].sort(), [
    "namu:league:kbo",
    "namu:player:52605",
    "namu:player:54529",
    "namu:player:55633",
    ...manifest.filter(({ entityType }) => entityType === "team").map(({ sourceKey }) => sourceKey),
  ].sort());
  assert.equal(serving.size, seenSources.size, "complete 전량이 serving 상태여야 한다");
  assert.equal(
    [...serving.values()].reduce((sum, count) => sum + count, 0),
    [...staged.values()].reduce((sum, count) => sum + count, 0),
    "expected-count와 serving chunk 수가 일치해야 한다",
  );
  assert.match(applied.stdout, /APPLY 완료: source 14\/14/);
  assert.match(applied.stdout, /already-loaded/);
  assert.equal([...claimCounts.values()].reduce((sum, count) => sum + count, 0), 14);
  assert.equal(sourceStates.get("namu:player:54529")?.pageTitle, "레예스");
  assert.equal(sourceStates.get("namu:player:55633")?.pageTitle, "아담 올러");
  assert.equal(ledgerRecords.size, fixtures.length);
  const supplementaryRow = [...ledgerRecords.values()].find((row) => (row.raw_text as string).includes("🏠"));
  assert.ok(supplementaryRow, "supplementary fixture ledger row absent");
  assert.equal(supplementaryRow.content_length, Array.from(supplementaryRow.raw_text as string).length);
  assert.notEqual(supplementaryRow.content_length, (supplementaryRow.raw_text as string).length);
  assert.deepEqual(ledgerRun?.collector_counts, { a17_self_cdp: 16, mac_direct_recovery: 2 });
  assert.equal(ledgerRun?.latest_owner_relations, 17);
  assert.equal(
    [...ledgerRecords.values()].filter((row) => row.is_latest_owner_revision === false).length,
    1,
    "same owner+canonical의 과거 revision 물리행도 ledger에 남아야 한다",
  );
  assert.deepEqual([...chunkCollectors.get("namu:player:54529") ?? []], ["mac_direct_recovery"]);
  assert.deepEqual([...chunkCollectors.get("namu:player:55633") ?? []], ["mac_direct_recovery"]);

  const kiaSourceKey = manifest.find(({ canonicalTitle }) => canonicalTitle === "KIA 타이거즈")?.sourceKey;
  assert.ok(kiaSourceKey);
  const priorKiaClaims = claimCounts.get(kiaSourceKey) ?? 0;
  const changedFixtures = fixtures.map((fixture) =>
    fixture.entity === "KIA 타이거즈" && fixture.canonical === redirectedGameCanonical ? {
    ...fixture,
    text: fixture.text.replace("검증 가능한", "확인 가능한"),
    fetchedAt: "2026-08-03T00:00:00.000Z",
  } : fixture);
  const changedFile = writeJsonl("changed-child.jsonl", changedFixtures, "\n");
  const changed = await run([
    `--file=${changedFile}`,
    `--mac-recovery-file=${macRecoveryFile}`,
    "--apply",
  ], applyEnv);
  assert.equal(changed.code, 0, `${changed.stdout}\n${changed.stderr}`);
  assert.equal(claimCounts.get(kiaSourceKey), priorKiaClaims + 1, "동일 root/count의 child 변경은 재claim해야 한다");
  assert.doesNotMatch(changed.stdout, new RegExp(`READY ${kiaSourceKey} already-loaded`));
  console.log("PASS actual E2E — 18 physical/17 latest ledger + row provenance + 동일 root/count child 재적재");
} finally {
  server.close();
}

console.log("\nbaseball QA corpus loader PASS (actual CLI + actual E2E)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
