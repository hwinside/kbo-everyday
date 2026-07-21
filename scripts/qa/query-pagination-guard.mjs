import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = process.cwd();
const POLICY_PATH = path.join(ROOT, "scripts/qa/query-pagination-policy.json");
const BASELINE_PATH = path.join(ROOT, "scripts/qa/query-pagination-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const VERBOSE = process.argv.includes("--verbose") || WRITE_BASELINE;
const SOURCE_DIRS = ["src", "scripts"];
const MIGRATION_DIRS = ["migrations", "supabase/migrations"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);
const SKIP_FILES = new Set(["scripts/qa/query-pagination-guard.mjs"]);

const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
const relationPolicies = new Map();
for (const [growth, values] of [["growing", policy.growingTables], ["bounded", policy.boundedTables]]) {
  const names = Array.isArray(values) ? values : Object.keys(values ?? {});
  for (const name of names) {
    if (relationPolicies.has(name)) throw new Error(`${name} is classified twice in query-pagination-policy.json`);
    const inline = Array.isArray(values) ? {} : values[name];
    relationPolicies.set(name, {
      ...inline,
      uniqueKeySets: policy.uniqueKeySets?.[name] ?? inline?.uniqueKeySets,
      growth,
    });
  }
}
const boundedRpcs = new Set(Object.keys(policy.boundedRpcAllowlist));
const keysetHelpers = new Map(Object.entries(policy.keysetHelpers ?? {}));

async function listFiles(directory, extensions) {
  const absolute = path.join(ROOT, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next"].includes(entry.name)) continue;
      files.push(...await listFiles(relative, extensions));
    } else if (extensions.has(path.extname(entry.name)) && !SKIP_FILES.has(relative)) {
      files.push(relative);
    }
  }
  return files;
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

function fingerprint(item) {
  const raw = [item.kind, item.file, item.subject, normalize(item.chain)].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function issue(kind, file, source, position, subject, chain, detail) {
  const value = { kind, file, line: lineNumber(source, position), subject, chain, detail };
  return { ...value, fingerprint: fingerprint(value) };
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function callChain(node, sourceFile) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (ts.isIdentifier(current)) return { baseName: current.text, baseText: current.text, methods: [], nodes: [] };
  if (ts.isPropertyAccessExpression(current)) {
    return { baseName: null, baseText: current.getText(sourceFile), methods: [], nodes: [] };
  }
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return null;
  const prefix = callChain(current.expression.expression, sourceFile);
  if (!prefix) return null;
  return {
    ...prefix,
    methods: [...prefix.methods, {
      name: current.expression.name.text,
      args: current.arguments.map((argument) => argument.getText(sourceFile)).join(", "),
    }],
    nodes: [...prefix.nodes, current],
  };
}

function chainText(chain) {
  return `${chain.baseText}${chain.methods.map((method) => `.${method.name}(${method.args})`).join("")}`;
}

function outermostChainCall(node) {
  return !(
    ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
    ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent
  );
}

function containingScope(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function helperContext(node) {
  let current = node;
  while (current?.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const call = current.parent;
      if (ts.isCallExpression(call)) {
        const callee = unwrapExpression(call.expression);
        const helperName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const config = helperName ? keysetHelpers.get(helperName) : null;
        const callbackIndex = call.arguments.findIndex((argument) => unwrapExpression(argument) === current);
        if (config?.callbackArgs?.includes(callbackIndex)) return { helperName, callbackIndex, callback: current };
      }
    }
    current = current.parent;
  }
  return null;
}

function uniqueKeySetsFor(table) {
  const configured = relationPolicies.get(table)?.uniqueKeySets;
  return Array.isArray(configured) && configured.length > 0 ? configured : [["id"]];
}

function keysetContract(chain, table, context) {
  if (!context) return false;
  const methodNames = new Set(chain.methods.map((method) => method.name));
  if (!methodNames.has("limit")) return false;
  const equalityKeys = new Set(chain.methods
    .filter((method) => ["eq", "match"].includes(method.name))
    .map((method) => literalFirstArgument(method.args)));
  const orders = chain.methods
    .filter((method) => method.name === "order")
    .map((method) => literalFirstArgument(method.args));
  const cursorMethods = chain.methods.filter((method) => ["gt", "gte", "lt", "lte"].includes(method.name));
  return uniqueKeySetsFor(table).some((keySet) =>
    keySet.every((key) => equalityKeys.has(key) || (
      orders.includes(key) && cursorMethods.some((method) => literalFirstArgument(method.args) === key)
    )) && cursorMethods.length > 0
  );
}

function inspectSelect(file, source, position, chain, context) {
  const from = chain.methods.find((method) => method.name === "from");
  const table = from ? (literalFirstArgument(from.args) ?? "<dynamic>") : null;
  const select = chain.methods.find((method) => method.name === "select");
  if (!table || !select) return [];
  if (chain.methods.some((method) => ["insert", "update", "upsert", "delete"].includes(method.name))) return [];
  if (/\bhead\s*:\s*true\b/.test(select.args)) return [];

  if (table !== "<dynamic>" && !relationPolicies.has(table)) {
    return [issue("unclassified_relation", file, source, position, table, chainText(chain), "classify this relation as growing or bounded before querying it")];
  }

  const annotation = annotationBefore(source, position);
  if (annotation && annotation.reason.length < 12) {
    return [issue("invalid_annotation", file, source, position, table, chainText(chain), "annotation reason must be at least 12 characters")];
  }

  const names = new Set(chain.methods.map((method) => method.name));
  const uniqueKeySets = uniqueKeySetsFor(table);
  const equalityKeys = new Set(chain.methods
    .filter((method) => ["eq", "match"].includes(method.name))
    .map((method) => literalFirstArgument(method.args)));
  const uniqueEquality = uniqueKeySets.some((keySet) => keySet.every((key) => equalityKeys.has(key)));
  const single = names.has("single") || names.has("maybeSingle");
  const limited = names.has("limit");
  const ranged = names.has("range");
  const orders = chain.methods.filter((method) => method.name === "order").map((method) => literalFirstArgument(method.args));
  const stableOrder = uniqueKeySets.some((keySet) => keySet.every((key) => orders.includes(key)));
  const safeKeyset = keysetContract(chain, table, context);
  const growing = relationPolicies.get(table)?.growth === "growing";

  if (annotation?.kind === "full-scan") {
    if (!safeKeyset) {
      return [issue("unsafe_full_scan", file, source, position, table, chainText(chain), "full-scan requires the query inside a trusted helper callback with cursor predicate, full unique order, and limit")];
    }
    return [];
  }

  if (ranged && !stableOrder) {
    return [issue("non_unique_pagination", file, source, position, table, chainText(chain), `range pagination must include a full unique order (${uniqueKeySets.map((keys) => keys.join(" + ")).join(" or ")})`)];
  }
  if (ranged && annotation?.kind !== "bounded-page" && !safeKeyset) {
    return [issue("partial_page_risk", file, source, position, table, chainText(chain), "range pager must declare bounded-page or satisfy the trusted keyset helper contract")];
  }
  if (growing && limited && !single && !uniqueEquality && !annotation && !safeKeyset) {
    return [issue("ambiguous_growing_limit", file, source, position, table, chainText(chain), "growing-table limit requires an explicit bounded annotation or a structurally verified keyset helper")];
  }
  if (single || limited || ranged || uniqueEquality || annotation?.kind === "bounded" || annotation?.kind === "bounded-page") return [];

  return [issue(
    growing ? "unbounded_growing_select" : "unbounded_select",
    file,
    source,
    position,
    table,
    chainText(chain),
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
  return [issue("unbounded_rpc", file, source, position, name, chainText(chain), "RPC row cardinality must be allowlisted or annotated")];
}

function inspectCollectionApi(file, source, position, chain) {
  const names = chain.methods.map((method) => method.name);
  const list = names.includes("list");
  const storageList = chain.baseText.includes("storage") && names[0] === "from" && list;
  const authList = chain.baseText.includes("auth.admin") && names.includes("listUsers");
  if (!storageList && !authList) return [];
  const annotation = annotationBefore(source, position);
  if (annotation && annotation.reason.length >= 12) return [];
  const target = authList ? "auth.admin.listUsers" : "storage.list";
  return [issue("unbounded_collection_api", file, source, position, target, chainText(chain), "collection API requires bounded-page/full-scan annotation")];
}

function inspectChain(file, source, position, chain, context) {
  return [
    ...inspectSelect(file, source, position, chain, context),
    ...inspectRpc(file, source, position, chain),
    ...inspectCollectionApi(file, source, position, chain),
  ];
}

function inspectFile(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const events = new Map();
  const direct = [];

  function addEvent(scope, event) {
    const values = events.get(scope) ?? [];
    values.push(event);
    events.set(scope, values);
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const chain = callChain(node.initializer, sourceFile);
      if (chain?.methods.some((method) => method.name === "from")) {
        addEvent(containingScope(node), { type: "declare", name: node.name.text, chain, node, context: helperContext(node) });
      }
    } else if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const chain = callChain(node.right, sourceFile);
      if (chain?.baseName === node.left.text && chain.methods.length > 0) {
        addEvent(containingScope(node), { type: "extend", name: node.left.text, chain, node });
      }
    } else if (ts.isCallExpression(node) && outermostChainCall(node)) {
      const chain = callChain(node, sourceFile);
      if (chain?.baseName && chain.methods.length > 0 && !chain.methods.some((method) => method.name === "from")) {
        addEvent(containingScope(node), { type: "extend", name: chain.baseName, chain, node });
      }
      if (chain?.methods.some((method) => ["from", "rpc", "listUsers", "list"].includes(method.name))) {
        const declaration = node.parent && ts.isVariableDeclaration(node.parent)
          ? node.parent
          : ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent : null;
        if (!declaration || !ts.isIdentifier(declaration.name)) {
          direct.push({ chain, node, context: helperContext(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const issues = [];
  for (const { chain, node, context } of direct) {
    issues.push(...inspectChain(file, source, node.getStart(sourceFile), chain, context));
  }
  for (const scopeEvents of events.values()) {
    const builders = new Map();
    for (const event of scopeEvents.sort((a, b) => a.node.getStart(sourceFile) - b.node.getStart(sourceFile))) {
      if (event.type === "declare") {
        builders.set(event.name, { chain: event.chain, node: event.node, context: event.context });
      } else {
        const builder = builders.get(event.name);
        if (!builder) continue;
        builder.chain = {
          ...builder.chain,
          methods: [...builder.chain.methods, ...event.chain.methods],
          nodes: [...builder.chain.nodes, ...event.chain.nodes],
        };
      }
    }
    for (const builder of builders.values()) {
      issues.push(...inspectChain(file, source, builder.node.getStart(sourceFile), builder.chain, builder.context));
    }
  }
  return issues;
}

async function migrationRelations() {
  const files = (await Promise.all(MIGRATION_DIRS.map((directory) => listFiles(directory, new Set([".sql"]))))).flat();
  const relations = new Set();
  for (const file of files) {
    const sql = await readFile(path.join(ROOT, file), "utf8");
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:public|private)\s*\.\s*)?["']?([A-Za-z_][\w$]*)["']?/gi)) {
      relations.add(match[1]);
    }
  }
  return [...relations].sort();
}

function baselineCount(sourceBaseline, hash) {
  const value = sourceBaseline.violations[hash];
  return typeof value === "number" ? value : (value?.count ?? 0);
}

function compareBaseline(allIssues, sourceBaseline) {
  const current = {};
  for (const item of allIssues) current[item.fingerprint] = (current[item.fingerprint] ?? 0) + 1;
  const seen = new Map();
  const newIssues = allIssues.filter((item) => {
    const count = (seen.get(item.fingerprint) ?? 0) + 1;
    seen.set(item.fingerprint, count);
    return count > baselineCount(sourceBaseline, item.fingerprint);
  });
  const resolved = Object.entries(sourceBaseline.violations).reduce(
    (total, [hash]) => total + Math.max(0, baselineCount(sourceBaseline, hash) - (current[hash] ?? 0)),
    0,
  );
  return { current, newIssues, resolved };
}

function runSelfTest() {
  const cases = [
    ["unbounded growing select", 'db.from("profiles").select("id");', ["unbounded_growing_select"]],
    ["ambiguous growing limit", 'db.from("profiles").select("id").limit(20);', ["ambiguous_growing_limit"]],
    ["explicit bounded limit", '// query-guard: bounded -- dashboard intentionally shows only the newest rows\ndb.from("profiles").select("id").limit(20);', []],
    ["bounded relation limit", 'db.from("game_event_state").select("game_id").limit(20);', []],
    ["unique lookup", 'db.from("profiles").select("id").eq("id", userId);', []],
    ["non-unique range", 'db.from("posts").select("id").order("created_at").range(0, 99);', ["non_unique_pagination"]],
    ["unreviewed stable range", 'db.from("posts").select("id").order("id").range(0, 99);', ["partial_page_risk"]],
    ["bounded stable page", '// query-guard: bounded-page -- feed returns one stable UI page only\ndb.from("posts").select("id").order("id").range(0, 99);', []],
    ["unknown rpc", 'db.rpc("returns_many_rows");', ["unbounded_rpc"]],
    ["allowlisted rpc", 'db.rpc("increment_post_view");', []],
    ["auth list", 'db.auth.admin.listUsers({ page: 1, perPage: 1000 });', ["unbounded_collection_api"]],
    ["storage list", 'db.storage.from(bucket).list(prefix, { limit: 100 });', ["unbounded_collection_api"]],
    ["helper import only", 'import { fetchAllByKeyset } from "./paginate";\ndb.from("profiles").select("id").limit(1000);', ["ambiguous_growing_limit"]],
    ["helper outside limit", 'fetchAllByKeyset(async (cursor, limit) => db.from("profiles").select("id").order("id").gt("id", cursor).limit(limit));\ndb.from("profiles").select("id").limit(1000);', ["ambiguous_growing_limit"]],
    ["unclassified growing relation", 'db.from("new_growth_table").select("id").limit(1000);', ["unclassified_relation"]],
    ["split builder", 'const q = db.from("profiles");\nq.select("id");', ["unbounded_growing_select"]],
    [
      "verified full scan",
      'fetchAllByKeyset(async (cursor, limit) => {\n// query-guard: full-scan -- unique id keyset rejects every page error\nlet q = db.from("profiles").select("id").order("id").limit(limit);\nif (cursor !== null) q = q.gt("id", cursor);\nreturn q;\n});',
      [],
    ],
  ];
  for (const [name, source, expected] of cases) {
    assert.deepEqual(inspectFile(`fixture/${name}.ts`, source).map((item) => item.kind), expected, name);
  }

  const oldFinding = { kind: "x", file: "x", subject: "x", chain: "x", fingerprint: "old" };
  const original = { violations: { old: { count: 1 } } };
  assert.equal(compareBaseline([], original).resolved, 1, "baseline removal must fail until the baseline shrinks");
  assert.equal(compareBaseline([oldFinding], { violations: {} }).newIssues.length, 1, "reintroduced finding must be new after baseline shrink");
}

runSelfTest();

const files = (await Promise.all(SOURCE_DIRS.map((directory) => listFiles(directory, SOURCE_EXTENSIONS)))).flat().sort();
const issues = [];
for (const file of files) issues.push(...inspectFile(file, await readFile(path.join(ROOT, file), "utf8")));

const unclassifiedMigrations = (await migrationRelations()).filter((name) => !relationPolicies.has(name));
if (unclassifiedMigrations.length > 0) {
  for (const name of unclassifiedMigrations) console.error(`query policy: [unclassified_relation] ${name} — migration table must be classified`);
  console.error("Classify every migration table as growing or bounded before updating the query baseline.");
  process.exit(1);
}

if (WRITE_BASELINE) {
  if (!/^[0-9a-f]{40}$/.test(process.env.QUERY_GUARD_BASE_SHA ?? "")) {
    throw new Error("--write-baseline requires QUERY_GUARD_BASE_SHA=<reviewed 40-char sha>");
  }
  const details = {};
  for (const item of issues) {
    details[item.fingerprint] ??= {
      count: issues.filter((candidate) => candidate.fingerprint === item.fingerprint).length,
      kind: item.kind,
      file: item.file,
      subject: item.subject,
      detail: item.detail,
    };
  }
  const output = {
    version: 2,
    generatedFrom: process.env.QUERY_GUARD_BASE_SHA,
    violations: Object.fromEntries(Object.entries(details).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`query guard baseline written: ${issues.length} audited exceptions`);
  process.exit(0);
}

const { newIssues, resolved } = compareBaseline(issues, baseline);
if (VERBOSE || newIssues.length > 0) {
  for (const item of newIssues) {
    console.error(`${item.file}:${item.line} [${item.kind}] ${item.subject} — ${item.detail}`);
  }
}

const byKind = issues.reduce((result, item) => {
  result[item.kind] = (result[item.kind] ?? 0) + 1;
  return result;
}, {});
console.log(`query pagination guard: ${issues.length} audited, ${resolved} resolved, ${newIssues.length} new`);
if (VERBOSE) console.log(JSON.stringify(byKind, null, 2));
if (newIssues.length > 0 || resolved > 0) {
  if (resolved > 0) console.error("Baseline shrank. Regenerate it at the reviewed base before this change can pass.");
  if (newIssues.length > 0) console.error("New collection query risk detected. Bound it or add a reasoned query-guard annotation.");
  process.exit(1);
}
