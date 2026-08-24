/**
 * PR #1305 실 Realtime provider E2E — game_relay_frames (B안 v2).
 *
 * ⚠️ migration(20260825020000) 적용 후에만 유효. 실 Supabase Realtime·RLS 를
 * 태워 삼순 요구 축을 검증한다:
 *   ① service_role INSERT → 2-client postgres_changes 수신 (실 fanout)
 *   ② anon SELECT 는 허용(공개 read), anon INSERT 는 RLS deny
 *   ③ heartbeat 프레임도 정상 전파
 *   ④ cleanup: QA 프레임(game_id 프리픽스 한정) 삭제, 잔존 0
 *
 * 필요한 env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *            SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !anonKey || !serviceKey) {
  console.error("env 미설정 (URL/ANON/SERVICE_ROLE)");
  process.exit(2);
}

const QA_GAME_ID = `QA-RT-${Date.now()}`;
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`ok - ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

// ── ① 2-client Realtime fanout ──
const received: Array<{ kind: string; seq: number }> = [];
const channel = anon
  .channel(`qa-relay-frames:${QA_GAME_ID}`)
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "game_relay_frames", filter: `game_id=eq.${QA_GAME_ID}` },
    (msg) => {
      const n = msg.new as { kind?: string; seq?: number };
      if (n.kind && typeof n.seq === "number") received.push({ kind: n.kind, seq: n.seq });
    },
  );

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
  });
});
check("2-client subscribe SUBSCRIBED", true);

// service_role INSERT (relay-full + heartbeat)
const frames = [
  { game_id: QA_GAME_ID, seq: 1, kind: "relay-full", payload: { channel: "relay", ok: true, status: 200, data: { innings: [] } } },
  { game_id: QA_GAME_ID, seq: 2, kind: "heartbeat", payload: { channel: "relay", ok: true, status: 204, data: { heartbeat: true } } },
];
const { error: insErr } = await admin.from("game_relay_frames").insert(frames);
check("service_role INSERT 성공", !insErr, insErr?.message ?? "");

await sleep(3_000);
check("2-client 이 relay-full 수신", received.some((r) => r.kind === "relay-full"), JSON.stringify(received));
check("2-client 이 heartbeat 수신", received.some((r) => r.kind === "heartbeat"));

// ── ② RLS ──
// query-guard: bounded -- QA 전용 game_id(QA-RT-<ts>) 한정 조회, 최대 2행(이 테스트가 넣은 프레임)
const { data: anonRead, error: readErr } = await anon
  .from("game_relay_frames").select("id").eq("game_id", QA_GAME_ID);
check("anon SELECT 허용(공개 read)", !readErr && Array.isArray(anonRead) && anonRead.length >= 2, readErr?.message ?? `rows=${anonRead?.length}`);

const { error: anonInsErr } = await anon.from("game_relay_frames").insert({
  game_id: QA_GAME_ID, seq: 999, kind: "relay-full", payload: { channel: "relay", ok: true, status: 200, data: {} },
});
check("anon INSERT 는 RLS deny", !!anonInsErr, anonInsErr?.message ?? "차단 안 됨!");

// ── ④ cleanup ──
await anon.removeChannel(channel);
const { error: delErr } = await admin.from("game_relay_frames").delete().eq("game_id", QA_GAME_ID);
// query-guard: bounded -- QA 전용 game_id 한정 잔존 확인, 정상 시 0행
const { data: residue } = await admin.from("game_relay_frames").select("id").eq("game_id", QA_GAME_ID);
check("cleanup: QA 프레임 삭제·잔존 0", !delErr && (residue?.length ?? 0) === 0, `residue=${residue?.length}`);

console.log(`\nRESULT ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
