/**
 * 야잘알봇 답변 피드백 — **실제 route + 실제 PostgreSQL(PGlite 17) 통합 회귀**.
 *
 * ⚠️ 이 파일이 존재하는 이유 (삼순 2026-08-06 재리뷰):
 *   기존 `genius-feedback-db-actual.mjs` 는 ①원격 Supabase Management API 가 필요해
 *   **CI 에서 돌지 않았고**(로컬 전용 = required gate 아님) ②route 를 태우지 않고 RPC 만
 *   직접 호출해 "route 가 대상·결속을 강제하는가"를 전혀 검증하지 못했다.
 *
 *   여기서는 supabase-js 를 PGlite 로 갈아끼우고 **production route 핸들러를 그대로
 *   호출**해 HTTP status·DB 행을 실제 값으로 고정한다. 가드를 지우면 반드시 RED 다.
 *   외부 자격증명이 필요 없으므로 prebuild(required)에서 항상 돈다.
 *
 * 커버:
 *   ① fresh migrate + ACL — service_role EXECUTE/테이블 권한, anon·authenticated 차단
 *   ② 대상 allowlist — rag/dictionary/kbo_structured answer 만 200, llm·cache·
 *      unavailable·ack·picker·payload 없음·qid 없음 전부 400
 *   ③ 질문로그 exact 결속 — 0행/N행 fail-close, forged(남의 로그) 거절, FK 로 못박힘
 *   ④ 소유권 — 남의 대화 답변 403, 봇 아닌 발신 403, 비로그인 401
 *   ⑤ CAS — 동일 set/clear 병렬 8회 각각 1행/0행, stale opposite-state 는 409 + actual
 *   ⑥ GET 복원 — 본인 표만
 *
 * 실행: npm run qa:genius-feedback-db
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://genius-feedback-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// dead-token guard의 exp 프리체크는 JWT 형태가 아닌 토큰을 로컬 거절하므로
// 테스트 토큰도 실제와 같은 JWT 형태여야 한다 (서명 검증은 shim이 대신한다).
const _b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const _testJwt = (sub: string) =>
  `${_b64({ alg: "HS256", typ: "JWT" })}.${_b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.test-sig`;
const OWNER_TOKEN = _testJwt("owner");
const OTHER_TOKEN = _testJwt("other");

const GENIUS = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Row = Record<string, unknown>;

/**
 * migration 파일을 **내용으로** 찾는다 — 파일명을 하드코딩하면 이름이 바뀌었을 때
 * 게이트가 조용히 다른 파일을 읽거나 통과한다(#1110 자체발견분).
 */
function findMigration(marker: RegExp): string {
  const dir = resolve("supabase/migrations");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .filter((src) => marker.test(src));
  if (hits.length !== 1) {
    throw new Error(`migration 탐색 실패: ${marker} 에 매치되는 파일이 ${hits.length}개`);
  }
  return hits[0]!;
}

// ── supabase-js → PGlite 어댑터 ──────────────────────────────────────────────
// route 가 실제로 쓰는 빌더 모양만 지원한다: select/eq/in/limit/maybeSingle + rpc.
// `dm_conversations!inner(...)` embed 는 PostgREST 문법이라 SQL join 으로 번역한다.
interface Filter { column: string; value: unknown; op: "eq" | "in" }

