/**
 * 경기 로그 원장 — **production 오케스트레이터(`ingestGameWithLedger`) 직접 실행** 회귀.
 *
 * 기존 s1a ledger 테스트는 helper 판정과 수동 insert/delete 를 검증한다.
 * 이 스크립트는 실제 오케스트레이터를 PGlite 위에서 그대로 돌려
 * 삼순 P0 경계를 고정한다:
 *
 *   ① GREEN  7/4 rekey — 구 key 교체 후 complete
 *   ② RED    쓰기 중간 실패(RPC 트랜잭션 롤백) → 선수 행 누락 0
 *            → ledger complete 아님 → **재시도 시 complete 로 수렴**
 *   ③ RED    부분 응답(선수 1명 누락) → 삭제 0 · 기존 행 보존
 *   ④ mutation 감지 — 삭제 무력화 / 비원자 분리 쓰기를 소스 가드로 RED
 *
 * ②가 중요한 이유: `/api/player-game-logs`, team-card 주간 집계, venue-attendance 는
 * ledger 를 보지 않고 `player_game_logs` 를 직접 읽는다. 쓰기 중간에 행이 사라지면
 * 그 구간 동안 누락값을 그대로 노출한다 — venue-stats 만 runtime hash 로 fail-close 한다.
 *
 * 실행: npm run qa:game-log-ledger-orchestrator
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KboGame } from "@/lib/crawler/kbo-api";
import type { GameBoxscore } from "@/lib/game-logs/ingest";
import { ingestGameWithLedger } from "@/lib/game-logs/ledger-ingest";
import {
  CANONICAL_ROW_FIELDS,
  verifyLedgerCompleteness,
  type CanonicalRowInput,
  type PlayerResolver,
} from "@/lib/game-logs/completeness";

function migration(name: string) {
  return readFileSync(resolve("supabase/migrations", name), "utf8");
}

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── fixture ────────────────────────────────────────────────────────────────
const GAME = {
  gameId: "20260704HHLG0",
  date: "20260704",
  homeTeamId: 1,
  awayTeamId: 2,
  homeScore: 5,
  awayScore: 3,
  status: "final",
} as unknown as KboGame;

const BOX: GameBoxscore = {
  homeBatters: [
    { name: "홈타자A", ab: 4, hit: 2, hr: 1, rbi: 3, bb: 0, kk: 1 },
    { name: "홈타자B", ab: 3, hit: 0, hr: 0, rbi: 0, bb: 1, kk: 2 },
  ],
  homePitchers: [{ name: "홈투수A", inn: "6.1", er: 2, hit: 5, kk: 7, bb: 1 }],
  awayBatters: [{ name: "원정타자A", ab: 4, hit: 1, hr: 0, rbi: 1, bb: 0, kk: 0 }],
  awayPitchers: [{ name: "원정투수A", inn: "1 ⅔", er: 4, hit: 8, kk: 3, bb: 2 }],
};

/** 부분 응답 — 정상 선수 1명(홈타자B)을 공급자가 빠뜨린 경우. */
const BOX_PARTIAL: GameBoxscore = {
  ...BOX,
  homeBatters: [BOX.homeBatters[0]],
};

/** 테스트 resolver — 이름→고정 kbo_id. 실제 로스터에 의존하지 않게 한다. */
const IDS: Record<string, string> = {
  홈타자A: "90001", 홈타자B: "90002", 홈투수A: "90003",
  원정타자A: "90004", 원정투수A: "90005",
};
const resolver: PlayerResolver = (q) => (IDS[q.name] ? { kboId: IDS[q.name] } : null);

/**
 * PGlite 위에 올린 최소 Supabase client shim.
 * ledger-ingest 가 실제로 쓰는 표면만 구현한다 — select/eq, upsert(ledger), rpc.
 * 이 shim 이 없으면 오케스트레이터를 직접 태울 수 없다.
 */
