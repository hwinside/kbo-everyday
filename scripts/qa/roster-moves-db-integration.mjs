/**
 * 로스터 변동 DB 실통합 테스트 (삼순 P0/P1 2차 트랜잭션/fail-closed/동시 실행 경합 + 3차 권한/역순 경합).
 *
 * ⚠️ 실행 전제: 마이그레이션 `supabase/migrations/20260718_roster_moves.sql`가 **prod(또는 대상
 * 프로젝트)에 선적용**되어 있어야 한다(테이블 + RPC replace_team_roster_day, captured_at/canonical_id
 * 컬럼, service_role 전용 EXECUTE grant). #681에서 삼순이 수용한 "prod 마이그레이션 선적용 후 QA
 * 단계 실행" 패턴과 동일. 마이그 미적용 상태에서는 실행하지 않는다.
 *
 * 인메모리 ModelStore 스모크(roster-moves-diff-smoke.ts)가 재현하지 못하는 실 DB 경로를 검증:
 *   ⓪ 권한 게이트(삼순 P0 3차): anon 호출 = permission denied, service_role 호출 = 성공
 *   ① RPC 트랜잭션 원자 교체(스냅샷+무브)
 *   ② 동시 2회 실행 경합 → advisory lock으로 직렬화, 최종 상태 멱등(중복 무브 없음)
 *   ③ write 실패(배치 내 PK 충돌) → 함수 전체 롤백 → 직전 상태 불변(fail-closed)
 *   ④ stale run 역순 커밋(삼순 P0/P1 3차): 서로 다른 payload를 강제 역순 완료 → 최신 capture가 이기고
 *      오래된 capture 쓰기는 거부(applied=false) → 최신 B 잔존, 오래된 A가 덮지 못함
 *
 * 실행: node scripts/qa/roster-moves-db-integration.mjs
 * 정리: 테스트 team_id(90019)의 모든 행을 시작/종료 시 삭제(실팀 1~10과 미충돌).
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const clientOpts = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, clientOpts);
const anon = createClient(SUPABASE_URL, ANON_KEY, clientOpts);

const T = 90019; // 테스트 전용 team_id (실팀 1~10과 미충돌)
const D0 = "2019-01-01";
const D1 = "2019-01-02";
const D2 = "2019-03-01"; // 역순 경합 시나리오 전용 날짜

const A = { kboId: "9000001", name: "테스트가", backNo: "1", position: "투수" };
const B = { kboId: "9000002", name: "테스트나", backNo: "2", position: "포수" };

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra ? JSON.stringify(extra) : ""}`);
  }
}

async function cleanup() {
  await admin.from("roster_moves").delete().eq("team_id", T);
  await admin.from("roster_snapshots").delete().eq("team_id", T);
}

async function snapshotIds(date) {
  const { data, error } = await admin
    .from("roster_snapshots")
    .select("kbo_player_id")
    .eq("team_id", T)
    .eq("snapshot_date", date);
  if (error) throw new Error(`snapshot read: ${error.message}`);
  return (data ?? []).map((r) => r.kbo_player_id).sort();
}

async function moveRows(date) {
  const { data, error } = await admin
    .from("roster_moves")
    .select("kbo_player_id, move_type, status")
    .eq("team_id", T)
    .eq("move_date", date);
  if (error) throw new Error(`move read: ${error.message}`);
  return data ?? [];
}

/** service_role RPC 호출. capturedAt은 stale run 워터마크(ISO 문자열). */
function rpc(date, entries, moves, capturedAt) {
  return admin.rpc("replace_team_roster_day", {
    p_team_id: T,
    p_snapshot_date: date,
    p_entries: entries,
    p_moves: moves,
    p_captured_at: capturedAt,
  });
}

