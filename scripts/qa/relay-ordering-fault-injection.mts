/**
 * PR #1305 durable-ordering 결함주입 게이트 — publish_relay_frame RPC 5축 (삼순 확정 설계).
 *
 * ⚠️ migration(20260826020000_game_relay_publish_rpc.sql) 적용 후에만 실행 가능.
 *    apply 는 HOLD(하린아빠 명시 승인 대상) → 이 스크립트는 계약 명세이자 apply 즉시
 *    실행할 게이트다. 미적용 상태에서 돌리면 RPC 부재로 axis 전부 FAIL(fail-close).
 *
 * 검증하는 것: JS abort fence 로는 못 막던 cross-invocation overlap 을 DB RPC 가
 *   (epoch, ordinal) 원자 거부 + advisory xact lock 으로 durable 하게 막는가.
 *
 * 5축(삼순 2026-08-25 17:47):
 *   ① B선행→A거부   : 늦은 인보케이션 B(큰 epoch) 커밋 후 이전 A(작은 epoch)는 stale 거부
 *   ② A선행→B최종   : A 먼저 inserted, B 나중 inserted → cursor 는 B(최종 승자)
 *   ③ 동률          : 같은 (epoch, ordinal) 재발행은 stale(<=) 거부 + unique 보조제약 이중방어
 *   ④ lock_busy bounded : 같은 경기 동시 RPC N개 → 중복 커밋 0(coord unique), 결과 ∈ {inserted,stale,lock_busy}
 *   ⑤ GC후 cursor보존 : frames 를 24h GC 로 지워도 game_relay_cursor 는 durable → stale 거부 유지
 *
 * 필요한 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   (RPC 는 security invoker + EXECUTE service_role only → service_role 로만 호출)
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !serviceKey) {
  console.error("env 미설정 (URL/SERVICE_ROLE)");
  process.exit(2);
}

const GAME = `QA-ORD-${Date.now()}`;
const CH = "relay";
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`); }
}

// 별도 커넥션 2개(동시성 축용). service_role 만 RPC EXECUTE 권한.
const a = createClient(url, serviceKey, { auth: { persistSession: false } });
const b = createClient(url, serviceKey, { auth: { persistSession: false } });

type Outcome = "inserted" | "stale" | "lock_busy" | "error";
async function publish(
  client: typeof a,
  epoch: number,
  ordinal: number,
  seq: number,
  kind = "relay-full",
): Promise<Outcome> {
  // channel 은 전달하지 않는다(삼순 P1) — RPC 가 p_kind 에서 유도. 반환은 jsonb {result,id}.
  const { data, error } = await client.rpc("publish_relay_frame", {
    p_game_id: GAME,
    p_kind: kind,
    p_epoch: epoch,
    p_ordinal: ordinal,
    p_seq: seq,
    p_payload: { channel: CH, ok: true, status: 200, data: { innings: [] } },
  });
  if (error) return "error";
  return ((data as { result?: Outcome } | null)?.result) ?? "error";
}

async function cursorOf(): Promise<{ epoch: number; ordinal: number } | null> {
  const { data } = await a
    .from("game_relay_cursor")
    .select("epoch, ordinal")
    .eq("game_id", GAME)
    .eq("channel", CH)
    .maybeSingle();
  return data ? { epoch: Number(data.epoch), ordinal: Number(data.ordinal) } : null;
}

try {
  // ── ① B선행(epoch=2) 커밋 후 A(epoch=1)는 stale 거부 ──
  const b1 = await publish(a, 2, 1, 101);
  const a1 = await publish(a, 1, 5, 102); // 작은 epoch = 늦게 도착한 이전 인보케이션
  check("① B선행 inserted", b1 === "inserted", b1);
  check("① 이전 인보케이션 A(작은 epoch) stale 거부", a1 === "stale", a1);
  const c1 = await cursorOf();
  check("① cursor 는 B(epoch=2, ord=1) 유지", c1?.epoch === 2 && c1?.ordinal === 1, JSON.stringify(c1));

  // ── ② A선행→B최종 (같은 epoch 내 ordinal 전진) ──
  const a2 = await publish(a, 3, 1, 201);
  const b2 = await publish(a, 3, 2, 202); // 같은 epoch, 더 큰 ordinal = 최종 승자
  check("② A(ord=1) inserted", a2 === "inserted", a2);
  check("② B(ord=2) inserted", b2 === "inserted", b2);
  const c2 = await cursorOf();
  check("② cursor 는 최종 B(epoch=3, ord=2)", c2?.epoch === 3 && c2?.ordinal === 2, JSON.stringify(c2));

  // ── ③ 동률: 같은 (epoch, ordinal) 재발행은 stale(<=) 거부 ──
  const d1 = await publish(a, 4, 1, 301);
  const d2 = await publish(a, 4, 1, 302); // 동일 좌표 = <= → stale
  check("③ 최초 (epoch=4,ord=1) inserted", d1 === "inserted", d1);
  check("③ 동일 좌표 재발행 stale 거부", d2 === "stale", d2);

  // ── ④ lock_busy bounded: 같은 경기 동시 RPC → 중복 커밋 0, 결과 유계 ──
  // advisory xact lock 은 트랜잭션 스코프. 동시 호출 시 하나는 락 획득(inserted/stale),
  // 락 경합 시 다른 하나는 lock_busy 즉시 반환(spin 없음). 어느 경우든 coord unique 로
  // 이중 커밋은 물리적으로 0. epoch=5, 서로 다른 ordinal 로 동시 발사.
  const before = (await a.from("game_relay_frames").select("id").eq("game_id", GAME)).data?.length ?? 0;
  const [r1, r2] = await Promise.all([publish(a, 5, 1, 401), publish(b, 5, 2, 402)]);
  const valid: Outcome[] = ["inserted", "stale", "lock_busy"];
  check("④ 동시 RPC 결과 유계 {inserted,stale,lock_busy}", valid.includes(r1) && valid.includes(r2), `${r1},${r2}`);
  const after = (await a.from("game_relay_frames").select("id").eq("game_id", GAME)).data?.length ?? 0;
  const inserted = [r1, r2].filter((r) => r === "inserted").length;
  check("④ 커밋 수 = inserted 결과 수 (이중커밋 0)", after - before === inserted, `Δframes=${after - before} inserted=${inserted}`);

  // ── ⑤ GC후 cursor 보존: frames 삭제해도 cursor durable → stale 거부 유지 ──
  // 24h GC 를 프레임 물리 삭제로 시뮬레이션. cursor 행은 남아야 하고, 이전 좌표
  // 재발행은 여전히 stale 로 거부돼야 한다(frames.max(seq) 였다면 GC 후 판정 소실).
  const cBefore = await cursorOf();
  // query-guard: bounded -- QA 전용 game_id 한정 삭제(이 테스트가 넣은 프레임만)
  await a.from("game_relay_frames").delete().eq("game_id", GAME);
  const cAfter = await cursorOf();
  check("⑤ frames GC 후 cursor 행 durable 보존", cAfter !== null && cAfter.epoch === cBefore?.epoch, JSON.stringify(cAfter));
  const post = await publish(a, 5, 1, 501); // GC 전 최고 좌표(epoch=5,ord=2) 이하 → stale
  check("⑤ GC 후에도 이전 좌표 stale 거부(cursor durable)", post === "stale", post);
} finally {
  // ── cleanup: QA 전용 game_id 한정 삭제, 잔존 0 ──
  // query-guard: bounded -- QA 전용 game_id(QA-ORD-<ts>) 한정
  await a.from("game_relay_frames").delete().eq("game_id", GAME);
  await a.from("game_relay_cursor").delete().eq("game_id", GAME);
  const resFrames = (await a.from("game_relay_frames").select("id").eq("game_id", GAME)).data?.length ?? 0;
  const resCursor = (await a.from("game_relay_cursor").select("game_id").eq("game_id", GAME)).data?.length ?? 0;
  check("cleanup: QA frames+cursor 잔존 0", resFrames === 0 && resCursor === 0, `frames=${resFrames} cursor=${resCursor}`);
}

console.log(`\nRESULT ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