function makeQueryBuilder(db: PGlite, table: string) {
  const filters: Filter[] = [];
  let selectColumns = "*";
  let limitCount: number | null = null;
  let single = false;

  function build(params: unknown[]): string {
    // dm_messages 는 대화 embed 를 요구한다 — join 으로 같은 shape 를 만든다.
    const embed = table === "dm_messages" && selectColumns.includes("dm_conversations");
    const cols = embed
      ? `m.id, m.sender_id, m.payload, m.conversation_id,
         jsonb_build_object('user1_id', c.user1_id, 'user2_id', c.user2_id) AS dm_conversations`
      : selectColumns;
    const from = embed
      ? `dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id`
      : table;
    const prefix = embed ? "m." : "";
    const parts: string[] = [];
    for (const f of filters) {
      if (f.op === "in") {
        const values = f.value as unknown[];
        if (values.length === 0) { parts.push("false"); continue; }
        const ph = values.map((v) => { params.push(v); return `$${params.length}`; });
        parts.push(`${prefix}${f.column} IN (${ph.join(", ")})`);
        continue;
      }
      params.push(f.value);
      parts.push(`${prefix}${f.column} = $${params.length}`);
    }
    let sql = `SELECT ${cols} FROM ${from}`;
    if (parts.length) sql += ` WHERE ${parts.join(" AND ")}`;
    if (limitCount != null) sql += ` LIMIT ${limitCount}`;
    return sql;
  }

  async function run(): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      const params: unknown[] = [];
      const result = await db.query<Row>(build(params), params);
      const rows = result.rows ?? [];
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }

  const builder: Record<string, unknown> = {
    select(columns?: string) { selectColumns = columns?.trim() || "*"; return builder; },
    eq(column: string, value: unknown) { filters.push({ column, value, op: "eq" }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ column, value, op: "in" }); return builder; },
    limit(count: number) { limitCount = count; return builder; },
    maybeSingle() { single = true; return run(); },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
      return run().then(onFulfilled, onRejected);
    },
  };
  return builder;
}

