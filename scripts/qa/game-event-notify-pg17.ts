// S2 Slice0 (삼순 4차 NO-GO #1) — actual notifyScoreEvents() 경로 × 실 Postgres 통합 회귀.
//
// 삼순 지적: 시간 freshness gate 폐기 + activation/cutover 경계가 "claim RPC 직접 now() 호출"이 아니라
// 실제 notifyScoreEvents() 진입으로 검증돼야 false-green이 아니다. 이 harness는 booted PG17에 마이그레이션을
// 로드하고, supabaseAdmin.rpc를 psql-backed shim으로 바꿔 진짜 notifyScoreEvents()를 돌린 뒤 원장 상태를 psql로
// 검증한다(FCM는 미구성 → graceful no-op, 네트워크 0). 계약 3종:
//   (A) pre-cutover legacy marker-only(marker.created_at < activation) → snapshot 미생성·토큰 0·재발송 0
//   (B) post-cutover marker-only orphan(marker.created_at ≥ activation, source age>10m) → snapshot 생성·미종결 복구
//   (C) post-cutover 정상 accepted → 다음 invocation claim 0(재발송 0)
//
// 실행: bash scripts/qa/game-event-notify-pg17.sh (PG 부팅 + env 주입 후 이 파일을 tsx로 구동)

import { execFileSync } from "node:child_process";

const PSQL = process.env.PSQL_BIN as string;
const PGHOST = process.env.PGHOST as string;
const PGPORT = process.env.PGPORT as string;
const PGUSER = process.env.PGUSER as string;
const PGDATABASE = process.env.PGDATABASE ?? "postgres";
if (!PSQL || !PGHOST || !PGPORT || !PGUSER) {
  console.error("game-event-notify-pg17: missing PG env (run via game-event-notify-pg17.sh)");
  process.exit(2);
}