async function main() {
  await cleanup();

  // ── 시나리오 ⓪: 권한 게이트 (삼순 P0 3차) — anon 거부, service_role 성공.
  //    SECURITY DEFINER 함수는 RLS를 우회하므로 유일한 게이트는 EXECUTE 권한이다.
  //    명시적 REVOKE(anon/authenticated) + GRANT(service_role)가 적용됐는지 실 DB로 검증.
  {
    const { data: anonData, error: anonErr } = await anon.rpc("replace_team_roster_day", {
      p_team_id: T,
      p_snapshot_date: D0,
      p_entries: [A],
      p_moves: [],
      p_captured_at: "2019-01-01T00:00:00Z",
    });
    check(
      "⓪ anon RPC 거부(EXECUTE 권한 없음 → permission denied)",
      !!anonErr && !anonData,
      { anonData, anonErr: anonErr?.message },
    );
    check(
      "⓪ anon이 실제로 스냅샷을 쓰지 못함(D0 비어있음)",
      JSON.stringify(await snapshotIds(D0)) === JSON.stringify([]),
    );
    const { error: svcErr } = await rpc(D0, [A], [], "2019-01-01T00:00:01Z");
    check("⓪ service_role RPC 성공(EXECUTE 권한 보유)", !svcErr, svcErr?.message);
    await cleanup(); // 시나리오 ⓪ 잔여 제거 후 다음 시나리오 시작
  }

  // ── 시나리오 ①: baseline (D0 = [A,B], 무브 없음) 원자 적재
  {
    const { error } = await rpc(D0, [A, B], [], "2019-01-01T09:00:00Z");
    check("① baseline RPC 성공(error 없음)", !error, error?.message);
    check("① D0 스냅샷 = {A,B}", JSON.stringify(await snapshotIds(D0)) === JSON.stringify([A.kboId, B.kboId]));
  }

  // ── 시나리오 ②: D1 = [A] (B 말소). 동시 2회 실행(경합, 동일 capture) → advisory lock 직렬화 + 멱등.
  //    동일 capture라 한 쪽만 적용되고 다른 쪽은 no-op(applied=false) → 최종 상태는 무브 1건으로 멱등.
  {
    const move = { kboPlayerId: B.kboId, playerName: B.name, moveType: "deregister", status: "published" };
    const cap = "2019-01-02T09:00:00Z";
    const [r1, r2] = await Promise.all([rpc(D1, [A], [move], cap), rpc(D1, [A], [move], cap)]);
    check("② 동시 2회 실행 모두 error 없음", !r1.error && !r2.error, { e1: r1.error?.message, e2: r2.error?.message });
    check("② D1 스냅샷 = {A} (원자 교체)", JSON.stringify(await snapshotIds(D1)) === JSON.stringify([A.kboId]));
    const moves = await moveRows(D1);
    const deregs = moves.filter((m) => m.kbo_player_id === B.kboId && m.move_type === "deregister");
    check("② B 말소 이벤트 정확히 1건(동시 실행에도 중복 없음)", deregs.length === 1, moves);
    check("② 말소는 published", deregs[0]?.status === "published", deregs);
  }

  // ── 시나리오 ③: write 실패(배치 내 PK 충돌) → 함수 전체 롤백 → D1 스냅샷 불변(fail-closed)
  //    capture는 ②(09:00)보다 최신(10:00)이라 워터마크를 통과한 뒤 PK 충돌로 raise → 롤백.
  {
    const before = await snapshotIds(D1); // {A}
    // 같은 kboId(A)를 두 번 넣으면 roster_snapshots PK(date,team,kbo_player_id) 충돌 → 함수 raise → 롤백.
    const { error } = await rpc(D1, [A, A], [], "2019-01-02T10:00:00Z");
    check("③ 배치 내 PK 충돌 → RPC error 반환(fail-closed 신호)", !!error, { error: error?.message });
    const after = await snapshotIds(D1);
    check("③ 실패 후 D1 스냅샷 불변({A} 유지 — 부분 상태 없음)", JSON.stringify(after) === JSON.stringify(before), { before, after });
  }

  // ── 시나리오 ④: stale run 역순 커밋 거부 (삼순 P0/P1 3차).
  //    run B(최신 capture) = [A] + B 말소, run A(오래된 capture) = [A,B] + 무브 없음.
  //    강제 역순 완료: 최신 B가 먼저 쓰고, 오래된 A가 나중에 쓴다 → A는 워터마크에 막혀 거부(applied=false).
  //    → 최신 B 잔존(스냅샷 {A} + B 말소 유지), 오래된 A가 덮어 정확한 말소를 지우지 못한다.
  {
    const tOld = "2019-03-01T10:00:00Z"; // run A: 먼저 수집(오래됨)
    const tNew = "2019-03-01T10:05:00Z"; // run B: 나중 수집(최신)
    const bDereg = { kboPlayerId: B.kboId, playerName: B.name, moveType: "deregister", status: "published" };

    // 최신 B 먼저 완료: [A] + B 말소.
    const { data: bData, error: bErr } = await rpc(D2, [A], [bDereg], tNew);
    check("④ 최신 run B 적용(applied=true)", !bErr && bData?.applied === true, { bErr: bErr?.message, bData });

    // 오래된 A 나중 완료: [A,B] + 무브 없음 → 워터마크(tNew)보다 오래됨(tOld) → 거부.
    const { data: aData, error: aErr } = await rpc(D2, [A, B], [], tOld);
    check("④ 오래된 run A 거부(applied=false, stale_capture)", !aErr && aData?.applied === false && aData?.reason === "stale_capture", { aErr: aErr?.message, aData });

    // 최종 상태: B가 이긴다 — 스냅샷 {A}(오래된 A의 [A,B]가 덮지 못함).
    check("④ 최종 스냅샷 = {A} (최신 B 잔존, 오래된 A 미반영)", JSON.stringify(await snapshotIds(D2)) === JSON.stringify([A.kboId]));
    // 최종 무브: B 말소 정확히 1건(오래된 A가 정확한 말소를 지우지 못함).
    const moves = await moveRows(D2);
    const deregs = moves.filter((m) => m.kbo_player_id === B.kboId && m.move_type === "deregister");
    check("④ B 말소 이벤트 잔존(오래된 A가 최신 무브를 삭제하지 못함)", deregs.length === 1, moves);
  }

  await cleanup();
  console.log(`\nroster-moves DB integration: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("integration 실패:", e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