async function installSupabaseShim(db: PGlite) {
  const adminModule = await import("../../src/lib/supabase/admin");
  const client = adminModule.supabaseAdmin as unknown as {
    auth: {
      getUser: (token: string) => Promise<unknown>;
      getClaims: (token: string) => Promise<unknown>;
    };
    from: (table: string) => unknown;
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  const resolveTestUser = (token: string) =>
    token === OWNER_TOKEN ? OWNER : token === OTHER_TOKEN ? OTHER : null;
  client.auth.getUser = async (token: string) => {
    const userId = resolveTestUser(token);
    return userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: "invalid token" } };
  };
  // verifyAccessToken 은 이제 getClaims(JWKS 로컬 검증) 경로를 탄다. 실제
  // getClaims 는 토큰의 `sub` 을 그대로 돌려주므로, 테스트 JWT 의 sub("owner")
  // 가 그대로 나가면 UUID 가 아니라 라우트가 깨진다. 서명 검증을 shim 이
  // 대신하는 것과 동일하게, 토큰→유저 매핑도 shim 이 맞춰준다.
  client.auth.getClaims = async (token: string) => {
    const userId = resolveTestUser(token);
    if (!userId) {
      return { data: null, error: { message: "invalid token", code: "bad_jwt" } };
    }
    // verifyAccessToken 은 이제 iss/aud/role/sub/session_id 를 fail-close 로
    // 검증한다(삼순 blocker④). {sub,email} 만 돌려주면 이 fixture 가 실제 계약을
    // 우회해버리므로, 정상 access token 과 같은 full claim shape 를 돌려준다.
    return {
      data: {
        claims: {
          iss: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`,
          aud: "authenticated",
          role: "authenticated",
          sub: userId,
          session_id: `sess-${userId}`,
          email: null,
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    };
  };
  client.from = (table: string) => makeQueryBuilder(db, table);
  client.rpc = async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    const params = keys.map((k) => args[k]);
    const placeholders = keys.map((k, i) => `${k} => $${i + 1}`);
    try {
      const result = await db.query<{ result: unknown }>(
        `SELECT ${name}(${placeholders.join(", ")}) AS result`,
        params,
      );
      return { data: result.rows[0]?.result ?? null, error: null };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  };
}

// ── route 호출 helper ────────────────────────────────────────────────────────
function authed(url: string, token: string | null, init?: RequestInit): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { ...init, headers });
}

interface FeedbackApi {
  POST: (req: NextRequest) => Promise<Response>;
  GET: (req: NextRequest) => Promise<Response>;
}

async function main() {
  const db = new PGlite();
  await db.waitReady;
  const version = await db.query<{ server_version: string }>("SHOW server_version");
  ok("PostgreSQL 17에서 실행", /^17\./.test(version.rows[0]!.server_version), version.rows[0]!.server_version);

  // ── 최소 선행 스키마 ──────────────────────────────────────────────────────
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE dm_conversations (
      id uuid PRIMARY KEY, user1_id uuid, user2_id uuid
    );
    CREATE TABLE dm_messages (
      id bigint PRIMARY KEY, conversation_id uuid REFERENCES dm_conversations(id),
      sender_id uuid, payload jsonb
    );
    CREATE TABLE genius_question_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, question text NOT NULL, question_norm text NOT NULL,
      match_path text NOT NULL, answer text,
      input_tokens int, output_tokens int,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // ── ① fresh migrate ───────────────────────────────────────────────────────
  const migration = findMigration(/CREATE TABLE IF NOT EXISTS public\.genius_answer_feedback/);
  await db.exec(migration.replaceAll("public.", ""));
  ok("① fresh migrate 적용 성공", true);

  const acl = await db.query<{ can_exec: boolean }>(`
    SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS can_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='set_baseball_genius_answer_feedback';
  `);
  ok("① service_role EXECUTE 보유", acl.rows[0]?.can_exec === true, JSON.stringify(acl.rows));

  const tblAcl = await db.query<{ ins: boolean; anon_sel: boolean; auth_sel: boolean }>(`
    SELECT has_table_privilege('service_role','genius_answer_feedback','INSERT') AS ins,
           has_table_privilege('anon','genius_answer_feedback','SELECT') AS anon_sel,
           has_table_privilege('authenticated','genius_answer_feedback','SELECT') AS auth_sel;
  `);
  ok("① service_role INSERT 보유", tblAcl.rows[0]?.ins === true);
  ok("① anon 차단", tblAcl.rows[0]?.anon_sel === false);
  ok("① authenticated 차단", tblAcl.rows[0]?.auth_sel === false);

  const rls = await db.query<{ relforcerowsecurity: boolean }>(
    `SELECT relforcerowsecurity FROM pg_class WHERE relname='genius_answer_feedback';`,
  );
  ok("① RLS FORCE", rls.rows[0]?.relforcerowsecurity === true);

  await installSupabaseShim(db);
  const route = (await import("../../src/app/api/baseball-qa/feedback/route")) as unknown as FeedbackApi;

  // ── fixture ───────────────────────────────────────────────────────────────
  const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER_CONV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await db.exec(`
    INSERT INTO dm_conversations (id, user1_id, user2_id) VALUES
      ('${CONV}', '${OWNER}', '${GENIUS}'),
      ('${OTHER_CONV}', '${OTHER}', '${GENIUS}');
  `);

  /** 질문 쪽지 + 답변 쪽지 + (옵션) 질문로그를 한 벌로 만든다. */
  async function seed(opts: {
    qid: number; aid: number; matchPath: string; replyKind: string;
    conv?: string; sender?: string; withPayloadQid?: boolean;
    logs?: Array<{ matchPath: string; userId?: string }>;
  }) {
    const conv = opts.conv ?? CONV;
    const payload = {
      type: "baseball_genius_reply",
      reply_kind: opts.replyKind,
      match_path: opts.matchPath,
      ...(opts.withPayloadQid === false ? {} : { question_message_id: opts.qid }),
    };
    await db.query(
      `INSERT INTO dm_messages (id, conversation_id, sender_id, payload) VALUES ($1,$2,$3,NULL) ON CONFLICT DO NOTHING`,
      [opts.qid, conv, OWNER],
    );
    await db.query(
      `INSERT INTO dm_messages (id, conversation_id, sender_id, payload) VALUES ($1,$2,$3,$4::jsonb)`,
      [opts.aid, conv, opts.sender ?? GENIUS, JSON.stringify(payload)],
    );
    for (const log of opts.logs ?? [{ matchPath: opts.matchPath }]) {
      await db.query(
        `INSERT INTO genius_question_logs (user_id, question, question_norm, match_path, question_message_id)
         VALUES ($1,'q','q',$2,$3)`,
        [log.userId ?? OWNER, log.matchPath, opts.qid],
      );
    }
  }

  async function post(aid: number, body: Record<string, unknown>, token: string | null = OWNER_TOKEN) {
    return route.POST(authed("http://localhost/api/baseball-qa/feedback", token, {
      method: "POST",
      body: JSON.stringify({ answerMessageId: aid, ...body }),
    }));
  }

  async function rowsFor(aid: number, userId = OWNER): Promise<Row[]> {
    const r = await db.query<Row>(
      `SELECT rating, question_message_id, question_log_id, match_path, reply_kind
         FROM genius_answer_feedback WHERE user_id=$1 AND answer_message_id=$2`,
      [userId, aid],
    );
    return r.rows ?? [];
  }

  // ── ② 대상 allowlist ──────────────────────────────────────────────────────
  // 하린아빠 2026-08-06 + 삼순 4차: **가져온 답**만 — rag / dictionary / kbo_structured.
  const ELIGIBLE: Array<[string, string]> = [
    ["rag", "answer"],
    ["dictionary", "answer"],
    ["kbo_structured", "answer"],  // 운영 DB 원값(순위표·팀기록) — 생성이 아니라 조회다
  ];
  const REJECTED: Array<[string, string]> = [
    ["llm", "answer"],             // 스몰톡이 떨어지는 경로
    ["cache", "answer"],           // 과거 llm 생성답
    ["rag", "unavailable"],        // RAG 를 탔지만 못 답함(운영 실측 5건)
    ["kbo_structured", "unavailable"],
    ["blocked", "unavailable"],
    ["unsure", "unavailable"],
    ["ack", "ack"],
    ["player_picker", "picker"],
  ];

  let id = 1000;
  for (const [matchPath, replyKind] of ELIGIBLE) {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath, replyKind });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    const rows = await rowsFor(aid);
    ok(`② ${replyKind}/${matchPath} 는 대상 (200 + 1행)`,
      res.status === 200 && rows.length === 1 && Number(rows[0]!.rating) === 1,
      `status=${res.status} rows=${rows.length}`);
    ok(`③ ${matchPath} 표가 질문로그에 FK 결속`, rows[0]?.question_log_id != null);
  }
  for (const [matchPath, replyKind] of REJECTED) {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath, replyKind });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    const rows = await rowsFor(aid);
    ok(`② ${replyKind}/${matchPath} 는 거절 (400 + 0행)`,
      res.status === 400 && rows.length === 0, `status=${res.status} rows=${rows.length}`);
  }

  // legacy: payload 에 qid 가 없다 (운영 1,096건 전부 이 모양)
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer", withPayloadQid: false });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("② legacy(qid 없는 payload) 거절", res.status === 400 && (await rowsFor(aid)).length === 0,
      `status=${res.status}`);
  }
  // payload 자체가 없는 과거 답변
  {
    const aid = id++;
    await db.query(
      `INSERT INTO dm_messages (id, conversation_id, sender_id, payload) VALUES ($1,$2,$3,NULL)`,
      [aid, CONV, GENIUS],
    );
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("② payload 없는 과거 답변 거절", res.status === 400);
  }

  // ── ③ 질문로그 결속: 0행 / N행 / forged ───────────────────────────────────
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer", logs: [] });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("③ 질문로그 0행이면 fail-close(400)", res.status === 400 && (await rowsFor(aid)).length === 0,
      `status=${res.status}`);
  }
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer",
      logs: [{ matchPath: "rag" }, { matchPath: "rag" }] });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("③ 질문로그 N행(모호)이면 fail-close(400)", res.status === 400 && (await rowsFor(aid)).length === 0,
      `status=${res.status}`);
  }
  {
    // forged: 로그는 있는데 **남의 것**이다. user_id 를 안 걸면 이게 통과한다.
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer",
      logs: [{ matchPath: "rag", userId: OTHER }] });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("③ 타인 질문로그로는 결속 불가(400)", res.status === 400 && (await rowsFor(aid)).length === 0,
      `status=${res.status}`);
  }
  {
    // picker 흐름 재현: 같은 질문 쪽지로 player_picker 로그 + 최종 rag 로그가 둘 다 남는다.
    // match_path 로 갈리므로 rag 답변은 정상 결속되어야 한다(UNIQUE(qid) 였다면 여기서 깨진다).
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer",
      logs: [{ matchPath: "player_picker" }, { matchPath: "rag" }] });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("③ picker 재처리(로그 2행·경로 상이)도 정상 결속", res.status === 200 && (await rowsFor(aid)).length === 1,
      `status=${res.status}`);
  }

  // ── ④ 소유권 ─────────────────────────────────────────────────────────────
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer", conv: OTHER_CONV });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("④ 남의 대화 답변에는 403", res.status === 403 && (await rowsFor(aid)).length === 0,
      `status=${res.status}`);
  }
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer", sender: OWNER });
    const res = await post(aid, { desired: 1, expectedPrev: null });
    ok("④ 봇 발신이 아니면 403", res.status === 403, `status=${res.status}`);
  }
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    const res = await post(aid, { desired: 1, expectedPrev: null }, null);
    ok("④ 비로그인 401", res.status === 401, `status=${res.status}`);
  }

  // ── ⑤ CAS ────────────────────────────────────────────────────────────────
  //
  // ⚠️ **동시성 검증의 한계를 먼저 밝힌다** (삼순 4차 P0 대응 중 실측으로 자체 발견):
  //    PGlite 는 쿼리를 **직렬화**한다. `Promise.all` 로 8회를 던져도 실제로는 순차 실행이라
  //    경합 창이 열리지 않는다. 실측: `pg_sleep(0.2)` 4개 병렬 → 803ms (병렬이면 ~200ms).
  //    Supabase Management API 도 마찬가지였다 (`pg_sleep(0.5)` 4개 → 1,468ms).
  //    즉 **타이밍 기반 경합 재현은 이 환경에서 불가능하다.** 그래서 직전 게이트의
  //    "병렬 8회"는 lock 을 제거해도 GREEN 이었다(검출력 0). 그걸 그대로 두면
  //    "동시성을 검증했다"는 거짓 주장이 된다.
  //
  //    대신 **결정론적으로** 검증한다:
  //      (a) 재전송 멱등 — 순차 반복도 표를 뒤집지 않아야 한다 (CAS 분기 자체의 계약)
  //      (b) advisory lock 이 **실제로 획득되는가** — pg_locks 를 직접 읽는다.
  //          정규식으로 소스에 문자열이 있는지 보는 것과 달리, 이건 함수가 그 lock 을
  //          진짜로 잡았을 때만 통과한다.
  //      (c) stale 충돌 — 아래 (c) 블록
  //
  // (a) 동일 set 반복 8회 → 정확히 1행, rating 유지 (재전송이 표를 뒤집지 않는다)
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(aid, { desired: 1, expectedPrev: null })),
    );
    const rows = await rowsFor(aid);
    ok("⑤ 동일 set 반복 8회 → 정확히 1행", rows.length === 1 && Number(rows[0]!.rating) === 1,
      `rows=${rows.length} rating=${rows[0]?.rating}`);
    ok("⑤ 동일 set 반복 8회 전부 200(멱등)",
      results.every((r) => r.status === 200), results.map((r) => r.status).join(","));

    // (b) 동일 clear 반복 8회 → 0행
    const cleared = await Promise.all(
      Array.from({ length: 8 }, () => post(aid, { desired: null, expectedPrev: 1 })),
    );
    const after = await rowsFor(aid);
    ok("⑤ 동일 clear 반복 8회 → 0행", after.length === 0, `rows=${after.length}`);
    ok("⑤ 동일 clear 반복 8회 전부 200(멱등)",
      cleared.every((r) => r.status === 200), cleared.map((r) => r.status).join(","));
  }

  // (b-2) **advisory lock 실제 획득 검증** — 소스 정규식이 아니라 pg_locks 실측.
  //
  // xact 단위 lock 이므로 같은 트랜잭션 안에서 RPC 를 호출한 직후 pg_locks 에
  // 그 키의 advisory lock 이 보여야 한다. lock 을 제거한 변종에서는 0행이 되어 RED.
  // 키는 migration 과 **같은 식**으로 계산한다(값을 여기서 재구현하지 않고 SQL 로 동일 산식).
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    await db.query("BEGIN");
    try {
      await db.query(
        `SELECT set_baseball_genius_answer_feedback($1::uuid,$2::bigint,$3::bigint,
           (SELECT id FROM genius_question_logs WHERE question_message_id=$3::bigint LIMIT 1),
           'rag','answer',1::smallint,NULL::smallint)`,
        [OWNER, aid, qid],
      );
      const locks = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND ((classid::bigint << 32) | objid::bigint)
                = hashtextextended($1 || ':' || $2, 0)`,
        [OWNER, String(aid)],
      );
      ok("⑤ advisory lock 을 실제로 획득한다(pg_locks 실측)",
        Number(locks.rows[0]?.n ?? 0) >= 1,
        `pg_locks rows=${locks.rows[0]?.n}`);
    } finally {
      await db.query("ROLLBACK");
    }
  }
  // (c) stale opposite-state: 다른 탭이 -1 로 바꾼 뒤, 낡은 화면이 "1 이었지" 하고 취소 시도.
  //     직전 구현은 여기서 DELETE 0행인데도 성공 NULL 을 돌려줘 UI 와 DB 가 갈라졌다.
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "dictionary", replyKind: "answer" });
    await post(aid, { desired: -1, expectedPrev: null });
    const stale = await post(aid, { desired: null, expectedPrev: 1 });
    const body = (await stale.json()) as { rating?: unknown; conflict?: boolean };
    const rows = await rowsFor(aid);
    ok("⑤ stale 취소는 409", stale.status === 409, `status=${stale.status}`);
    ok("⑤ stale 취소가 DB 를 바꾸지 않음", rows.length === 1 && Number(rows[0]!.rating) === -1,
      JSON.stringify(rows));
    ok("⑤ 409 응답이 **실제** 상태를 준다(-1)", body.rating === -1, JSON.stringify(body));
  }
  // (d) 정상 전이 — 내가 보던 값에서 반대로
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    await post(aid, { desired: 1, expectedPrev: null });
    const flip = await post(aid, { desired: -1, expectedPrev: 1 });
    const rows = await rowsFor(aid);
    ok("⑤ 👍→👎 정상 전이 200", flip.status === 200 && Number(rows[0]?.rating) === -1,
      `status=${flip.status} rating=${rows[0]?.rating}`);
  }
  // (e) desired 값 검증
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    const bad = await post(aid, { desired: 0, expectedPrev: null });
    ok("⑤ desired=0 은 400", bad.status === 400, `status=${bad.status}`);
  }

  // ── ⑥ GET 복원 ───────────────────────────────────────────────────────────
  {
    const qid = id++, aid = id++;
    await seed({ qid, aid, matchPath: "rag", replyKind: "answer" });
    await post(aid, { desired: -1, expectedPrev: null });
    const res = await route.GET(authed(
      `http://localhost/api/baseball-qa/feedback?answerMessageIds=${aid}`, OWNER_TOKEN));
    const body = (await res.json()) as { ratings?: Record<string, number> };
    ok("⑥ 본인 표 복원", res.status === 200 && body.ratings?.[String(aid)] === -1, JSON.stringify(body));

    const otherRes = await route.GET(authed(
      `http://localhost/api/baseball-qa/feedback?answerMessageIds=${aid}`, OTHER_TOKEN));
    const otherBody = (await otherRes.json()) as { ratings?: Record<string, number> };
    ok("⑥ 타인 표는 안 보인다", Object.keys(otherBody.ratings ?? {}).length === 0, JSON.stringify(otherBody));
  }

  // ── FK 무결성: 질문로그가 지워지면 표도 사라진다 ─────────────────────────
  {
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM genius_answer_feedback`);
    await db.query(`DELETE FROM genius_question_logs WHERE match_path='dictionary'`);
    const after = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM genius_answer_feedback`);
    ok("③ 질문로그 삭제 시 표도 CASCADE", (after.rows[0]!.n) < (before.rows[0]!.n),
      `${before.rows[0]!.n} → ${after.rows[0]!.n}`);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} genius-feedback-db-route-integration: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("❌ genius-feedback-db-route-integration CRASHED:", (error as Error).message);
  process.exit(1);
});
