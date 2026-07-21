import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const POLICY_PATH = path.join(ROOT, "scripts/qa/query-pagination-policy.json");
const BASELINE_PATH = path.join(ROOT, "scripts/qa/query-pagination-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const VERBOSE = process.argv.includes("--verbose") || WRITE_BASELINE;
const SOURCE_DIRS = ["src", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);
const SKIP_FILES = new Set([
  "scripts/qa/query-pagination-guard.mjs",
]);

const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
const growingTables = new Map(Object.entries(policy.growingTables));
const boundedRpcs = new Set(Object.keys(policy.boundedRpcAllowlist));

async function listSourceFiles(directory) {
  const absolute = path.join(ROOT, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next"].includes(entry.name)) continue;
      files.push(...await listSourceFiles(relative));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILES.has(relative)) {
      files.push(relative);
    }
  }
  return files;
}

function skipWhitespace(source, position) {
  let index = position;
  for (;;) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index === -1) return source.length;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      return end === -1 ? source.length : skipWhitespace(source, end + 2);
    }
    return index;
  }
}

function scanBalancedCall(source, openParen) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function readChain(source, start) {
  const methods = [];
  let position = start;
  let end = start;
  for (;;) {
    position = skipWhitespace(source, position);
    if (source[position] !== ".") break;
    const nameMatch = source.slice(position + 1).match(/^([A-Za-z_$][\w$]*)/);
    if (!nameMatch) break;
    const name = nameMatch[1];
    const openParen = skipWhitespace(source, position + 1 + name.length);
    if (source[openParen] !== "(") break;
    const callEnd = scanBalancedCall(source, openParen);
    methods.push({
      name,
      args: source.slice(openParen + 1, callEnd - 1),
    });
    end = callEnd;
    position = callEnd;
  }
  return { methods, end, text: source.slice(start, end) };
}

function lineNumber(source, position) {
  return source.slice(0, position).split("\n").length;
}

function annotationBefore(source, position) {
  const before = source.slice(Math.max(0, position - 500), position).split("\n").slice(-4).join("\n");
  const marker = [...before.matchAll(/query-guard:\s*(bounded|bounded-page|full-scan)\s*--\s*([^\n*]+)/g)].at(-1);
  if (!marker) return null;
  return { kind: marker[1], reason: marker[2].trim() };
}

