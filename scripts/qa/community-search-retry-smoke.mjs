#!/usr/bin/env node
/** Actual all-posts page + useUnifiedFeed, mounted in React/jsdom with a deferred RPC boundary.
 * No DB or credentials. PhotoFeed/overlays are presentation stubs; search UI and paging are real.
 * This component regression is not a substitute for the live two-account/scroll/IME UI gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = process.cwd();
const scratch = mkdtempSync(join(root, ".community-search-retry-"));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/community/all-posts?q=직관" });
const observers = new Set();
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  },
});
window.scrollTo = () => {};
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const calls = [];
globalThis.__searchQA = {
  rpc(name, args) {
    assert.equal(name, "search_posts");
    return { select: () => new Promise((resolveRequest) => calls.push({ args, resolveRequest })) };
  },
  from(table) {
    assert.ok(table === "posts" || table === "likes", `unexpected table: ${table}`);
    const args = { before_id: null };
    const query = {
      select() { return query; }, neq() { return query; },
      eq() { return query; },
      in() { return table === "likes" ? Promise.resolve({ data: [] }) : query; },
      lt(column, value) { assert.equal(column, "id"); args.before_id = value; return query; },
      order() { return query; },
      limit(pageSize) {
        args.page_size = pageSize;
        return new Promise((resolveRequest) => calls.push({ args, resolveRequest }));
      },
    };
    return query;
  },
};

// Hold zero-delay tasks explicitly. The regression controls when the *next task* begins;
// it does not infer browser listener order from jsdom's dispatchEvent implementation.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const initTasks = new Map();
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 0) return realSetTimeout(callback, delay, ...args);
  const id = {};
  initTasks.set(id, () => callback(...args));
  return id;
};
globalThis.clearTimeout = (id) => {
  if (!initTasks.delete(id)) realClearTimeout(id);
};

const stubs = {
  "next/navigation": 'export const useSearchParams=()=>new URLSearchParams(window.location.search); export const useRouter=()=>({push(){}});',
  "./client": 'export const supabase={rpc:(...args)=>globalThis.__searchQA.rpc(...args),from:(...args)=>globalThis.__searchQA.from(...args)};',
  "AuthContext": 'export const useAuth=()=>({user:globalThis.__searchQA.user??null,loading:false});',
  "useBlock": 'const blockedIds=new Set(); export const useBlockedIds=()=>({blockedIds});',
  "player-roster": 'export const kboIdsForTeamSlug=()=>[];',
  "usePosts": 'export const createPost=async()=>{}; export const toggleLike=async()=>{};',
  "useFeedScrollRestore": 'export const useFeedScrollRestore=()=>{};',
  "PhotoFeed": 'import React from "react"; export default ({posts})=>React.createElement("section",{},posts.map(p=>React.createElement("article",{"data-post-id":p.id,key:p.id},p.title)));',
  "lucide-react": 'import React from "react"; export const Pencil=()=>null; export const Search=()=>null; export const X=()=>null;',
};
const overlays = new Set(["WritePost", "WritePhotoPost", "WritePoll", "WriteEntrySheet", "LoginSheet"]);
let mounted;
try {
  const bundle = await build({
    absWorkingDir: root, bundle: true, write: false, platform: "node", format: "cjs",
    packages: "external", jsx: "automatic",
    stdin: { resolveDir: root, sourcefile: "search-retry-entry.tsx", loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Page from './src/app/(main)/community/all-posts/page';
      import { useUnifiedFeed } from './src/lib/supabase/useUnifiedFeed';
      export * as restore from './src/lib/community/feed-restore';
      export { feedKeyFor } from './src/lib/community/feed-search';
      export { createRoot, Page }; export const act=React.act;
      export const page=()=>React.createElement(Page);
      const Hook=({q,restorePath})=>{globalThis.__searchQA.feed=useUnifiedFeed({kind:'all',q},20,restorePath?{restorePath}:undefined);return null;};
      export const hook=(q,restorePath)=>React.createElement(Hook,{q,restorePath});
    ` },
    plugins: [{ name: "rpc-boundary", setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const key = args.path.split("/").at(-1);
        const stub = stubs[args.path] ?? stubs[key] ?? (overlays.has(key) ? "export default ()=>null;" : undefined);
        if (stub !== undefined) return { path: args.path, namespace: "qa-stub", pluginData: stub };
      });
      b.onLoad({ filter: /.*/, namespace: "qa-stub" }, (args) => ({ contents: args.pluginData, loader: "js", resolveDir: root }));
      if (process.env.QA_MUTATION === "hide-list") b.onLoad({ filter: /all-posts\/page\.tsx$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8").replace("fetchError && posts.length === 0", "(fetchError || loadMoreError)"), loader: "tsx",
      }));
      if (process.env.QA_MUTATION === "restart-cursor") b.onLoad({ filter: /useUnifiedFeed\.ts$/ }, (args) => ({
        contents: readFileSync(args.path, "utf8").replace("loadPage(cursorRef.current)", "loadPage(null)"), loader: "ts",
      }));
      if (["late-popstate", "microtask-popstate", "live-restore-snapshot"].includes(process.env.QA_MUTATION)) b.onLoad({ filter: /useUnifiedFeed\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const target = process.env.QA_MUTATION === "live-restore-snapshot"
          ? "readSaved: () => restoreCandidateRef.current?.state ?? null"
          : "if (restorePath) initTimer = setTimeout(initialize, 0);";
        const replacement = process.env.QA_MUTATION === "live-restore-snapshot"
          ? "readSaved: () => readFeedRestore(key)"
          : process.env.QA_MUTATION === "microtask-popstate"
            ? "if (restorePath) void Promise.resolve().then(initialize);"
            : "if (restorePath) void initialize();";
        assert.ok(source.includes(target), "restore mutation target must exist");
        return { contents: source.replace(target, replacement), loader: "ts" };
      });
    } }],
  });
  const compiled = join(scratch, "entry.cjs");
  writeFileSync(compiled, bundle.outputFiles[0].text);
  const app = createRequire(resolve(root, "package.json"))(compiled);
  const { act } = app;

  const rows = (first, count) => Array.from({ length: count }, (_, i) => ({
    id: first - i, author_id: "qa-author", title: `직관 ${first - i}`, content: "fixture",
    board_type: "free", board_id: "general", profiles: { nickname: "QA" },
  }));
  const count = () => document.querySelectorAll("article").length;
  const firstError = () => document.querySelector('[data-testid="post-search-error"]');
  const moreError = () => document.querySelector('[data-testid="post-search-more-error"]');
  const respond = (i, data, error = null) => act(async () => {
    assert.ok(calls[i], `RPC ${i} must exist`);
    calls[i].resolveRequest({ data, error });
  });
  const fail = (i) => respond(i, null, { message: "injected RPC failure" });
  const click = (button) => act(async () => { assert.ok(button, "retry button exists"); button.click(); });
  const flushInitTasks = () => act(async () => {
    const ready = [...initTasks.values()];
    initTasks.clear();
    for (const run of ready) run();
  });
  const mount = async (element, defer = false) => {
    if (mounted) await act(async () => mounted.unmount());
    calls.length = 0;
    mounted = app.createRoot(document.getElementById("root"));
    await act(async () => mounted.render(element));
    if (!defer) await flushInitTasks();
  };

  // Mount the actual hook *before* recording the pop flag, including a microtask checkpoint.
  // This is the production failure sequence, deliberately independent of jsdom listener ordering.
  const feedPath = "/community/all-posts";
  for (const q of [null, "직관"]) {
    const feedKey = app.feedKeyFor({ kind: "all", q });
    window.history.replaceState(null, "", feedPath + (q ? `?q=${encodeURIComponent(q)}` : ""));
    sessionStorage.clear();
    app.restore.saveFeedRestore(feedKey, 3, 14504);
    await mount(app.hook(q, feedPath), true);
    await act(async () => { await Promise.resolve(); });
    assert.equal(calls.length, 0, `${feedKey}: do not initialize before popstate dispatch ends`);
    assert.equal(app.restore.readFeedRestore(feedKey)?.pageCount, 3, "do not clear before deciding pop vs push");
    // Browser/scroll-hook initial paint can overwrite storage before the deferred task runs.
    if (q) app.restore.clearFeedRestore(feedKey);
    else app.restore.saveFeedRestore(feedKey, 1, 1247);
    window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await flushInitTasks();
    await respond(0, rows(200, 20));
    assert.ok(calls[1], `${feedKey}: must reload saved page two, not the overwritten snapshot`);
    assert.equal(calls[1].args.before_id, 181);
    await respond(1, rows(180, 20));
    assert.equal(calls[2]?.args.before_id, 161);
    await respond(2, rows(160, 5));
    assert.equal(globalThis.__searchQA.feed.posts.length, 45);
    assert.equal(globalThis.__searchQA.feed.pageCountRef.current, 3);
    assert.equal(globalThis.__searchQA.feed.pendingScrollY, 14504);
    assert.equal(app.restore.consumeBackNavigation(feedPath), false, "pop flag must not leak into a later push");
    assert.equal(app.restore.readFeedRestore(feedKey), null, "successful restore consumes storage");

    // A later push with saved state but no pop must still start at page one.
    app.restore.saveFeedRestore(feedKey, 3, 14504);
    await mount(app.hook(q, feedPath));
    await respond(0, rows(200, 20));
    assert.equal(calls.length, 1, "push must not replay the saved pages");
    assert.equal(globalThis.__searchQA.feed.pendingScrollY, null);
    assert.equal(app.restore.readFeedRestore(feedKey), null, "push clears stale storage after deciding");
  }
  console.log("PASS actual normal/search hook: late pop + overwritten snapshot → 3 pages/scroll intent; push stays fresh");

  // Auth hydration cancels the first task without consuming the flag/snapshot; the next generation owns it.
  sessionStorage.clear();
  const hydrateKey = app.feedKeyFor({ kind: "all", q: "직관" });
  app.restore.saveFeedRestore(hydrateKey, 2, 9000);
  await mount(app.hook("직관", feedPath), true);
  app.restore.clearFeedRestore(hydrateKey);
  window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  globalThis.__searchQA.user = { id: "qa-hydrated" };
  await act(async () => mounted.render(app.hook("직관", feedPath)));
  await flushInitTasks();
  assert.equal(calls.length, 1, "cancelled initialization must not issue a duplicate request");
  await respond(0, rows(200, 20));
  await respond(1, rows(180, 1));
  assert.equal(globalThis.__searchQA.feed.pageCountRef.current, 2);
  assert.equal(globalThis.__searchQA.feed.pendingScrollY, 9000);
  assert.equal(app.restore.consumeBackNavigation(feedPath), false);
  await act(async () => mounted.unmount());
  mounted = null;
  globalThis.__searchQA.user = null;

  // Unmount before the task begins: no request, no consumption or deletion by a dead generation.
  app.restore.saveFeedRestore(hydrateKey, 2, 9000);
  await mount(app.hook("직관", feedPath), true);
  window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  await act(async () => mounted.unmount());
  mounted = null;
  await flushInitTasks();
  assert.equal(calls.length, 0);
  assert.equal(app.restore.readFeedRestore(hydrateKey)?.pageCount, 2);
  assert.equal(app.restore.consumeBackNavigation(feedPath), true, "unmounted initialization must not consume the flag");
  sessionStorage.clear();
  window.history.replaceState(null, "", `${feedPath}?q=직관`);
  console.log("PASS cancelled task: auth hydration preserves original intent; unmount neither loads nor consumes");

  await mount(app.page());
  await respond(0, rows(200, 20));
  assert.equal(count(), 20);
  const observer = [...observers][0];
  assert.ok(observer, "actual page sentinel is wired");
  await act(async () => observer.callback([{ isIntersecting: true }]));
  assert.equal(calls[1].args.before_id, 181);
  await fail(1);
  assert.equal(count(), 20, "page-two error must retain all first-page cards");
  assert.equal(firstError(), null, "page-two error must not replace the feed");
  assert.ok(moreError(), "page-two error has a footer retry");
  await act(async () => { for (const io of observers) io.callback([{ isIntersecting: true }]); });
  assert.equal(calls.length, 2, "failure must stop automatic retries");
  await click(moreError().querySelector("button"));
  assert.equal(calls[2].args.before_id, 181, "retry must resume the failed cursor");
  assert.ok(moreError().querySelector("button").disabled, "retry stays disabled while pending");
  await click(moreError().querySelector("button"));
  assert.equal(calls.length, 3, "double click must not duplicate the RPC");
  await fail(2);
  assert.equal(count(), 20, "repeated failure still retains the feed");
  await click(moreError().querySelector("button"));
  await respond(3, rows(181, 2));
  assert.equal(count(), 21, "successful retry appends without duplicate cards");
  assert.equal(moreError(), null, "successful retry clears the footer");
  console.log("PASS page-two failure → repeated failure → same-cursor retry, cards retained, single-flight, dedupe");

  await mount(app.page());
  await fail(0);
  assert.ok(firstError());
  assert.equal(document.querySelector('[data-testid="post-search-empty"]'), null);
  await click(firstError().querySelector("button"));
  await respond(1, rows(200, 20));
  assert.equal(count(), 20);
  assert.equal(firstError(), null);
  console.log("PASS first-page failure → visible retry → recovery (not empty results)");

  // Real hook: late page/reload success AND failure cannot touch the next search generation.
  for (const lateFailure of [false, true]) {
    await mount(app.hook("직관"));
    await respond(0, rows(200, 20));
    await act(async () => { void globalThis.__searchQA.feed.loadMore(); });
    await fail(1);
    await act(async () => {
      void globalThis.__searchQA.feed.retryLoadMore();
      void globalThis.__searchQA.feed.retryLoadMore();
    });
    assert.equal(calls.length, 3, "same-tick double retry is single-flight");
    await act(async () => mounted.render(app.hook("홈런")));
    await respond(3, rows(400, 20));
    await act(async () => { void globalThis.__searchQA.feed.loadMore(); });
    if (lateFailure) await fail(2); else await respond(2, rows(180, 1));
    assert.equal(globalThis.__searchQA.feed.loadingMore, true, "old finally must not release the new request lock");
    await act(async () => { void globalThis.__searchQA.feed.loadMore(); });
    assert.equal(calls.length, 5);
    assert.equal(globalThis.__searchQA.feed.loadMoreError, null);
    await respond(4, rows(380, 1));
    assert.deepEqual(globalThis.__searchQA.feed.posts.map(p => p.id), [...rows(400, 20), ...rows(380, 1)].map(p => p.id));
    await act(async () => { void globalThis.__searchQA.feed.reload(); });
    await act(async () => mounted.render(app.hook("선발")));
    if (lateFailure) await fail(5); else await respond(5, rows(900, 1));
    assert.equal(globalThis.__searchQA.feed.loading, true, "old reload cannot dismiss new search loading");
    assert.equal(globalThis.__searchQA.feed.fetchError, null);
    await respond(6, rows(600, 1));
    assert.equal(globalThis.__searchQA.feed.posts[0].id, 600);
  }
  console.log("PASS pending retry/reload → new search: stale success/failure ignored; active lock preserved");
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  initTasks.clear();
  if (mounted) {
    const { act } = await import("react");
    await act(async () => mounted.unmount());
  }
  dom.window.close();
  delete globalThis.__searchQA;
  rmSync(scratch, { recursive: true, force: true });
}