function psql(sql: string, flags: string[] = ["-tAq"]): string {
  return execFileSync(
    PSQL,
    ["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", PGDATABASE, "-v", "ON_ERROR_STOP=1", ...flags, "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

/** SQL 리터럴 이스케이프(테스트 전용 controlled data). null → NULL. */
function lit(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── psql-backed supabaseAdmin.rpc shim: 실제 원장 RPC를 booted PG에서 실행 ──
function runRpc(fn: string, args: Record<string, unknown>): { data: unknown; error: null } {
  if (fn === "claim_game_event_tokens") {
    const sql = `SELECT row_to_json(t) FROM claim_game_event_tokens(${lit(args.p_event_id)},${lit(args.p_game_id)},${lit(args.p_sub)},${lit(args.p_team_id)},${lit(args.p_pref_key)},${lit(args.p_push_title)},${lit(args.p_push_body)},${lit(args.p_push_url)},${args.p_source_ts == null ? "NULL::timestamptz" : `${lit(args.p_source_ts)}::timestamptz`},${lit(args.p_lease_token)}::uuid,${lit(args.p_lease_seconds)},${lit(args.p_limit)}) t`;
    const out = psql(sql);
    const rows = out ? out.split("\n").map((l) => JSON.parse(l)) : [];
    return { data: rows, error: null };
  }
  if (fn === "settle_game_event_tokens") {
    const sql = `SELECT settle_game_event_tokens(${lit(JSON.stringify(args.p_results))}::jsonb,${lit(args.p_lease_token)}::uuid) AS v`;
    const out = psql(sql);
    return { data: out === "" ? 0 : Number(out), error: null };
  }
  if (fn === "list_due_game_event_snapshots") {
    const sql = `SELECT row_to_json(t) FROM list_due_game_event_snapshots(${lit(args.p_limit)}) t`;
    const out = psql(sql);
    const rows = out ? out.split("\n").map((l) => JSON.parse(l)) : [];
    return { data: rows, error: null };
  }
  throw new Error(`unexpected rpc ${fn}`);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}`); }
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://notify-pg17.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "notify-pg17-key";
  // FIREBASE 미설정 → getFcm() null → sendFcmToTokens graceful(missing_fcm_config, 네트워크 0).

  const { supabaseAdmin } = await import("../../src/lib/supabase/admin");
  (supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => unknown }).rpc =
    (fn, args) => ({ abortSignal: () => Promise.resolve(runRpc(fn, args)) });

  const { notifyScoreEvents } = await import("../../src/lib/notifications/game-score");

  // activation 경계를 명시 고정(코드 배포 시각 = now-10m). legacy marker는 이 이전, orphan marker는 이후.
  psql("INSERT INTO game_event_ledger_activation(id,activated_at) VALUES (true, now()-interval '10 minutes') ON CONFLICT (id) DO UPDATE SET activated_at=EXCLUDED.activated_at");

  // team 1(LG) 팬 1명, score pref default on. 홈팀 team 2(두산)은 concede 팬 없음.
  psql(`INSERT INTO profiles(id,team_id) VALUES ('20000000-0000-0000-0000-000000000001',1)`);
  psql(`INSERT INTO device_push_tokens(id,user_id,platform,app_build,fcm_token) VALUES (101,'20000000-0000-0000-0000-000000000001','ios',null,'ntok-1')`);

  const mkGame = (gid: string) => ({
    G_ID: gid, S_NM: "잠실", AWAY_NM: "LG", HOME_NM: "두산",
    T_SCORE_CN: "1", B_SCORE_CN: "0", CANCEL_SC_ID: "0",
  }) as unknown as import("../../src/types/api").KboRawGame;

  const mkScoreEvent = (id: string, gid: string, ageMs: number) => ({
    id, gameId: gid, timestamp: new Date(Date.now() - ageMs).toISOString(),
    inning: 3, isTop: true, type: "run_scored" as const,
    detail: { scoringSide: "away" as const }, text: "득점",
    snapshot: { awayScore: 1, homeScore: 0, balls: 0, strikes: 0, outs: 0,
      runners: { first: null, second: null, third: null }, pitcher: "", batter: "" },
  }) as unknown as import("../../src/types/game-events").GameEvent;

  // ── (A) pre-cutover legacy marker-only → 재발송 0, snapshot 미생성 ──
  const gA = "20260727LGOB1";
  const evA = mkScoreEvent(`${gA}-3-1`, gA, 60 * 60 * 1000); // source age 1h
  psql(`INSERT INTO notified_score_events(event_id,game_id,created_at) VALUES (${lit(evA.id)},${lit(gA)}, now()-interval '1 hour')`); // marker < activation
  const rA = await notifyScoreEvents([mkGame(gA)], new Map([[gA, [evA]]]));
  const aSnap = psql(`SELECT count(*) FROM game_event_delivery_snapshots WHERE event_id=${lit(evA.id)}`);
  const aTok = psql(`SELECT count(*) FROM notified_game_event_tokens WHERE event_id=${lit(evA.id)}`);
  check("(A) pre-cutover legacy: notifyScoreEvents accepted 0(재발송 0)", rA.scored === 0);
  check("(A) pre-cutover legacy: snapshot 미생성", aSnap === "0");
  check("(A) pre-cutover legacy: 토큰 0(신규 원장 진입 안 함)", aTok === "0");

  // ── (B) post-cutover marker-only orphan(source age>10m) → snapshot 생성·미종결 복구 ──
  const gB = "20260727LGOB2";
  const evB = mkScoreEvent(`${gB}-3-1`, gB, 35 * 60 * 1000); // source age 35m(>10m)
  psql(`INSERT INTO notified_score_events(event_id,game_id,created_at) VALUES (${lit(evB.id)},${lit(gB)}, now())`); // marker >= activation
  const bSnapBefore = psql(`SELECT count(*) FROM game_event_delivery_snapshots WHERE event_id=${lit(evB.id)}`);
  await notifyScoreEvents([mkGame(gB)], new Map([[gB, [evB]]]));
  const bSnap = psql(`SELECT count(*) FROM game_event_delivery_snapshots WHERE event_id=${lit(evB.id)} AND snapshot_completed`);
  const bTok = psql(`SELECT count(*) FROM notified_game_event_tokens WHERE event_id=${lit(evB.id)}`);
  check("(B) orphan 사전조건: snapshot 없음", bSnapBefore === "0");
  check("(B) post-cutover orphan(age>10m): snapshot 생성(freshness gate 미차단)", bSnap === "1");
  check("(B) post-cutover orphan: 미종결 토큰 복구(claim·attempt)", Number(bTok) >= 1);

  // ── (C) post-cutover 정상 accepted → 다음 invocation 재발송 0 ──
  const gC = "20260727LGOB3";
  const evC = mkScoreEvent(`${gC}-3-1`, gC, 0); // fresh
  // 선행 성공 발송 상태를 원장에 심는다: snapshot(완료) + accepted 토큰 1(hash는 실제 digest).
  const hashC = psql(`SELECT encode(extensions.digest('ntok-1','sha256'),'hex')`);
  psql(`INSERT INTO game_event_delivery_snapshots(event_id,game_id,sub,pref_key,team_id,push_title,push_body,push_url,source_ts,snapshot_completed,deadline_at,completed_at) VALUES (${lit(evC.id)},${lit(gC)},'score','my_team_score',1,'t','b',${lit(`/games/${gC}`)}, now(), true, now()+interval '6 hours', now())`);
  psql(`INSERT INTO notified_game_event_tokens(event_id,game_id,sub,token_id,token_hash,status,accepted_at) VALUES (${lit(evC.id)},${lit(gC)},'score',101,${lit(hashC)},'accepted', now())`);
  const rC = await notifyScoreEvents([mkGame(gC)], new Map([[gC, [evC]]]));
  const cState = psql(`SELECT status FROM notified_game_event_tokens WHERE event_id=${lit(evC.id)} AND token_id=101`);
  check("(C) post-cutover accepted: notifyScoreEvents 재발송 0", rC.scored === 0);
  check("(C) post-cutover accepted: 토큰 accepted 불변(재claim 안 됨)", cState === "accepted");

  console.log(`\n[game-event-notify-pg17] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[game-event-notify-pg17] threw:", e);
  process.exit(1);
});
