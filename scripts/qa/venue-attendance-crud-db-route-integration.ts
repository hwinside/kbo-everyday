/**
 * 직관 기록 CRUD — 실제 route + 실제 PostgreSQL(PGlite 17) 통합 회귀.
 *
 * ⚠️ 이 파일이 존재하는 이유(삼순 P0-2):
 *   기존 `venue-attendance-smoke.ts` 의 소유권·집계 검증은 **소스 문자열 정규식**이었다.
 *   `row.user_id !== userId` 를 `false && ...` 로 무력화해도 그 스모크는 PASS 한다
 *   (문자열은 그대로 남아 있으므로). 즉 타인 원장 삭제/수정이 열려도 전체가 초록이었다.
 *
 *   여기서는 supabase-js 를 PGlite 로 갈아끼우고, **production route 핸들러를 그대로 호출**해
 *   HTTP status·DB 행·통계 payload 를 실제 값으로 고정한다. 가드를 지우면 반드시 RED 다.
 *
 * 실행: npm run qa:venue-attendance-crud:db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://venue-attendance-crud-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** 2026 종료 경기 3종(직접 등록 허용 조건) + 1종은 미종료(scheduled). */
const GAME_A = "20260614LGOB0"; // LG(원정) 5 : 3 OB(홈)
const GAME_B = "20260615LGHH0"; // LG(원정) 2 : 4 HH(홈)
const GAME_C = "20260616LGKT0"; // LG(원정) 3 : 3 KT(홈)
const GAME_SCHEDULED = "20260617LGSS0";

const LG = 1;
const OB = 2;
const SS = 8;

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

function migration(name: string): string {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

// ── KBO 경기목록 raw 스텁 ────────────────────────────────────────────────────
interface StubGame {
  gameId: string;
  date: string;
  stadium: string;
  awayCode: string;
  homeCode: string;
  awayName: string;
  homeName: string;
  awayScore: string;
  homeScore: string;
  state: string; // "3"=final
}

const STUB_GAMES: StubGame[] = [
  {
    gameId: GAME_A, date: "20260614", stadium: "잠실",
    awayCode: "LG", homeCode: "OB", awayName: "LG", homeName: "두산",
    awayScore: "5", homeScore: "3", state: "3",
  },
  {
    gameId: GAME_B, date: "20260615", stadium: "대전",
    awayCode: "LG", homeCode: "HH", awayName: "LG", homeName: "한화",
    awayScore: "2", homeScore: "4", state: "3",
  },
  {
    gameId: GAME_C, date: "20260616", stadium: "수원",
    awayCode: "LG", homeCode: "KT", awayName: "LG", homeName: "KT",
    awayScore: "3", homeScore: "3", state: "3",
  },
  {
    gameId: GAME_SCHEDULED, date: "20260617", stadium: "대구",
    awayCode: "LG", homeCode: "SS", awayName: "LG", homeName: "삼성",
    awayScore: "0", homeScore: "0", state: "1",
  },
];

function rawGame(g: StubGame) {
  return {
    G_ID: g.gameId, G_DT: g.date, G_TM: "18:30", S_NM: g.stadium,
    AWAY_ID: g.awayCode, HOME_ID: g.homeCode, AWAY_NM: g.awayName, HOME_NM: g.homeName,
    T_SCORE_CN: g.awayScore, B_SCORE_CN: g.homeScore,
    GAME_INN_NO: 9, GAME_TB_SC: "B", GAME_STATE_SC: g.state, CANCEL_SC_ID: "0",
    T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
    STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
    B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
    B_P_NM: "", T_P_NM: "", T_RANK_NO: 1, B_RANK_NO: 2,
  };
}

function installFetchStub() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("GetKboGameList")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { date?: string };
      const games = STUB_GAMES.filter((g) => g.date === body.date).map(rawGame);
      return new Response(JSON.stringify({ game: games }), { status: 200 });
    }
    // 그 외(스코어보드·Naver·standings 등)는 실패 처리 — 이 회귀의 관심 밖.
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
}

