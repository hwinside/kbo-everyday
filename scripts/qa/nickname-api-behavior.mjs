#!/usr/bin/env node
/**
 * 닉네임 2~8자 정책 — 실제 API route handler 호출 회귀.
 *
 * 소스 문자열이 아니라 route 를 실제로 실행해서
 * 8자 accept / 9자 reject-before-write 를 검증한다.
 * (삼순 NO-GO 2026-08-02: 세 route 의 검증을 통째로 우회해도 문자열 스모크가 통과했음)
 *
 * 결함주입(mutation) — 각각 RED 여야 한다:
 *   NICKNAME_MUTATE_SETUP=1   가입 route 검증 우회
 *   NICKNAME_MUTATE_CHECK=1   가용성 체크 route 검증 우회
 *   NICKNAME_MUTATE_ME=1      닉네임 변경 route 검증 우회
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const GEN = mkdtempSync(resolve(tmpdir(), "nickname-api-"));

const BYPASS = "((x) => null)";

/** route 소스를 읽고, mutation 이 켜져 있으면 validateNickname 호출을 무력화한다. */
function routeSource(relPath, mutate) {
  const src = readFileSync(resolve(ROOT, relPath), "utf8");
  const calls = src.split("validateNickname(").length - 1;
  if (calls < 1) {
    console.error(`FAIL: ${relPath} 가 validateNickname 을 호출하지 않음`);
    process.exit(1);
  }
  if (!mutate) return src;
  // import 는 남기고 호출부만 항상 null 을 돌려주도록 바꾼다(= 검증 우회).
  return src.replace(/validateNickname\(/g, `${BYPASS}(`);
}

const ROUTES = [
  { key: "setup", path: "src/app/api/setup/route.ts", mutate: process.env.NICKNAME_MUTATE_SETUP === "1" },
  { key: "check", path: "src/app/api/check-nickname/route.ts", mutate: process.env.NICKNAME_MUTATE_CHECK === "1" },
  { key: "me", path: "src/app/api/me/nickname/route.ts", mutate: process.env.NICKNAME_MUTATE_ME === "1" },
];

const mutations = ROUTES.filter((r) => r.mutate).map((r) => r.key);

for (const route of ROUTES) {
  writeFileSync(resolve(GEN, `${route.key}-route.ts`), routeSource(route.path, route.mutate));
}

/* ------------------------------------------------------------------ *
 * 인메모리 Supabase 스텁 — 실제 write 시도를 기록한다.
 * 검증이 우회되면 여기에 9자 닉네임이 실제로 기록되므로 RED 가 된다.
 * ------------------------------------------------------------------ */
writeFileSync(resolve(GEN, "supabase-stub.js"), `
export const state = {
  profiles: [{ id: "existing-user", nickname: "기존닉" }],
  nicknameChanges: [],
  writes: [],
};

export function resetState() {
  state.profiles = [{ id: "existing-user", nickname: "기존닉" }];
  state.nicknameChanges = [];
  state.writes = [];
}

function selectBuilder(table) {
  const filters = { ilike: null, eq: {}, neq: {} };
  const rows = () => {
    let list = table === "profiles" ? state.profiles
      : table === "profile_nickname_changes" ? state.nicknameChanges
      : [];
    if (filters.ilike) {
      list = list.filter((r) => String(r.nickname ?? "").toLowerCase() === filters.ilike.toLowerCase());
    }
    for (const [col, val] of Object.entries(filters.eq)) list = list.filter((r) => r[col] === val);
    for (const [col, val] of Object.entries(filters.neq)) list = list.filter((r) => r[col] !== val);
    return list;
  };
  const api = {
    ilike(col, val) { filters.ilike = val; return api; },
    eq(col, val) { filters.eq[col] = val; return api; },
    neq(col, val) { filters.neq[col] = val; return api; },
    gte() { return api; },
    order() { return Promise.resolve({ data: rows(), error: null }); },
    limit() { return api; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
    single() {
      const row = rows()[0];
      return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } });
    },
    then(onOk) { return Promise.resolve({ data: rows(), error: null }).then(onOk); },
  };
  return api;
}

function tableApi(table) {
  return {
    select() { return selectBuilder(table); },
    insert(row) {
      state.writes.push({ table, op: "insert", row });
      if (table === "profiles") state.profiles.push(row);
      if (table === "profile_nickname_changes") state.nicknameChanges.unshift(row);
      return Promise.resolve({ error: null });
    },
    upsert(row) {
      state.writes.push({ table, op: "upsert", row });
      return Promise.resolve({ error: null });
    },
    update(patch) {
      const applied = { table, op: "update", row: patch };
      return {
        eq(col, val) {
          state.writes.push(applied);
          if (table === "profiles") {
            const target = state.profiles.find((r) => r[col] === val);
            if (target) Object.assign(target, patch);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
    delete() {
      return { eq() { state.writes.push({ table, op: "delete" }); return Promise.resolve({ error: null }); } };
    },
  };
}

export const supabaseAdmin = {
  from: tableApi,
  auth: { getUser: async () => ({ data: { user: { id: "new-user" } } }) },
};
export const getSupabaseAdmin = () => supabaseAdmin;
`);

// next/server 는 런타임 의존이 무거워 최소 계약만 대체한다.
// (status/json 만 쓰이므로 라우트의 판정 로직은 실물 그대로 실행된다)
writeFileSync(resolve(GEN, "next-server.js"), `
export const NextResponse = {
  json(body, init) {
    return new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  },
};
export class NextRequest extends Request {}
`);

writeFileSync(resolve(GEN, "verified-user.js"), `
export const getVerifiedUserFromRequest = async () => ({ user: { id: "existing-user" } });`);
writeFileSync(resolve(GEN, "headers.js"), `
export const cookies = async () => ({ getAll: () => [] });`);
writeFileSync(resolve(GEN, "ssr.js"), `
export const createServerClient = () => ({ auth: { getUser: async () => ({ data: { user: null } }) } });`);

writeFileSync(resolve(GEN, "entry.ts"), `
export { POST as setupPost } from "./setup-route";
export { GET as checkGet } from "./check-route";
export { POST as mePost } from "./me-route";
export { state, resetState } from "./supabase-stub.js";
`);

await build({
  entryPoints: [resolve(GEN, "entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: resolve(GEN, "bundle.mjs"),
  absWorkingDir: ROOT,
  nodePaths: [resolve(ROOT, "node_modules")],
  tsconfig: resolve(ROOT, "tsconfig.json"),
  alias: {
    "next/server": resolve(GEN, "next-server.js"),
    "@/lib/supabase/admin": resolve(GEN, "supabase-stub.js"),
    "@/lib/auth/verified-user": resolve(GEN, "verified-user.js"),
    "next/headers": resolve(GEN, "headers.js"),
    "@supabase/ssr": resolve(GEN, "ssr.js"),
  },
  logLevel: "error",
});

const mod = await import(pathToFileURL(resolve(GEN, "bundle.mjs")).href);

/* ------------------------------------------------------------------ */
let failures = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const OK_8 = "가나다라마바사아";     // 8자 — 허용
const NG_9 = "가나다라마바사아자";   // 9자 — 거부
const OK_2 = "가나";                 // 2자 — 허용(하한)
const NG_1 = "가";                   // 1자 — 거부(하한)

function jsonRequest(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer qa" },
    body: JSON.stringify(body),
  });
}

/* --- 1) 가입 API --- */
console.log("\n[가입 API /api/setup]");
{
  mod.resetState();
  const res = await mod.setupPost(jsonRequest("http://qa.invalid/api/setup", { nickname: OK_8, team_id: 1 }));
  const body = await res.json();
  const wrote = mod.state.profiles.some((p) => p.nickname === OK_8);
  check("8자 가입 허용", res.status === 200 && body.ok === true, `status=${res.status}`);
  check("8자 가입이 실제로 프로필을 생성", wrote);
}
{
  mod.resetState();
  const res = await mod.setupPost(jsonRequest("http://qa.invalid/api/setup", { nickname: NG_9, team_id: 1 }));
  const body = await res.json();
  const wrote = mod.state.writes.length > 0;
  check("9자 가입 거부", res.status === 400, `status=${res.status} error=${body.error ?? ""}`);
  check("9자 가입은 write 이전에 차단(DB 미기록)", !wrote, `writes=${mod.state.writes.length}`);
}
{
  mod.resetState();
  const res = await mod.setupPost(jsonRequest("http://qa.invalid/api/setup", { nickname: NG_1, team_id: 1 }));
  check("1자 가입 거부", res.status === 400, `status=${res.status}`);
  check("1자 가입은 write 이전에 차단", mod.state.writes.length === 0);
}

/* --- 2) 가용성 체크 API --- */
console.log("\n[가용성 체크 /api/check-nickname]");
{
  const res = await mod.checkGet(new Request(`http://qa.invalid/api/check-nickname?nickname=${encodeURIComponent(OK_8)}`));
  const body = await res.json();
  check("8자는 사용 가능 응답", body.available === true, JSON.stringify(body));
}
{
  const res = await mod.checkGet(new Request(`http://qa.invalid/api/check-nickname?nickname=${encodeURIComponent(NG_9)}`));
  const body = await res.json();
  check(
    "9자는 사용 불가 + 2~8자 사유",
    body.available === false && String(body.reason ?? "").includes("2~8자"),
    JSON.stringify(body),
  );
}
{
  const res = await mod.checkGet(new Request(`http://qa.invalid/api/check-nickname?nickname=${encodeURIComponent(OK_2)}`));
  const body = await res.json();
  check("2자는 사용 가능 응답", body.available === true, JSON.stringify(body));
}

/* --- 3) 닉네임 변경 API --- */
console.log("\n[닉네임 변경 /api/me/nickname]");
{
  mod.resetState();
  const res = await mod.mePost(jsonRequest("http://qa.invalid/api/me/nickname", { nickname: OK_8 }));
  const body = await res.json();
  const saved = mod.state.profiles.find((p) => p.id === "existing-user")?.nickname;
  check("8자 변경 허용", res.status === 200 && body.success === true, `status=${res.status}`);
  check("8자 변경이 실제로 저장됨", saved === OK_8, `saved=${saved}`);
}
{
  mod.resetState();
  const res = await mod.mePost(jsonRequest("http://qa.invalid/api/me/nickname", { nickname: NG_9 }));
  const body = await res.json();
  const saved = mod.state.profiles.find((p) => p.id === "existing-user")?.nickname;
  check("9자 변경 거부", res.status === 400, `status=${res.status} error=${body.error ?? ""}`);
  check("9자 변경은 write 이전에 차단(기존 닉 불변)", saved === "기존닉" && mod.state.writes.length === 0, `saved=${saved} writes=${mod.state.writes.length}`);
}

/* --- 4) 기존 장닉네임 사용자 보호 --- */
console.log("\n[기존 9자 이상 사용자]");
{
  mod.resetState();
  mod.state.profiles[0].nickname = "가나다라마바사아자차";  // 기존 10자 유저
  const res = await mod.mePost(jsonRequest("http://qa.invalid/api/me/nickname", { nickname: "가나다라마바사아자차" }));
  const body = await res.json();
  const saved = mod.state.profiles.find((p) => p.id === "existing-user")?.nickname;
  check(
    "기존 10자 닉네임은 강제 변경/삭제되지 않음",
    saved === "가나다라마바사아자차",
    `saved=${saved}`,
  );
  check(
    "기존 10자 유저가 같은 닉으로 재요청하면 새 정책에 걸려 거부(기존 값은 유지)",
    res.status === 400 && String(body.error ?? "").includes("2~8자"),
    `status=${res.status} error=${body.error ?? ""}`,
  );
}

rmSync(GEN, { recursive: true, force: true });

if (mutations.length) {
  console.log(`\n[mutation] ${mutations.join(", ")} 검증 우회`);
}
console.log(failures === 0 ? `\nPASS — ${total}/${total}` : `\nFAIL ${failures} / ${total} · exit 1`);
process.exit(failures === 0 ? 0 : 1);