function literalFirstArgument(args) {
  return args.match(/^\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
}

function normalize(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function fingerprint(issue) {
  const raw = [issue.kind, issue.file, issue.subject, normalize(issue.chain)].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function issue(kind, file, source, position, subject, chain, detail) {
  const value = { kind, file, line: lineNumber(source, position), subject, chain, detail };
  return { ...value, fingerprint: fingerprint(value) };
}

function hasNearbyKeysetHelper(source, position) {
  return source.slice(Math.max(0, position - 1500), position + 1500).includes("fetchAllByKeyset");
}

function uniqueKeysFor(table) {
  return growingTables.get(table)?.uniqueKeys ?? ["id"];
}

function inspectSelect(file, source, position, chain) {
  const from = chain.methods.find((method) => method.name === "from");
  const table = from ? (literalFirstArgument(from.args) ?? "<dynamic>") : null;
  const select = chain.methods.find((method) => method.name === "select");
  if (!table || !select) return [];
  if (chain.methods.some((method) => ["insert", "update", "upsert", "delete"].includes(method.name))) return [];
  if (/\bhead\s*:\s*true\b/.test(select.args)) return [];

  const annotation = annotationBefore(source, position);
  if (annotation && annotation.reason.length < 12) {
    return [issue("invalid_annotation", file, source, position, table, chain.text, "annotation reason must be at least 12 characters")];
  }

  const names = new Set(chain.methods.map((method) => method.name));
  const uniqueKeys = uniqueKeysFor(table);
  const uniqueEquality = chain.methods.some((method) =>
    ["eq", "match"].includes(method.name) && uniqueKeys.includes(literalFirstArgument(method.args))
  );
  const single = names.has("single") || names.has("maybeSingle");
  const limited = names.has("limit");
  const ranged = names.has("range");
  const orders = chain.methods.filter((method) => method.name === "order").map((method) => literalFirstArgument(method.args));
  const stableOrder = uniqueKeys.some((key) => orders.includes(key));

  if (annotation?.kind === "full-scan") {
    if (!limited || !stableOrder || !hasNearbyKeysetHelper(source, position)) {
      return [issue("unsafe_full_scan", file, source, position, table, chain.text, "full-scan requires fetchAllByKeyset + unique order + limit")];
    }
    return [];
  }

  if (ranged && !stableOrder) {
    return [issue("non_unique_pagination", file, source, position, table, chain.text, `range pagination must include unique order (${uniqueKeys.join(" or ")})`)];
  }
  if (ranged && annotation?.kind !== "bounded-page" && !hasNearbyKeysetHelper(source, position)) {
    return [issue("partial_page_risk", file, source, position, table, chain.text, "range pager must declare bounded-page or use fail-closed keyset helper")];
  }
  if (
    growingTables.has(table) && limited && !single && !uniqueEquality && !annotation &&
    !hasNearbyKeysetHelper(source, position)
  ) {
    return [issue("ambiguous_growing_limit", file, source, position, table, chain.text, "growing-table limit requires an explicit bounded annotation or keyset helper")];
  }
  if (single || limited || ranged || uniqueEquality || annotation?.kind === "bounded" || annotation?.kind === "bounded-page") return [];

  return [issue(
    growingTables.has(table) ? "unbounded_growing_select" : "unbounded_select",
    file,
    source,
    position,
    table,
    chain.text,
    "add a bound, unique-key lookup, or query-guard annotation",
  )];
}

function inspectRpc(file, source, position, chain) {
  const rpc = chain.methods.find((method) => method.name === "rpc");
  if (!rpc) return [];
  const name = literalFirstArgument(rpc.args);
  if (!name || boundedRpcs.has(name)) return [];
  const annotation = annotationBefore(source, position);
  if (annotation?.kind === "bounded" && annotation.reason.length >= 12) return [];
  return [issue("unbounded_rpc", file, source, position, name, chain.text, "RPC row cardinality must be allowlisted or annotated")];
}

function inspectCollectionApi(file, source, position, chain) {
  const list = chain.methods.find((method) => method.name === "list");
  const prefix = source.slice(Math.max(0, position - 120), position);
  const storageList = chain.methods[0]?.name === "from" && prefix.includes(".storage") && list;
  const authList = chain.methods[0]?.name === "listUsers" && /\.auth\.admin\s*$/.test(prefix);
  if (!storageList && !authList) return [];
  const annotation = annotationBefore(source, position);
  if (annotation && annotation.reason.length >= 12) return [];
  const target = authList ? "auth.admin.listUsers" : "storage.list";
  return [issue("unbounded_collection_api", file, source, position, target, chain.text, "collection API requires bounded-page/full-scan annotation")];
}

function inspectFile(file, source) {
  const issues = [];
  const starts = /\.(?:from|rpc|listUsers|list)\s*\(/g;
  for (const match of source.matchAll(starts)) {
    const chain = readChain(source, match.index);
    if (chain.methods.length === 0) continue;
    issues.push(...inspectSelect(file, source, match.index, chain));
    issues.push(...inspectRpc(file, source, match.index, chain));
    issues.push(...inspectCollectionApi(file, source, match.index, chain));
  }
  return issues;
}

function runSelfTest() {
  const cases = [
    ["unbounded growing select", 'db.from("profiles").select("id");', ["unbounded_growing_select"]],
    ["ambiguous growing limit", 'db.from("profiles").select("id").limit(20);', ["ambiguous_growing_limit"]],
    ["explicit bounded limit", '// query-guard: bounded -- dashboard intentionally shows only the newest rows\ndb.from("profiles").select("id").limit(20);', []],
    ["non-growing explicit limit", 'db.from("small_config").select("id").limit(20);', []],
    ["unique lookup", 'db.from("profiles").select("id").eq("id", userId);', []],
    ["non-unique range", 'db.from("posts").select("id").order("created_at").range(0, 99);', ["non_unique_pagination"]],
    ["unreviewed stable range", 'db.from("posts").select("id").order("id").range(0, 99);', ["partial_page_risk"]],
    ["bounded stable page", '// query-guard: bounded-page -- feed returns one stable UI page only\ndb.from("posts").select("id").order("id").range(0, 99);', []],
    ["unknown rpc", 'db.rpc("returns_many_rows");', ["unbounded_rpc"]],
    ["allowlisted rpc", 'db.rpc("increment_post_view");', []],
    ["auth list", 'db.auth.admin.listUsers({ page: 1, perPage: 1000 });', ["unbounded_collection_api"]],
    ["storage list", 'db.storage.from(bucket).list(prefix, { limit: 100 });', ["unbounded_collection_api"]],
    [
      "fail-closed full scan",
      'fetchAllByKeyset(async () => {\n// query-guard: full-scan -- unique id keyset rejects every page error\nreturn db.from("profiles").select("id").order("id").limit(limit);\n});',
      [],
    ],
  ];
  for (const [name, source, expected] of cases) {
    assert.deepEqual(inspectFile(`fixture/${name}.ts`, source).map((item) => item.kind), expected, name);
  }
}

runSelfTest();

const files = (await Promise.all(SOURCE_DIRS.map(listSourceFiles))).flat().sort();
const issues = [];
for (const file of files) {
  issues.push(...inspectFile(file, await readFile(path.join(ROOT, file), "utf8")));
}

const current = {};
for (const item of issues) {
  current[item.fingerprint] = (current[item.fingerprint] ?? 0) + 1;
}

if (WRITE_BASELINE) {
  if (!/^[0-9a-f]{40}$/.test(process.env.QUERY_GUARD_BASE_SHA ?? "")) {
    throw new Error("--write-baseline requires QUERY_GUARD_BASE_SHA=<reviewed 40-char sha>");
  }
  const details = {};
  for (const item of issues) {
    details[item.fingerprint] ??= {
      count: current[item.fingerprint],
      kind: item.kind,
      file: item.file,
      subject: item.subject,
      detail: item.detail,
    };
  }
  const output = {
    version: 1,
    generatedFrom: process.env.QUERY_GUARD_BASE_SHA,
    violations: Object.fromEntries(Object.entries(details).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`query guard baseline written: ${issues.length} audited exceptions`);
  process.exit(0);
}

function baselineCount(hash) {
  const value = baseline.violations[hash];
  return typeof value === "number" ? value : (value?.count ?? 0);
}

const newIssues = issues.filter((item) => current[item.fingerprint] > baselineCount(item.fingerprint));
const seen = new Map();
const uniqueNewIssues = newIssues.filter((item) => {
  const count = (seen.get(item.fingerprint) ?? 0) + 1;
  seen.set(item.fingerprint, count);
  return count > baselineCount(item.fingerprint);
});
const resolved = Object.entries(baseline.violations).reduce(
  (total, [hash]) => total + Math.max(0, baselineCount(hash) - (current[hash] ?? 0)),
  0,
);

if (VERBOSE || uniqueNewIssues.length > 0) {
  for (const item of uniqueNewIssues) {
    console.error(`${item.file}:${item.line} [${item.kind}] ${item.subject} — ${item.detail}`);
  }
}

const byKind = issues.reduce((result, item) => {
  result[item.kind] = (result[item.kind] ?? 0) + 1;
  return result;
}, {});
console.log(`query pagination guard: ${issues.length} audited, ${resolved} resolved, ${uniqueNewIssues.length} new`);
if (VERBOSE) console.log(JSON.stringify(byKind, null, 2));
if (uniqueNewIssues.length > 0) {
  console.error("New collection query risk detected. Bound it or add a reasoned query-guard annotation.");
  process.exit(1);
}