// ── supabase-js → PGlite 어댑터 ──────────────────────────────────────────────
type Row = Record<string, unknown>;

interface Filter {
  column: string;
  op: "eq" | "in" | "is_null" | "gte" | "lt";
  value?: unknown;
}

/**
 * PGlite 는 date/timestamptz 를 JS Date 로 돌려주지만 PostgREST 는 JSON 문자열로 준다.
 * route 가 `game_date.replaceAll(...)` 같은 문자열 계약을 쓰므로 실제 응답 shape 로 맞춘다.
 * (이걸 안 맞추면 회귀가 production 과 다른 타입을 검증하게 된다.)
 */
function toPostgrestJson(value: unknown, column: string): unknown {
  if (!(value instanceof Date)) return value;
  return column.endsWith("_date")
    ? value.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
    : value.toISOString();
}

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[key] = toPostgrestJson(value, key);
  return out;
}

/**
 * route 가 실제로 쓰는 PostgREST 빌더 모양만 지원한다.
 * 지원: select/update + eq/in/is(null)/gte/lt/order/limit/range/maybeSingle.
 */
function makeQueryBuilder(db: PGlite, table: string) {
  const filters: Filter[] = [];
  let mode: "select" | "update" = "select";
  let selectColumns = "*";
  let updateValues: Row | null = null;
  let orderBy: { column: string; ascending: boolean } | null = null;
  let limitCount: number | null = null;
  let rangeBounds: { from: number; to: number } | null = null;
  let single = false;

  function whereSql(params: unknown[]): string {
    const parts: string[] = [];
    for (const f of filters) {
      if (f.op === "is_null") {
        parts.push(`${f.column} IS NULL`);
        continue;
      }
      if (f.op === "in") {
        const values = f.value as unknown[];
        if (values.length === 0) {
          parts.push("false");
          continue;
        }
        const placeholders = values.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        parts.push(`${f.column} IN (${placeholders.join(", ")})`);
        continue;
      }
      params.push(f.value);
      const sqlOp = f.op === "eq" ? "=" : f.op === "gte" ? ">=" : "<";
      parts.push(`${f.column} ${sqlOp} $${params.length}`);
    }
    return parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  }

  async function run(): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      const params: unknown[] = [];
      let sql: string;
      if (mode === "update") {
        const entries = Object.entries(updateValues ?? {});
        const sets = entries.map(([k, v]) => {
          params.push(v);
          return `${k} = $${params.length}`;
        });
        sql = `UPDATE ${table} SET ${sets.join(", ")} ${whereSql(params)}`;
        if (selectColumns !== "*" || single) sql += ` RETURNING ${selectColumns}`;
      } else {
        sql = `SELECT ${selectColumns} FROM ${table} ${whereSql(params)}`;
        if (orderBy) sql += ` ORDER BY ${orderBy.column} ${orderBy.ascending ? "ASC" : "DESC"}`;
        if (rangeBounds) {
          sql += ` LIMIT ${rangeBounds.to - rangeBounds.from + 1} OFFSET ${rangeBounds.from}`;
        } else if (limitCount != null) {
          sql += ` LIMIT ${limitCount}`;
        }
      }
      const result = await db.query<Row>(sql, params);
      const rows = (result.rows ?? []).map(normalizeRow);
      if (single) return { data: rows[0] ?? null, error: null };
      if (mode === "update" && selectColumns === "*") return { data: null, error: null };
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  }

  const builder: Record<string, unknown> = {
    select(columns?: string) {
      selectColumns = columns && columns.trim() !== "" ? columns : "*";
      return builder;
    },
    update(values: Row) {
      mode = "update";
      updateValues = values;
      selectColumns = "*";
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push({ column, op: "eq", value });
      return builder;
    },
    in(column: string, value: unknown[]) {
      filters.push({ column, op: "in", value });
      return builder;
    },
    is(column: string, value: unknown) {
      assert.equal(value, null, "is() 는 null 비교만 지원");
      filters.push({ column, op: "is_null" });
      return builder;
    },
    gte(column: string, value: unknown) {
      filters.push({ column, op: "gte", value });
      return builder;
    },
    lt(column: string, value: unknown) {
      filters.push({ column, op: "lt", value });
      return builder;
    },
    order(column: string, opts?: { ascending?: boolean }) {
      orderBy = { column, ascending: opts?.ascending !== false };
      return builder;
    },
    limit(count: number) {
      limitCount = count;
      return builder;
    },
    range(from: number, to: number) {
      rangeBounds = { from, to };
      return builder;
    },
    maybeSingle() {
      single = true;
      return run();
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return run().then(onFulfilled, onRejected);
    },
  };
  return builder;
}

