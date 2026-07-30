/**
 * 직관 다이어리 통계 S1a — 적재 완전성 ledger DB 통합 테스트 (PGlite).
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11·§12
 *
 * 20260606_player_game_logs.sql + 20260730_player_game_log_ingestions.sql을 실제 적용해
 * 삼순 S1a 머지 게이트(RED 4종 + fail-closed)를 고정한다:
 *   RED ① 단일 행 누락 (complete 이후 batter/pitcher 1행 삭제 → row_count/hash mismatch)
 *   RED ② 단일 필드 0 오염 (정상 ab=4,h=2 → 0,0 drift — key 동일, payload hash로만 감지)
 *   RED ③ 미해결 선수 행 스킵 후 complete 시도 (unresolved>0 → 무조건 incomplete)
 *   RED ④ metadata-only 오염 (stat 동일, team_id/result만 변조 — 20필드 hash로 감지)
 * + missing_required_field fail-closed(결측→0 강등 금지), extra row RED, hash 행순서 무관,
 *   null "∅" vs 0/"" 구분, ledger 없음 RED, 재적재 멱등, RLS(service_role 전용).
 *
 * 실행: npm run qa:venue-stats-s1a-ledger:db
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { KboGame } from "@/lib/crawler/kbo-api";
import type { GameBoxscore } from "@/lib/game-logs/ingest";
import {
  CANONICAL_ROW_FIELDS,
  buildGameIngestion,
  canonicalPayloadHash,
  evaluateIngestion,
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

// ── fixture: 가상 경기 + 박스스코어 (LG 홈 5:3 승 vs OB) ─────────────────────
const GAME = {
  gameId: "20260614LGOB0",
  date: "20260614",
  homeTeamId: 1, // LG
  awayTeamId: 2, // OB
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
  awayPitchers: [{ name: "원정투수A", inn: "5", er: 4, hit: 8, kk: 3, bb: 2 }],
};

/** 테스트 resolver — 이름→고정 kbo_id (RED ③에서 선택적으로 실패시킨다). */
const IDS: Record<string, string> = {
  홈타자A: "90001", 홈타자B: "90002", 홈투수A: "90003",
  원정타자A: "90004", 원정투수A: "90005",
};
const resolverAll: PlayerResolver = (q) => (IDS[q.name] ? { kboId: IDS[q.name] } : null);

async function insertRows(db: PGlite, rows: CanonicalRowInput[]) {
  for (const r of rows) {
    await db.query(
      `insert into player_game_logs
         (kbo_id, player_type, game_id, game_date, team_id, team_code, opponent_team_id, is_home, result,
          ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (kbo_id, player_type, game_id) do update set
         ab=excluded.ab, h=excluded.h, hr=excluded.hr, rbi=excluded.rbi, bb=excluded.bb, so=excluded.so,
         ip_outs=excluded.ip_outs, er=excluded.er, h_allowed=excluded.h_allowed, k=excluded.k,
         bb_allowed=excluded.bb_allowed, team_id=excluded.team_id, team_code=excluded.team_code,
         opponent_team_id=excluded.opponent_team_id, is_home=excluded.is_home, result=excluded.result`,
      CANONICAL_ROW_FIELDS.map((f) => (r as Record<string, unknown>)[f]),
    );
  }
}

async function selectRows(db: PGlite): Promise<CanonicalRowInput[]> {
  const r = await db.query<Record<string, unknown>>(
    `select kbo_id, player_type, game_id, to_char(game_date,'YYYY-MM-DD') as game_date,
            team_id, team_code, opponent_team_id, is_home, result,
            ab, h, hr, rbi, bb, so, ip_outs, er, h_allowed, k, bb_allowed
       from player_game_logs where game_id = $1`,
    [GAME.gameId],
  );
  return r.rows as CanonicalRowInput[];
}

async function ledgerOf(db: PGlite) {
  const r = await db.query<{
    status: "complete" | "incomplete";
    expected_row_count: number | null;
    expected_payload_hash: string | null;
  }>(
    "select status, expected_row_count, expected_payload_hash from player_game_log_ingestions where game_id=$1",
    [GAME.gameId],
  );
  return r.rows[0] ?? null;
}

