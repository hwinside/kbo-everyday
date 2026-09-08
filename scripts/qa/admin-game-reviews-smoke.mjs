// Offline route regression: no network, credentials, production accounts or writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const requireNode = createRequire(import.meta.url);
const fixedNow = Date.parse("2026-09-08T14:00:00Z");
class FixedDate extends Date {
  constructor(value) { super(value === undefined ? fixedNow : value); }
  static now() { return fixedNow; }
}
let authorized = true;
let rows = [];
let dbError = false;
let reads = 0;
const ranges = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.orders = []; this.from = 0; this.size = 1000; }
  select() { return this; }
  neq(key, value) { this.filters.push((r) => r[key] !== value); return this; }
  is(key, value) { this.filters.push((r) => r[key] === value); return this; }
  gte(key, value) { this.filters.push((r) => Date.parse(r[key]) >= Date.parse(value)); return this; }
  lt(key, value) { this.filters.push((r) => Date.parse(r[key]) < Date.parse(value)); return this; }
  lte(key, value) { this.filters.push((r) => Date.parse(r[key]) <= Date.parse(value)); return this; }
  like() { return this; }
  order(key, options) { this.orders.push([key, options.ascending]); return this; }
  range(from, to) { this.from = from; this.size = to - from + 1; if (this.table === "game_reviews") ranges.push([from, to]); return this; }
  limit(size) { this.size = size; return this; }
  then(ok, fail) {
    reads++;
    if (this.table !== "game_reviews") return Promise.resolve({ data: [], error: null }).then(ok, fail);
    if (dbError) return Promise.resolve({ data: null, error: { message: "fixture DB error", code: "XX000" } }).then(ok, fail);
    const data = rows.filter((row) => this.filters.every((f) => f(row))).sort((a, b) => {
      for (const [key, ascending] of this.orders) {
        const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
        if (cmp) return ascending ? cmp : -cmp;
      }
      return 0;
    }).slice(this.from, this.from + this.size);
    return Promise.resolve({ data, error: null }).then(ok, fail);
  }
}
const supabase = { from: (table) => new Query(table), rpc: async () => ({ data: [], error: null }) };
const mocks = {
  "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  "@/lib/supabase/admin": { supabaseAdmin: supabase },
  "@/lib/supabase/error": { supabaseErrorResponse: (error) => Response.json({ error: error.message }, { status: 500 }) },
  "@/lib/admin/pin": { isAdminAuthedRequest: async () => authorized },
};
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  vm.runInNewContext(output, {
    module: loadedModule, exports: loadedModule.exports, Date: FixedDate, Intl, console,
    require(name) {
      if (mocks[name]) return mocks[name];
      if (name.startsWith("@/")) return load(resolve(root, "src", name.slice(2)) + ".ts");
      if (name.startsWith(".")) return load(resolve(dirname(file), name) + ".ts");
      return requireNode(name);
    },
  }, { filename: file });
  modules.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const content = load(resolve(root, "src/app/api/admin/content/route.ts"));
const detail = load(resolve(root, "src/app/api/admin/today-detail/route.ts"));
const request = (path) => ({ nextUrl: new URL(path, "http://local.invalid") });
const fixture = (id, created_at, author_id = "author-0", extra = {}) => ({
  id, created_at, author_id, game_id: "20260908SSHT0", team_id: 1,
  content: "오늘 경기 한 줄", is_hidden: false, deleted_at: null, profiles: { nickname: author_id }, ...extra,
});
const start = fixture(2001, "2026-09-07T15:00:00Z");
const last = fixture(2002, "2026-09-08T14:59:59.999Z", "last-author", { is_hidden: true, content: "👨‍👩‍👧‍👦".repeat(41) });
const excluded = [
  fixture(2003, "2026-09-07T14:59:59.999Z", "yesterday"),
  fixture(2004, "2026-09-08T15:00:00Z", "tomorrow"),
  fixture(2005, "2026-09-08T01:00:00Z", "deleted", { deleted_at: "2026-09-08T02:00:00Z" }),
];
rows = [...Array.from({ length: 1005 }, (_, i) => fixture(i + 1, "2026-09-08T00:00:00Z", `author-${i % 3}`)), start, last, ...excluded];
let body = await (await content.GET(request("/api/admin/content?days=1"))).json();
const today = body.dailyPosts.find((day) => day.date === "2026-09-08");
assert.equal(today.gameReviewCount, 1007, "KST midnight bounds, soft deletes and >1000 rows");
assert.equal(today.gameReviewUserCount, 4, "distinct authors, not number of reviews");
assert.equal(today.comments, 0, "game reviews do not inflate comments");
assert.ok(ranges.some(([from]) => from === 1000), "second page fetched");
body = await (await detail.GET(request("/api/admin/today-detail?type=game_reviews"))).json();
assert.equal(body.items.length, 100, "detail stays bounded to 100");
assert.equal(body.items[0].id, 2002, "latest fractional-second row included");
rows = [start, last, ...excluded];
body = await (await detail.GET(request("/api/admin/today-detail?type=game_reviews"))).json();
assert.deepEqual(body.items.map((r) => r.id), [2002, 2001], "detail uses same KST and delete policy");
assert.ok(body.items[0].title.includes("숨김"), "hidden reviews included and labelled");
assert.ok(body.items[0].title.includes("삼성 vs KIA"), "game label present");
assert.ok(body.items[0].title.includes("팬"), "team snapshot label present");
assert.equal(body.items[0].content, "👨‍👩‍👧‍👦".repeat(40) + "…", "preview preserves grapheme clusters");
assert.equal(body.items[0].link, "/games/20260908SSHT0");
assert.equal(body.items[0].nickname, "last-author");
rows = [];
body = await (await content.GET(request("/api/admin/content?days=1"))).json();
assert.equal(body.dailyPosts.length, 0, "empty day remains empty");
dbError = true;
assert.equal((await content.GET(request("/api/admin/content?days=1"))).status, 500, "count DB error is not a false zero");
assert.equal((await detail.GET(request("/api/admin/today-detail?type=game_reviews"))).status, 500);
authorized = false;
reads = 0;
assert.equal((await content.GET(request("/api/admin/content?days=1"))).status, 401);
assert.equal((await detail.GET(request("/api/admin/today-detail?type=game_reviews"))).status, 401);
assert.equal(reads, 0, "auth guard precedes every DB query");
console.log("admin-game-reviews-smoke: offline route regression PASS");
