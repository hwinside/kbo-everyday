/**
 * 로스터 변동 DB 실통합 테스트 (삼순 P0/P1 2차 — 트랜잭션/fail-closed/동시 실행 경합).
 *
 * ⚠️ 실행 전제: 마이그레이션 `supabase/migrations/20260718_roster_moves.sql`가 **prod(또는 대상
 * 프로젝트)에 선적용**되어 있어야 한다(테이블 + RPC replace_team_roster_day). #681에서
 * 삼순이 수용한 "prod 마이그레이션 선적용 후 QA 단계 실행" 패턴과 동일.
 *
 * 인메모리 ModelStore 스모크(roster-moves-diff-smoke.ts)가 재현하지 못하는 실 DB 경로를 검증:
 *   ① RPC 트랜잭션 원자 교체(스냅샷+무브)
 *   ② 동시 2회 실행 경합 → advisory lock으로 직렬화, 최종 상태 멱등(중복 무브 없음)
 *   ③ write 실패(배치 내 PK 충돌) → 함수 전체 롤백 → 직전 상태 불변(fail-closed)
 *
 * 실행: node scripts/qa/roster-moves-db-integration.mjs
 * 정리: 테스트 team_id(90019)의 모든 행을 시작/종료 시 삭제(실팀 1~10과 미충돌).
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const T = 90019; // 테스트 전용 team_id (실팀 1~10과 미충돌)
const D0 = "2019-01-01";
const D1 = "2019-01-02";

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

function rpc(date, entries, moves) {
  return admin.rpc("replace_team_roster_day", {
    p_team_id: T,
    p_snapshot_date: date,
    p_entries: entries,
    p_moves: moves,
  });
}

async function main() {
  await cleanup();

  // ── 시나리오 1: baseline (D0 = [A,B], 무브 없음) 원자 적재
  {
    const { error } = await rpc(D0, [A, B], []);
    check("① baseline RPC 성공(error 없음)", !error, error);
    check("① D0 스냅샷 = {A,B}", JSON.stringify(await snapshotIds(D0)) === JSON.stringify([A.kboId, B.kboId]));
  }

  // ── 시나리오 2: D1 = [A] (B 말소). 동시 2회 실행(경합) → 멱등(무브 1건, 스냅샷 {A})
  {
    const move = { kboPlayerId: B.kboId, playerName: B.name, moveType: "deregister", status: "published" };
    const [r1, r2] = await Promise.all([rpc(D1, [A], [move]), rpc(D1, [A], [move])]);
    check("② 동시 2회 실행 모두 error 없음", !r1.error && !r2.error, { e1: r1.error, e2: r2.error });
    check("② D1 스냅샷 = {A} (원자 교체)", JSON.stringify(await snapshotIds(D1)) === JSON.stringify([A.kboId]));
    const moves = await moveRows(D1);
    const deregs = moves.filter((m) => m.kbo_player_id === B.kboId && m.move_type === "deregister");
    check("② B 말소 이벤트 정확히 1건(동시 실행에도 중복 없음)", deregs.length === 1, moves);
    check("② 말소는 published", deregs[0]?.status === "published", deregs);
  }

  // ── 시나리오 3: write 실패(배치 내 PK 충돌) → 함수 전체 롤백 → D1 스냅샷 불변(fail-closed)
  {
    const before = await snapshotIds(D1); // {A}
    // 같은 kboId(A)를 두 번 넣으면 roster_snapshots PK(date,team,kbo_player_id) 충돌 → 함수 raise → 롤백.
    const { error } = await rpc(D1, [A, A], []);
    check("③ 배치 내 PK 충돌 → RPC error 반환(fail-closed 신호)", !!error, { error });
    const after = await snapshotIds(D1);
    check("③ 실패 후 D1 스냅샷 불변({A} 유지 — 부분 상태 없음)", JSON.stringify(after) === JSON.stringify(before), { before, after });
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