async function verifyNow(db: PGlite) {
  return verifyLedgerCompleteness(await ledgerOf(db), await selectRows(db));
}

function logVerify(label: string, v: { complete: boolean; reason: string | null }) {
  console.log(`    [${label}] complete=${v.complete}${v.reason ? ` reason=${v.reason}` : ""}`);
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

  // ── 0) 정상 game → complete (GREEN 기준선) ───────────────────────────────
  console.log("\n[0] 정상 적재 → complete GREEN");
  const build = buildGameIngestion(GAME, BOX, resolverAll);
  ok("strict 빌드: raw=resolved=rows=5", build.rawRowCount === 5 && build.resolvedRowCount === 5 && build.rows.length === 5);
  ok("missingFields 없음", build.missingFields.length === 0);
  const expectedHash = canonicalPayloadHash(build.rows);
  await insertRows(db, build.rows as unknown as CanonicalRowInput[]);
  const persisted = await selectRows(db);
  const verdict = evaluateIngestion({
    rawRowCount: build.rawRowCount, resolvedRowCount: build.resolvedRowCount,
    persistedRowCount: persisted.length, unresolvedCount: build.unresolved.length,
    missingFieldCount: 0, expectedRowCount: build.rows.length,
    expectedPayloadHash: expectedHash, actualPayloadHash: canonicalPayloadHash(persisted),
  });
  ok("evaluateIngestion=complete", verdict.status === "complete" && verdict.failureReason === null);
  await db.query(
    `insert into player_game_log_ingestions
       (game_id, game_date, status, expected_row_count, expected_payload_hash, persisted_row_count,
        unresolved_count, source_fetched_at, verified_at)
     values ($1,$2,'complete',$3,$4,$5,0,now(),now())
     on conflict (game_id) do update set status='complete', expected_row_count=$3,
       expected_payload_hash=$4, persisted_row_count=$5, failure_reason=null, verified_at=now()`,
    [GAME.gameId, "2026-06-14", build.rows.length, expectedHash, persisted.length],
  );
  const green0 = await verifyNow(db);
  logVerify("GREEN", green0);
  ok("runtime 검증 complete=true", green0.complete);

  // ── RED ①: 단일 행 누락 ─────────────────────────────────────────────────
  console.log("\n[RED ①] 단일 행 누락 (batter 1행 삭제)");
  await db.query("delete from player_game_logs where game_id=$1 and kbo_id='90002'", [GAME.gameId]);
  const red1 = await verifyNow(db);
  logVerify("RED", red1);
  ok("행 누락 감지 → incomplete", !red1.complete && red1.reason === "row_count_mismatch");
  await insertRows(db, build.rows.filter((r) => r.kbo_id === "90002") as unknown as CanonicalRowInput[]);
  const green1 = await verifyNow(db);
  logVerify("GREEN 원복", green1);
  ok("원복 후 complete", green1.complete);

  console.log("\n[RED ①b] pitcher 1행 삭제");
  await db.query("delete from player_game_logs where game_id=$1 and kbo_id='90005'", [GAME.gameId]);
  const red1b = await verifyNow(db);
  logVerify("RED", red1b);
  ok("pitcher 행 누락 감지", !red1b.complete && red1b.reason === "row_count_mismatch");
  await insertRows(db, build.rows.filter((r) => r.kbo_id === "90005") as unknown as CanonicalRowInput[]);
  ok("원복 후 complete", (await verifyNow(db)).complete);

  // ── RED ②: 단일 필드 0 오염 (ab=4,h=2 → 0,0 — key 목록 동일) ────────────
  console.log("\n[RED ②] 단일 필드 0 오염 (홈타자A ab/h → 0)");
  await db.query("update player_game_logs set ab=0, h=0 where game_id=$1 and kbo_id='90001'", [GAME.gameId]);
  const red2 = await verifyNow(db);
  logVerify("RED", red2);
  ok("0 drift 감지 → payload_hash_mismatch (count 동일)", !red2.complete && red2.reason === "payload_hash_mismatch");
  await db.query("update player_game_logs set ab=4, h=2 where game_id=$1 and kbo_id='90001'", [GAME.gameId]);
  const green2 = await verifyNow(db);
  logVerify("GREEN 원복", green2);
  ok("원복 후 complete", green2.complete);

  // ── RED ③: 미해결 선수 행 스킵 후 complete 시도 ─────────────────────────
  console.log("\n[RED ③] 미해결 선수 행 스킵 (홈타자B resolve 실패)");
  const resolverMiss: PlayerResolver = (q) => (q.name === "홈타자B" ? null : resolverAll(q));
  const build3 = buildGameIngestion(GAME, BOX, resolverMiss);
  ok("raw 5 ≠ resolved 4, unresolved=1", build3.rawRowCount === 5 && build3.resolvedRowCount === 4 && build3.unresolved.length === 1);
  const verdict3 = evaluateIngestion({
    rawRowCount: build3.rawRowCount, resolvedRowCount: build3.resolvedRowCount,
    persistedRowCount: build3.rows.length, unresolvedCount: build3.unresolved.length,
    missingFieldCount: 0, expectedRowCount: build3.rows.length,
    expectedPayloadHash: canonicalPayloadHash(build3.rows),
    actualPayloadHash: canonicalPayloadHash(build3.rows),
  });
  console.log(`    [RED] status=${verdict3.status} reason=${verdict3.failureReason}`);
  ok("unresolved>0 → 무조건 incomplete (complete 판정 금지)", verdict3.status === "incomplete" && verdict3.failureReason === "unresolved_player");
  const verdict3ok = evaluateIngestion({
    rawRowCount: build.rawRowCount, resolvedRowCount: build.resolvedRowCount,
    persistedRowCount: build.rows.length, unresolvedCount: 0, missingFieldCount: 0,
    expectedRowCount: build.rows.length, expectedPayloadHash: expectedHash, actualPayloadHash: expectedHash,
  });
  ok("resolver 정상(GREEN 대조군) → complete", verdict3ok.status === "complete");

  // ── RED ④: metadata-only 오염 (stat 동일, team_id/result만 변조) ────────
  console.log("\n[RED ④] metadata-only 오염 (홈투수A team_id 1→3, result W→L — stat 무변조)");
  await db.query(
    "update player_game_logs set team_id=3, team_code='KT', result='L' where game_id=$1 and kbo_id='90003'",
    [GAME.gameId],
  );
  const red4 = await verifyNow(db);
  logVerify("RED", red4);
  ok("metadata 오염 감지 → payload_hash_mismatch (20필드 hash)", !red4.complete && red4.reason === "payload_hash_mismatch");
  await db.query(
    "update player_game_logs set team_id=1, team_code='LG', result='W' where game_id=$1 and kbo_id='90003'",
    [GAME.gameId],
  );
  const green4 = await verifyNow(db);
  logVerify("GREEN 원복", green4);
  ok("원복 후 complete", green4.complete);

  // ── extra row 삽입 RED ───────────────────────────────────────────────────
  console.log("\n[RED+] extra row 삽입");
  await insertRows(db, [{
    ...build.rows[0], kbo_id: "99999",
  }] as unknown as CanonicalRowInput[]);
  const redExtra = await verifyNow(db);
  logVerify("RED", redExtra);
  ok("extra row 감지", !redExtra.complete && redExtra.reason === "row_count_mismatch");
  await db.query("delete from player_game_logs where game_id=$1 and kbo_id='99999'", [GAME.gameId]);
  ok("원복 후 complete", (await verifyNow(db)).complete);

  // ── missing_required_field fail-closed (§12 결측→0 강등 금지) ────────────
  console.log("\n[fail-closed] 필수필드 결측");
  const boxMissing: GameBoxscore = {
    ...BOX,
    homeBatters: [{ name: "홈타자A", hit: 2, hr: 1, rbi: 3, bb: 0, kk: 1 }, BOX.homeBatters[1]], // ab 결측
  };
  const buildMissing = buildGameIngestion(GAME, boxMissing, resolverAll);
  ok("ab 결측 → missingFields=[ab], rows 비움(부분 적재 금지)",
    buildMissing.missingFields.length === 1 && buildMissing.missingFields[0].field === "ab" && buildMissing.rows.length === 0);
  const verdictMissing = evaluateIngestion({
    rawRowCount: buildMissing.rawRowCount, resolvedRowCount: buildMissing.resolvedRowCount,
    persistedRowCount: 0, unresolvedCount: 0, missingFieldCount: buildMissing.missingFields.length,
    expectedRowCount: 0, expectedPayloadHash: canonicalPayloadHash([]), actualPayloadHash: canonicalPayloadHash([]),
  });
  ok("missing_required_field로 incomplete", verdictMissing.status === "incomplete" && verdictMissing.failureReason === "missing_required_field");
  const boxBadInn: GameBoxscore = {
    ...BOX,
    homePitchers: [{ name: "홈투수A", inn: "abc", er: 2, hit: 5, kk: 7, bb: 1 }],
  };
  const buildBadInn = buildGameIngestion(GAME, boxBadInn, resolverAll);
  ok("inn 파싱 실패도 0 강등 없이 missing_required_field",
    buildBadInn.missingFields.some((m) => m.field === "ip_outs") && buildBadInn.rows.length === 0);

  // ── canonical hash 속성 ──────────────────────────────────────────────────
  console.log("\n[hash] canonical payload hash 속성");
  const shuffled = [...build.rows].reverse();
  ok("행 순서 무관 동일 hash", canonicalPayloadHash(shuffled as unknown as CanonicalRowInput[]) === expectedHash);
  ok("null(∅) ≠ 0 ≠ 빈문자열",
    new Set([
      canonicalPayloadHash([{ kbo_id: "1", player_type: "batter", ab: null }]),
      canonicalPayloadHash([{ kbo_id: "1", player_type: "batter", ab: 0 }]),
      canonicalPayloadHash([{ kbo_id: "1", player_type: "batter", ab: "" }]),
    ]).size === 3);
  ok("20필드 직렬화 (필드 수 고정)", CANONICAL_ROW_FIELDS.length === 20);

  // ── ledger 없음 = incomplete (heuristic fallback 금지) ───────────────────
  console.log("\n[ledger 없음] fail-closed");
  const noLedger = verifyLedgerCompleteness(null, persisted);
  logVerify("RED", noLedger);
  ok("ledger 없음 → incomplete(ledger_missing)", !noLedger.complete && noLedger.reason === "ledger_missing");
  const incompleteLedger = verifyLedgerCompleteness(
    { status: "incomplete", expected_row_count: 5, expected_payload_hash: expectedHash }, persisted);
  ok("ledger incomplete → 신뢰 안 함", !incompleteLedger.complete && incompleteLedger.reason === "ledger_incomplete");

  // ── 재적재 멱등 ──────────────────────────────────────────────────────────
  console.log("\n[멱등] 재적재");
  await insertRows(db, build.rows as unknown as CanonicalRowInput[]);
  const greenIdem = await verifyNow(db);
  ok("동일 rows 재upsert 후에도 complete + 행수 불변", greenIdem.complete && (await selectRows(db)).length === 5);

  // ── RLS: ledger는 service_role 전용 ──────────────────────────────────────
  console.log("\n[RLS] player_game_log_ingestions service_role 전용");
  async function relPriv(role: string, priv: string): Promise<boolean> {
    const r = await db.query<{ ok: boolean }>(
      "select has_table_privilege($1, 'public.player_game_log_ingestions', $2) as ok", [role, priv]);
    return r.rows[0]?.ok === true;
  }
  ok("anon SELECT 차단", (await relPriv("anon", "SELECT")) === false);
  ok("authenticated SELECT 차단", (await relPriv("authenticated", "SELECT")) === false);
  ok("anon INSERT 차단", (await relPriv("anon", "INSERT")) === false);
  ok("service_role 전권", await relPriv("service_role", "SELECT") && (await relPriv("service_role", "INSERT")));

  await db.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