function makeClient(db: PGlite, opts: { failReconcile?: boolean } = {}) {
  const client = {
    from(table: string) {
      const builder = {
        _filters: [] as Array<[string, unknown]>,
        select() {
          return {
            eq: async (col: string, val: unknown) => {
              const r = await db.query<Record<string, unknown>>(
                `select kbo_id, player_type, game_id, to_char(game_date,'YYYY-MM-DD') as game_date,
                        team_id, team_code, opponent_team_id, is_home, result,
                        ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed
                   from ${table} where ${col} = $1`,
                [val],
              );
              return { data: r.rows, error: null };
            },
          };
        },
        async upsert(row: Record<string, unknown>) {
          // ledger upsert 만 이 경로를 쓴다.
          await db.query(
            `insert into player_game_log_ingestions
               (game_id, game_date, status, expected_row_count, expected_payload_hash,
                persisted_row_count, unresolved_count, source_fetched_at, verified_at,
                failure_reason, updated_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (game_id) do update set
               status=excluded.status, expected_row_count=excluded.expected_row_count,
               expected_payload_hash=excluded.expected_payload_hash,
               persisted_row_count=excluded.persisted_row_count,
               unresolved_count=excluded.unresolved_count,
               source_fetched_at=excluded.source_fetched_at, verified_at=excluded.verified_at,
               failure_reason=excluded.failure_reason, updated_at=excluded.updated_at`,
            [
              row.game_id, row.game_date, row.status, row.expected_row_count,
              row.expected_payload_hash, row.persisted_row_count, row.unresolved_count,
              row.source_fetched_at, row.verified_at, row.failure_reason, row.updated_at,
            ],
          );
          return { error: null };
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (opts.failReconcile) {
        // 쓰기 중간 실패 주입. RPC 는 단일 트랜잭션이므로 삭제도 함께 롤백되어야 한다.
        // 트랜잭션 안에서 예외를 일으켜 실제 롤백 경로를 태운다.
        try {
          await db.query(
            `select public.${fn}($1::text, $2::jsonb, $3::jsonb),
                    (1/0)::int`, // 함수 실행 후 같은 문장에서 실패
            [args.p_game_id, JSON.stringify(args.p_delete_keys), JSON.stringify(args.p_rows)],
          );
        } catch (e) {
          return { data: null, error: { message: String((e as Error).message) } };
        }
        return { data: null, error: { message: "injected failure did not trigger" } };
      }
      const r = await db.query<{ result: unknown }>(
        `select public.${fn}($1::text, $2::jsonb, $3::jsonb) as result`,
        [args.p_game_id, JSON.stringify(args.p_delete_keys), JSON.stringify(args.p_rows)],
      );
      return { data: r.rows[0]?.result ?? null, error: null };
    },
  };
  return client as unknown as SupabaseClient;
}

/** 직접 소비자 관점 — ledger 를 보지 않고 player_game_logs 를 그대로 읽는다. */
async function directConsumerRows(db: PGlite) {
  const r = await db.query<{ kbo_id: string; player_type: string }>(
    "select kbo_id, player_type from player_game_logs where game_id=$1 order by kbo_id",
    [GAME.gameId],
  );
  return r.rows;
}

async function ledgerOf(db: PGlite) {
  const r = await db.query<{
    status: "complete" | "incomplete";
    expected_row_count: number | null;
    expected_payload_hash: string | null;
    failure_reason: string | null;
  }>(
    `select status, expected_row_count, expected_payload_hash, failure_reason
       from player_game_log_ingestions where game_id=$1`,
    [GAME.gameId],
  );
  return r.rows[0] ?? null;
}

/**
 * 소비자가 실제로 보는 판정 — ledger 원장만 믿지 않고 현재 행과 대조한다(§11 runtime completeness).
 * venue-stats 통계 경로가 쓰는 것과 동일한 검증이다.
 */
async function runtimeVerify(db: PGlite) {
  const rows = await db.query<Record<string, unknown>>(
    `select ${CANONICAL_ROW_FIELDS.map((f) =>
      f === "game_date" ? "to_char(game_date,'YYYY-MM-DD') as game_date" : f,
    ).join(", ")}
       from player_game_logs where game_id=$1`,
    [GAME.gameId],
  );
  return verifyLedgerCompleteness(await ledgerOf(db), rows.rows as CanonicalRowInput[]);
}

async function main() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if;
      if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    end $$;
  `);
  await db.exec(migration("20260606_player_game_logs.sql"));
  await db.exec(migration("20260730_player_game_log_ingestions.sql"));
  await db.exec(migration("20260801_player_game_logs_reconcile_rpc.sql"));

  // ── ① GREEN: rekey 교체 후 complete ──────────────────────────────────
  console.log("\n[① GREEN] 오케스트레이터 정상 실행 → complete");
  const client = makeClient(db);
  const first = await ingestGameWithLedger(client, GAME, { fetchBoxscore: async () => BOX, resolver });
  ok("1회차 실행이 complete", first.status === "complete", `status=${first.status} reason=${first.failureReason}`);
  const baseRows = await directConsumerRows(db);
  ok("직접 소비자 행 존재", baseRows.length > 0, `rows=${baseRows.length}`);
  const baseCount = baseRows.length;

  // 구 key 주입 — 선수 1명이 재해석된 운영 7/4 상황.
  const target = baseRows[baseRows.length - 1];
  await db.query(
    `insert into player_game_logs
       (kbo_id, player_type, game_id, game_date, team_id, team_code, opponent_team_id,
        is_home, result, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed)
     select '56709', player_type, game_id, game_date, team_id, team_code, opponent_team_id,
            is_home, result, ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed
       from player_game_logs where game_id=$1 and kbo_id=$2 and player_type=$3`,
    [GAME.gameId, target.kbo_id, target.player_type],
  );
  await db.query("delete from player_game_logs where game_id=$1 and kbo_id=$2 and player_type=$3",
    [GAME.gameId, target.kbo_id, target.player_type]);
  const staleState = await directConsumerRows(db);
  ok("구 key 상태 준비(신 key 부재)",
    staleState.some((r) => r.kbo_id === "56709") && !staleState.some((r) => r.kbo_id === target.kbo_id));

  // ── ② RED: 쓰기 중간 실패 → 행 누락 0 → 재시도 complete ──────────────
  console.log("\n[② RED] 쓰기 중간 실패 — 직접 소비자 무오염 + 재시도 복구");
  const beforeFail = await directConsumerRows(db);
  const failing = makeClient(db, { failReconcile: true });
  let threw = false;
  try {
    await ingestGameWithLedger(failing, GAME, { fetchBoxscore: async () => BOX, resolver });
  } catch {
    threw = true;
  }
  ok("쓰기 실패는 조용히 넘기지 않는다(throw)", threw);
  const afterFail = await directConsumerRows(db);
  ok(
    "실패 후 직접 소비자 행 누락 0 — 트랜잭션 롤백",
    afterFail.length === beforeFail.length,
    `before=${beforeFail.length} after=${afterFail.length}`,
  );
  ok(
    "실패 후에도 구 key 보존(부분 삭제 없음)",
    afterFail.some((r) => r.kbo_id === "56709"),
  );
  // ⚠️ 원장 행 자체는 직전 성공 실행의 complete 가 남아 있을 수 있다.
  //    중요한 건 소비자가 보는 runtime 판정 — 현재 행과 대조해 fail-close 되어야 한다.
  const verifyAfterFail = await runtimeVerify(db);
  ok(
    "실패 구간 runtime 판정 fail-close (통계가 불완전 데이터를 안 씀)",
    !verifyAfterFail.complete,
    `reason=${verifyAfterFail.reason}`,
  );

  // 재시도 — 정상 client 로 같은 경기를 다시 적재하면 수렴해야 한다.
  const retry = await ingestGameWithLedger(client, GAME, { fetchBoxscore: async () => BOX, resolver });
  ok("재시도 complete 로 수렴", retry.status === "complete",
    `status=${retry.status} reason=${retry.failureReason}`);
  ok("재시도에서 구 key 1건 교체", retry.staleRowsRemoved === 1, `removed=${retry.staleRowsRemoved}`);
  const afterRetry = await directConsumerRows(db);
  ok("재시도 후 행수 정상 복원", afterRetry.length === baseCount,
    `expected=${baseCount} actual=${afterRetry.length}`);
  ok("재시도 후 구 key 제거", !afterRetry.some((r) => r.kbo_id === "56709"));
  const verifyAfterRetry = await runtimeVerify(db);
  ok("재시도 후 runtime 판정 complete", verifyAfterRetry.complete, `reason=${verifyAfterRetry.reason}`);

  // ── ③ RED: 부분 응답은 삭제 0 ────────────────────────────────────────
  console.log("\n[③ RED] 공급자 부분 응답(선수 1명 누락) → 삭제 0 · 기존 행 보존");
  const beforePartial = await directConsumerRows(db);
  const partial = await ingestGameWithLedger(client, GAME, { fetchBoxscore: async () => BOX_PARTIAL, resolver });
  ok("부분 응답은 complete 가 아니다", partial.status !== "complete", `status=${partial.status}`);
  ok("부분 응답에서 삭제 0건", partial.staleRowsRemoved === 0, `removed=${partial.staleRowsRemoved}`);
  const afterPartial = await directConsumerRows(db);
  ok(
    "기존 선수 행 보존(누락 없음)",
    afterPartial.length >= beforePartial.length,
    `before=${beforePartial.length} after=${afterPartial.length}`,
  );

  // ── ④ mutation 가드: 소스가 원자 RPC 경로를 유지하는지 ─────────────────
  console.log("\n[④ mutation 가드] 원자 RPC 경로 유지 + 분리 쓰기 재유입 차단");
  const src = readFileSync(resolve("src/lib/game-logs/ledger-ingest.ts"), "utf8");
  ok(
    "reconcile RPC 를 호출한다",
    /\.rpc\(\s*["']reconcile_player_game_logs["']/.test(src),
    "RPC 미사용 = 비원자 쓰기로 회귀",
  );
  ok(
    "player_game_logs 직접 delete 없음",
    !/from\(\s*["']player_game_logs["']\s*\)[\s\S]{0,120}?\.delete\(/.test(src),
    "직접 delete = 트랜잭션 밖 삭제",
  );
  ok(
    "player_game_logs 직접 upsert 없음",
    !/from\(\s*["']player_game_logs["']\s*\)[\s\S]{0,120}?\.upsert\(/.test(src),
    "직접 upsert = 삭제와 분리된 쓰기",
  );
  ok(
    "삭제 대상을 preflight 판정에서 가져온다",
    /preflight\.deletions/.test(src),
    "삭제 무력화(빈 배열 고정) 시 ①②가 RED",
  );

  await db.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