async function installSupabaseShim(db: PGlite) {
  const adminModule = await import("../../src/lib/supabase/admin");
  const client = adminModule.supabaseAdmin as unknown as {
    auth: { getUser: (token: string) => Promise<unknown> };
    from: (table: string) => unknown;
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };

  client.auth.getUser = async (token: string) => {
    const userId = token === "owner-token" ? OWNER : token === "other-token" ? OTHER : null;
    return userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: "invalid token" } };
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

function idContext(id: string | number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

interface AttendanceApi {
  GET: (req: NextRequest) => Promise<Response>;
  POST: (req: NextRequest) => Promise<Response>;
}
interface AttendanceItemApi {
  PATCH: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  DELETE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
}

async function loadRoutes(): Promise<{ list: AttendanceApi; item: AttendanceItemApi }> {
  const list = (await import(
    "../../src/app/api/me/venue-attendance/route"
  )) as unknown as AttendanceApi;
  const item = (await import(
    "../../src/app/api/me/venue-attendance/[id]/route"
  )) as unknown as AttendanceItemApi;
  return { list, item };
}

interface DiaryBody {
  diaryGameCount: number;
  overallSummary: { attendanceCount: number; wins: number; losses: number; draws: number; winRate: number | null };
  summary: { attendanceCount: number };
  games: Array<{ id: number; gameId: string; source: string; result: string | null }>;
}

async function diaryOf(list: AttendanceApi, token: string): Promise<DiaryBody> {
  const res = await list.GET(
    authed("http://localhost/api/me/venue-attendance?season=2026", token),
  );
  assert.equal(res.status, 200, "본인 다이어리 조회 200");
  return (await res.json()) as DiaryBody;
}

interface StatsBody {
  overall: { state: string; coverage: { attendanceGames: number; finalGames: number } };
  gps: { state: string; coverage: { attendanceGames: number } };
}

async function statsOf(token: string): Promise<StatsBody> {
  const { GET } = await import("../../src/app/api/me/venue-stats/route");
  const res = await GET(authed("http://localhost/api/me/venue-stats?season=2026", token));
  assert.equal(res.status, 200, "본인 통계 조회 200");
  return (await res.json()) as StatsBody;
}

async function countRows(db: PGlite, where: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM venue_attendance WHERE ${where}`,
    params,
  );
  return r.rows[0]?.n ?? 0;
}

async function main() {
  installFetchStub();

  const db = new PGlite();
  await db.waitReady;
  const version = await db.query<{ server_version: string }>("SHOW server_version");
  ok("PostgreSQL 17에서 실행", /^17\./.test(version.rows[0]!.server_version), version.rows[0]!.server_version);

  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${OTHER}');
    CREATE TABLE profiles (
      id uuid PRIMARY KEY, team_id int, favorite_players jsonb DEFAULT '[]'::jsonb
    );
    INSERT INTO profiles (id, team_id) VALUES ('${OWNER}', ${LG}), ('${OTHER}', ${LG});
    -- 통계 route 가 조회하는 보조 테이블(이 회귀에서는 빈 상태로 충분).
    CREATE TABLE player_game_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kbo_id text, player_type text, game_id text, game_date date, team_id int,
      team_code text, opponent_team_id int, is_home boolean, result text,
      ab int, h int, hr int, rbi int, bb int, so int,
      ip_outs int, er int, h_allowed int, k int, bb_allowed int
    );
    CREATE TABLE player_game_log_ingestions (
      game_id text PRIMARY KEY, status text,
      expected_row_count int, expected_payload_hash text
    );
    CREATE TABLE player_stats_batter (
      kbo_id text PRIMARY KEY, team text, games int, ab int, hits int, hr int, rbi int,
      updated_at timestamptz
    );
    CREATE TABLE player_stats_pitcher (
      kbo_id text PRIMARY KEY, team text, games int, ip text, h int, er int, so int,
      updated_at timestamptz
    );
  `);
  await db.exec(migration("20260718_venue_stories.sql"));
  await db.exec(migration("20260721_venue_attendance.sql"));
  await db.exec(migration("20260726_venue_stories_archive.sql"));
  await db.exec(migration("20260727_venue_diary_manual_upload.sql"));
  await db.exec(migration("20260802193000_venue_attendance_crud.sql"));
  ok("실제 migration 적용(venue_stories → attendance → manual → CRUD)", true);

  await installSupabaseShim(db);
  const { list, item } = await loadRoutes();

  // ── 0) 인증 게이트 ─────────────────────────────────────────────────────────
  {
    const anon = await list.GET(authed("http://localhost/api/me/venue-attendance", null));
    ok("비로그인 다이어리 조회 401", anon.status === 401, `status=${anon.status}`);
    const anonPost = await list.POST(
      authed("http://localhost/api/me/venue-attendance", null, {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_A, favoriteTeamId: LG }),
      }),
    );
    ok("비로그인 직접 등록 401", anonPost.status === 401, `status=${anonPost.status}`);
  }

  // ── 1) 직접 등록 생성 → 통계 즉시 반영 ─────────────────────────────────────
  const created = await list.POST(
    authed("http://localhost/api/me/venue-attendance", "owner-token", {
      method: "POST",
      body: JSON.stringify({ gameId: GAME_A, favoriteTeamId: LG }),
    }),
  );
  const createdBody = (await created.json()) as { id: number; source: string };
  ok("직접 등록 생성 200", created.status === 200, `status=${created.status}`);
  ok("생성 source=diary_manual", createdBody.source === "diary_manual");

  {
    const diary = await diaryOf(list, "owner-token");
    ok("생성 직후 다이어리 1경기", diary.diaryGameCount === 1, `count=${diary.diaryGameCount}`);
    ok(
      "LG 원정 5:3 승 → overall 1승",
      diary.overallSummary.wins === 1 && diary.overallSummary.winRate === 1,
      JSON.stringify(diary.overallSummary),
    );
    ok(
      "GPS 인증 직관수는 0 유지(직접 등록은 인증 아님)",
      diary.summary.attendanceCount === 0,
      `certified=${diary.summary.attendanceCount}`,
    );
    const stats = await statsOf("owner-token");
    ok(
      "통계 overall 즉시 1경기 반영",
      stats.overall.coverage.attendanceGames === 1,
      JSON.stringify(stats.overall.coverage),
    );
    ok("통계 gps scope 는 0경기", stats.gps.coverage.attendanceGames === 0);
  }

  // ── 2) 종료되지 않은 경기·참가팀 아닌 응원팀은 등록 거부 ────────────────────
  {
    const notFinal = await list.POST(
      authed("http://localhost/api/me/venue-attendance", "owner-token", {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_SCHEDULED, favoriteTeamId: LG }),
      }),
    );
    ok("미종료 경기 직접 등록 403", notFinal.status === 403, `status=${notFinal.status}`);
    const wrongTeam = await list.POST(
      authed("http://localhost/api/me/venue-attendance", "owner-token", {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_B, favoriteTeamId: SS }),
      }),
    );
    ok("비참가팀 응원팀 등록 403", wrongTeam.status === 403, `status=${wrongTeam.status}`);
    ok(
      "거부된 등록은 DB 행을 만들지 않음",
      (await countRows(db, "user_id = $1", [OWNER])) === 1,
    );
  }

  // ── 3) 타인 원장 수정·삭제 403 (⚠️ 소스 정규식이 아니라 실제 status) ───────
  {
    const patch = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "other-token", {
        method: "PATCH",
        body: JSON.stringify({ favoriteTeamId: OB }),
      }),
      idContext(createdBody.id),
    );
    ok("타인 PATCH 403", patch.status === 403, `status=${patch.status}`);
    const del = await item.DELETE(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "other-token", {
        method: "DELETE",
      }),
      idContext(createdBody.id),
    );
    ok("타인 DELETE 403", del.status === 403, `status=${del.status}`);
    const alive = await db.query<{ deleted_at: string | null; favorite_team_id_snapshot: number }>(
      "SELECT deleted_at, favorite_team_id_snapshot FROM venue_attendance WHERE id = $1",
      [createdBody.id],
    );
    ok(
      "타인 요청 뒤에도 원장 무변경(삭제 안 됨·팀 그대로)",
      alive.rows[0]!.deleted_at === null && alive.rows[0]!.favorite_team_id_snapshot === LG,
      JSON.stringify(alive.rows[0]),
    );
    const otherDiary = await diaryOf(list, "other-token");
    ok("타인 다이어리에는 owner 경기 없음", otherDiary.games.length === 0);
  }

  // ── 4) 응원팀 수정 → 승패 반전이 통계까지 ──────────────────────────────────
  {
    const patch = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ favoriteTeamId: OB }),
      }),
      idContext(createdBody.id),
    );
    ok("본인 응원팀 수정 200", patch.status === 200, `status=${patch.status}`);
    const diary = await diaryOf(list, "owner-token");
    ok(
      "두산 기준으로 5:3 패배 반영",
      diary.overallSummary.losses === 1 && diary.overallSummary.wins === 0,
      JSON.stringify(diary.overallSummary),
    );
  }

  // ── 5) 경기 자체 변경(P0-1) ────────────────────────────────────────────────
  {
    // 먼저 archived 사진이 attendance A를 만든 상태에서 같은 경기의 pending 영상을 둔다.
    // 이동 뒤 이 영상이 archived 되더라도 원래 경기 A가 다시 살아나면 안 된다.
    const manualMedia = await db.query<{ id: number }>(
      `INSERT INTO venue_stories
         (game_id, user_id, media_type, media_url, media_bucket, media_path,
          status, expires_at, attendance_source, favorite_team_id_snapshot,
          game_date, stadium_name, venue_verified)
       VALUES
         ($1, $2, 'image', 'https://cdn.example/manual-a.jpg', 'venue-media',
          'photos/venue-stories/manual-a.jpg', 'archived', now() + interval '7 days',
          'diary_manual', $3, $4, '잠실', false),
         ($1, $2, 'video', 'https://cdn.example/manual-a.mp4', 'venue-media',
          'videos/venue-stories/manual-a.mp4', 'pending', now() + interval '7 days',
          'diary_manual', $3, $4, '잠실', false)
       RETURNING id`,
      [GAME_A, OWNER, LG, "2026-06-14"],
    );
    const pendingMediaId = manualMedia.rows[1]!.id;

    const moveWrongTeam = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_B, favoriteTeamId: OB }),
      }),
      idContext(createdBody.id),
    );
    ok(
      "이동 대상 경기 참가팀이 아니면 403(이동 후 기준 검증)",
      moveWrongTeam.status === 403,
      `status=${moveWrongTeam.status}`,
    );
    const stillA = await db.query<{ game_id: string }>(
      "SELECT game_id FROM venue_attendance WHERE id = $1",
      [createdBody.id],
    );
    ok("거부된 이동은 경기를 바꾸지 않음", stillA.rows[0]!.game_id === GAME_A);

    const moveScheduled = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_SCHEDULED, favoriteTeamId: LG }),
      }),
      idContext(createdBody.id),
    );
    ok("미종료 경기로 이동 403", moveScheduled.status === 403, `status=${moveScheduled.status}`);

    const moved = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_B, favoriteTeamId: LG }),
      }),
      idContext(createdBody.id),
    );
    ok("본인 경기 변경 200", moved.status === 200, `status=${moved.status}`);
    const row = await db.query<{ game_id: string; game_date: string; stadium_name: string }>(
      "SELECT game_id, game_date::text, stadium_name FROM venue_attendance WHERE id = $1",
      [createdBody.id],
    );
    ok(
      "경기 변경이 game_id·경기일·구장을 서버 해석값으로 갱신",
      row.rows[0]!.game_id === GAME_B &&
        row.rows[0]!.game_date === "2026-06-15" &&
        row.rows[0]!.stadium_name === "대전",
      JSON.stringify(row.rows[0]),
    );
    ok(
      "경기 변경은 행을 늘리지 않음(이동이지 신규 생성 아님)",
      (await countRows(db, "user_id = $1 AND deleted_at IS NULL", [OWNER])) === 1,
    );

    await db.query(
      `UPDATE venue_stories
          SET status = 'archived', archived_at = now()
        WHERE id = $1`,
      [pendingMediaId],
    );
    ok(
      "원경기 pending 수동 영상이 terminal 되어도 active 기록은 대상 1건만",
      (await countRows(db, "user_id = $1 AND deleted_at IS NULL", [OWNER])) === 1,
    );
    const sourceTombstone = await db.query<{ source: string; deleted_at: string | null }>(
      `SELECT source, deleted_at
         FROM venue_attendance
        WHERE user_id = $1 AND game_id = $2`,
      [OWNER, GAME_A],
    );
    ok(
      "원경기에는 GPS 승격 가능한 diary_manual tombstone 유지",
      sourceTombstone.rows[0]?.source === "diary_manual" &&
        sourceTombstone.rows[0]?.deleted_at != null,
      JSON.stringify(sourceTombstone.rows[0]),
    );
    const diary = await diaryOf(list, "owner-token");
    ok(
      "원경기 미디어 terminal 뒤에도 변경된 경기만 다이어리 반영",
      diary.games.length === 1 &&
        diary.games[0]!.gameId === GAME_B &&
        diary.overallSummary.losses === 1,
      JSON.stringify(diary.overallSummary),
    );
    const stats = await statsOf("owner-token");
    ok(
      "원경기 미디어 terminal 뒤 venue-stats도 대상 1경기",
      stats.overall.coverage.attendanceGames === 1,
      JSON.stringify(stats.overall.coverage),
    );

    // 뒤 GPS fixture의 미디어 개수 검증과 격리한다. attendance tombstone은 유지한다.
    await db.query(
      "DELETE FROM venue_stories WHERE id = ANY($1::bigint[])",
      [manualMedia.rows.map((row) => row.id)],
    );
  }

  // ── 6) 중복 경기 이동 차단 ─────────────────────────────────────────────────
  {
    const second = await list.POST(
      authed("http://localhost/api/me/venue-attendance", "owner-token", {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_C, favoriteTeamId: LG }),
      }),
    );
    const secondBody = (await second.json()) as { id: number };
    ok("두 번째 경기 직접 등록 200", second.status === 200);

    const dup = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${secondBody.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_B, favoriteTeamId: LG }),
      }),
      idContext(secondBody.id),
    );
    ok("이미 기록한 경기로 이동 409", dup.status === 409, `status=${dup.status}`);
    ok(
      "중복 차단 뒤에도 두 기록 모두 살아있음",
      (await countRows(db, "user_id = $1 AND deleted_at IS NULL", [OWNER])) === 2,
    );

    // 정리: 두 번째 기록은 이후 케이스에 영향 없도록 삭제
    const del = await item.DELETE(
      authed(`http://localhost/api/me/venue-attendance/${secondBody.id}`, "owner-token", {
        method: "DELETE",
      }),
      idContext(secondBody.id),
    );
    ok("본인 기록 삭제 200", del.status === 200);
  }

  // ── 7) 삭제 → 통계 제외 → 같은 경기 재등록 ─────────────────────────────────
  {
    const beforeDelete = await diaryOf(list, "owner-token");
    ok("삭제 전 1경기", beforeDelete.diaryGameCount === 1, `count=${beforeDelete.diaryGameCount}`);

    const del = await item.DELETE(
      authed(`http://localhost/api/me/venue-attendance/${createdBody.id}`, "owner-token", {
        method: "DELETE",
      }),
      idContext(createdBody.id),
    );
    ok("직접 등록 기록 삭제 200", del.status === 200);
    const afterDelete = await diaryOf(list, "owner-token");
    ok("삭제 즉시 다이어리 0경기", afterDelete.diaryGameCount === 0);
    ok(
      "삭제 즉시 승률 표본도 사라짐",
      afterDelete.overallSummary.attendanceCount === 0 &&
        afterDelete.overallSummary.winRate === null,
      JSON.stringify(afterDelete.overallSummary),
    );
    const stats = await statsOf("owner-token");
    ok(
      "삭제 즉시 통계 overall 0경기",
      stats.overall.coverage.attendanceGames === 0 && stats.overall.state === "empty",
      JSON.stringify(stats.overall.coverage),
    );
    ok(
      "soft-delete tombstone 은 DB에 남는다(GPS 재생성 방지)",
      (await countRows(db, "user_id = $1 AND deleted_at IS NOT NULL", [OWNER])) === 3,
    );

    const again = await list.POST(
      authed("http://localhost/api/me/venue-attendance", "owner-token", {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_B, favoriteTeamId: LG }),
      }),
    );
    ok("삭제한 경기 재등록 200", again.status === 200, `status=${again.status}`);
    const reBody = (await again.json()) as { id: number };
    ok("재등록은 같은 원장 행 복원(중복 행 생성 아님)", reBody.id === createdBody.id);
    const afterRe = await diaryOf(list, "owner-token");
    ok(
      "재등록 즉시 통계 복귀",
      afterRe.diaryGameCount === 1 && afterRe.overallSummary.losses === 1,
      JSON.stringify(afterRe.overallSummary),
    );
  }

  // ── 8) GPS 기록: 수정 불가 · 삭제 가능 · 미디어 불변 ───────────────────────
  {
    // 실제 GPS story trigger가 이동 시 남긴 diary_manual tombstone을 인증 기록으로 승격한다.
    // 이 경로가 막히면 원경기 재생성 차단과 함께 정상 GPS 인증까지 잃는 회귀다.
    await db.query(
      `INSERT INTO venue_stories
         (game_id, user_id, media_type, media_url, media_bucket, media_path,
          status, expires_at, attendance_source, favorite_team_id_snapshot,
          game_date, venue_verified)
       VALUES ($1, $2, 'image', 'https://cdn.example/a.jpg', 'venue-media',
               'photos/venue-stories/a.jpg', 'active', now() + interval '1 day',
               'story_geofence', $3, $4, true)`,
      [GAME_A, OWNER, LG, "2026-06-14"],
    );
    const gps = await db.query<{ id: number; source: string; deleted_at: string | null }>(
      `SELECT id, source, deleted_at
         FROM venue_attendance
        WHERE user_id = $1 AND game_id = $2`,
      [OWNER, GAME_A],
    );
    const gpsId = gps.rows[0]!.id;
    ok(
      "실제 GPS 인증은 원경기 tombstone을 story_geofence로 승격",
      gps.rows[0]!.source === "story_geofence" && gps.rows[0]!.deleted_at === null,
      JSON.stringify(gps.rows[0]),
    );

    // 미디어 원본 — 삭제 후에도 반드시 남아야 한다.
    const mediaBefore = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM venue_stories WHERE user_id = $1",
      [OWNER],
    );

    const patch = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${gpsId}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ favoriteTeamId: OB }),
      }),
      idContext(gpsId),
    );
    ok("GPS 기록 응원팀 수정 403", patch.status === 403, `status=${patch.status}`);
    const move = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${gpsId}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_C, favoriteTeamId: LG }),
      }),
      idContext(gpsId),
    );
    ok("GPS 기록 경기 변경 403", move.status === 403, `status=${move.status}`);
    const untouched = await db.query<{ game_id: string; favorite_team_id_snapshot: number }>(
      "SELECT game_id, favorite_team_id_snapshot FROM venue_attendance WHERE id = $1",
      [gpsId],
    );
    ok(
      "GPS 기록 원장 무변경",
      untouched.rows[0]!.game_id === GAME_A && untouched.rows[0]!.favorite_team_id_snapshot === LG,
    );

    const beforeGpsDelete = await diaryOf(list, "owner-token");
    ok(
      "GPS 인증 직관수 1 집계",
      beforeGpsDelete.summary.attendanceCount === 1,
      `certified=${beforeGpsDelete.summary.attendanceCount}`,
    );

    const del = await item.DELETE(
      authed(`http://localhost/api/me/venue-attendance/${gpsId}`, "owner-token", {
        method: "DELETE",
      }),
      idContext(gpsId),
    );
    ok("GPS 기록 삭제 200", del.status === 200, `status=${del.status}`);
    const afterGpsDelete = await diaryOf(list, "owner-token");
    ok(
      "GPS 삭제 즉시 인증 직관수 0",
      afterGpsDelete.summary.attendanceCount === 0,
      `certified=${afterGpsDelete.summary.attendanceCount}`,
    );
    const mediaAfter = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM venue_stories WHERE user_id = $1",
      [OWNER],
    );
    ok(
      "GPS 기록 삭제가 사진·영상을 지우지 않음",
      mediaAfter.rows[0]!.n === mediaBefore.rows[0]!.n && mediaAfter.rows[0]!.n === 1,
      `before=${mediaBefore.rows[0]!.n} after=${mediaAfter.rows[0]!.n}`,
    );
  }

  // ── 9) GPS ↔ 직접등록 출처 위조 차단 ───────────────────────────────────────
  {
    const conflict = await list.POST(
      authed("http://localhost/api/me/venue-attendance", "owner-token", {
        method: "POST",
        body: JSON.stringify({ gameId: GAME_A, favoriteTeamId: LG }),
      }),
    );
    ok(
      "삭제된 GPS 경기를 직접 등록으로 되살리기 409(강등 금지)",
      conflict.status === 409,
      `status=${conflict.status}`,
    );
    const source = await db.query<{ source: string }>(
      "SELECT source FROM venue_attendance WHERE user_id = $1 AND game_id = $2",
      [OWNER, GAME_A],
    );
    ok("GPS source 유지", source.rows[0]!.source === "story_geofence");

    const manual = await db.query<{ id: number }>(
      "SELECT id FROM venue_attendance WHERE user_id = $1 AND game_id = $2",
      [OWNER, GAME_B],
    );
    const moveOntoGps = await item.PATCH(
      authed(`http://localhost/api/me/venue-attendance/${manual.rows[0]!.id}`, "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ gameId: GAME_A, favoriteTeamId: LG }),
      }),
      idContext(manual.rows[0]!.id),
    );
    ok(
      "GPS 기록이 있는 경기로 수동 이동 409",
      moveOntoGps.status === 409,
      `status=${moveOntoGps.status}`,
    );
    const afterMove = await db.query<{ source: string; game_id: string }>(
      "SELECT source, game_id FROM venue_attendance WHERE id = $1",
      [manual.rows[0]!.id],
    );
    ok(
      "차단 후 수동 기록도 원래 경기 유지",
      afterMove.rows[0]!.game_id === GAME_B && afterMove.rows[0]!.source === "diary_manual",
    );
  }

  // ── 10) 존재하지 않는 원장 ─────────────────────────────────────────────────
  {
    const missing = await item.DELETE(
      authed("http://localhost/api/me/venue-attendance/999999", "owner-token", {
        method: "DELETE",
      }),
      idContext(999999),
    );
    ok("없는 원장 삭제 404", missing.status === 404, `status=${missing.status}`);
    const badId = await item.PATCH(
      authed("http://localhost/api/me/venue-attendance/abc", "owner-token", {
        method: "PATCH",
        body: JSON.stringify({ favoriteTeamId: LG }),
      }),
      idContext("abc"),
    );
    ok("id 형식 오류 400", badId.status === 400, `status=${badId.status}`);
  }

  console.log(`\n결과: venue-attendance CRUD route+PG 통합 ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
