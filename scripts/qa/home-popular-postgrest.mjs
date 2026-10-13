#!/usr/bin/env node
/** Ephemeral PG17 + real PostgREST HTTP, no production DB or credentials. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(import.meta.dirname, "../..");
const pg = [process.env.PG17_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .find((p) => p && existsSync(path.join(p, "initdb")));
assert.ok(pg, "PG17_BIN must point to PostgreSQL 17 binaries; missing dependency is FAIL");
const postgrest = process.env.POSTGREST_BIN || "postgrest";
const work = mkdtempSync(path.join(process.env.OPENCLAW_REVIEW_ROOT || tmpdir(), "popular-http-"));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const dbPort = await freePort();
const httpPort = await freePort();
// Homebrew PG17 can crash after fork under the host locale; pin every PG subprocess.
const runPg = (bin, args) => execFileSync(path.join(pg, bin), args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LC_ALL: "C", LANG: "C" },
});
const sql = (args) => runPg("psql", ["-h", "127.0.0.1", "-p", String(dbPort), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA", ...args]);
let started = false, http, logFd;
try {
  runPg("initdb", ["-D", path.join(work,"data"), "-A", "trust", "-U", "postgres", "--encoding=UTF8", "--locale=C"]);
  runPg("pg_ctl", ["-D", path.join(work,"data"), "-l", path.join(work,"pg.log"), "-o", `-h 127.0.0.1 -p ${dbPort} -k ${work}`, "-w", "start"]);
  started = true;
  assert.match(sql(["-c", "show server_version_num"]).trim(), /^17\d{4}$/);
  sql(["-f", path.join(root,"scripts/qa/fixtures/home-popular-rpc.sql")]);
  sql(["-f", path.join(root,"supabase/migrations/20260905043000_posts_popularity.sql")]);
  // Random, local-only fixture signing key. Never logged, passed on argv, or sent externally.
  const signingKey = randomBytes(32).toString("hex");
  const config = path.join(work,"postgrest.conf");
  writeFileSync(config, [
    `db-uri = "postgresql://authenticator@127.0.0.1:${dbPort}/postgres"`,
    'db-schemas = "public"', 'db-anon-role = "anon"',
    `jwt-secret = "${signingKey}"`, 'server-host = "127.0.0.1"', `server-port = ${httpPort}`,
  ].join("\n"), { mode: 0o600 });
  logFd = openSync(path.join(work,"http.log"), "w");
  http = spawn(postgrest, [config], { stdio: ["ignore", logFd, logFd] });
  let launchError;
  http.on("error", (e) => { launchError = e; });
  const base = `http://127.0.0.1:${httpPort}`;
  let ready = false;
  for (let i=0; i<100; i++) {
    if (launchError) throw launchError;
    if (http.exitCode !== null) throw new Error("PostgREST exited before ready");
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) { ready=true; break; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r,100));
  }
  assert.ok(ready,"PostgREST ready within 10 seconds");
  const token = (sub) => {
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = `${enc({alg:"HS256",typ:"JWT"})}.${enc({role:"authenticated",sub,exp:Math.floor(Date.now()/1000)+300})}`;
    return `${body}.${createHmac("sha256",signingKey).update(body).digest("base64url")}`;
  };
  const client = (sub) => createClient(base,"unused-local-fixture", {
    auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false },
    global: { fetch: (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin,base,"fixture request may not leave loopback");
      url.pathname=url.pathname.replace(/^\/rest\/v1/,"");
      const headers = new Headers(init?.headers);
      if (sub) headers.set("Authorization",`Bearer ${token(sub)}`);
      else headers.delete("Authorization");
      return fetch(url,{...init,headers});
    } },
  });
  // Read the actual application's projection; do not fake SQL JOIN as HTTP embedding evidence.
  const source=readFileSync(path.join(root,"src/lib/supabase/useUnifiedFeed.ts"),"utf8");
  const select=source.match(/export const FEED_SELECT\s*=\s*"([^"]+)"/)[1]+", popularity";
  const since=new Date(Date.now()-7*86400000).toISOString();
  const args={p_since:since,p_limit:6,p_team_slug:"lg",p_other_kbo_ids:[],p_blocked:[],p_exclude:[]};
  async function call(c, extra={}) {
    // query-guard: bounded -- RPC enforces a 100-row cap and a seven-day created_at window.
    const {data,error}=await c.rpc("home_popular_posts",{...args,...extra}).select(select)
      .abortSignal(AbortSignal.timeout(10_000));
    assert.equal(error,null,error?.code);
    return data;
  }
  const a="00000000-0000-4000-8000-000000000001", b="00000000-0000-4000-8000-000000000002";
  const anon=client(), authA=client(a), authB=client(b);
  const first=await call(anon);
  assert.deepEqual(first.map((r)=>r.id),[125,124,123,122,121,120]);
  assert.equal(first[0].profiles.nickname,"fixture-A");
  assert.equal(first[0].popularity,126);
  console.log("PASS HTTP1 anonymous .rpc().select(FEED_SELECT, popularity): embedded profile / order / RLS");
  assert.deepEqual((await call(authA)).map((r)=>r.id),[200,125,124,123,122,121]);
  const other=await call(authB);
  assert.deepEqual(other.map((r)=>r.id),[201,125,124,123,122,121]);
  assert.equal(other[0].profiles.nickname,"fixture-B");
  console.log("PASS HTTP2 signed authenticated A/B: own private row only / profiles embed");
  assert.equal((await call(anon,{p_limit:1000})).length,100);
  assert.deepEqual(await call(anon,{p_limit:-1}),[]);
  assert.deepEqual(await call(anon,{p_blocked:[a]}),[]);
  assert.equal((await call(anon,{p_exclude:[125,124,123,122,121]}))[0].id,120);
  console.log("PASS HTTP3 125-row cap / negative limit / blocked author / excluded ids");
  sql(["-c","drop policy public_posts on public.posts; drop policy own_posts on public.posts"]);
  assert.deepEqual(await call(anon),[]);
  assert.deepEqual(await call(authA),[]);
  console.log("PASS HTTP4 no SELECT policy: both HTTP roles get zero rows");
} finally {
  if (http && http.exitCode===null) {
    http.kill("SIGTERM");
    await Promise.race([new Promise((r)=>http.once("exit",r)),new Promise((r)=>setTimeout(r,2000))]);
    if (http.exitCode===null) http.kill("SIGKILL");
  }
  if (logFd!==undefined) closeSync(logFd);
  if (started) runPg("pg_ctl",["-D",path.join(work,"data"),"-m","immediate","-w","stop"]);
  rmSync(work,{recursive:true,force:true});
}
