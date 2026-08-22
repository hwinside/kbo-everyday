#!/usr/bin/env node
/**
 * PR #1274 — 격리 staging p95 측정 (부하=실페이지 폴링 / 측정=격리 fixture room).
 *
 * ── 왜 이 구조인가 (2026-08-22 실측으로 도달) ────────────────────────────
 * 원계약은 "A1 폴링 부하 아래의 채팅 수신 p95 ≤ baseline". 이를 UI 로 그대로
 * 재현하려면 채팅 write 가 `game:${gameId}` 로 나가는데, 그 room 은 send-guard 가
 * 영구 차단한다(8/21 라이브 노출 사고 방어). 그렇다고 guard 를 완화하는 건
 * 측정 편의로 P0 를 깎는 짓이고(실제로 시도했다가 selftest 가 RED 로 잡음),
 * 앱 코드에 QA 분기를 넣는 건 이 PR 의 `chat transport untouched` 계약 위반이다.
 * QA 네임스페이스 gameId 는 네이버에 실경기가 없어 페이지가 통째로 404 가 된다
 * (실측: "경기를 찾을 수 없습니다", composer 부재의 진짜 원인).
 *
 * → 두 축을 분리한다. 어느 방어층도 건드리지 않는다:
 *   부하(load)   : 실제 과거 경기 페이지를 baseline/A1 양쪽에서 연다. **읽기 전용** —
 *                  채팅 write 는 단 1건도 하지 않는다(인터셉터로 강제 차단·카운트).
 *                  이게 곧 PR 이 바꾼 폴링 경로(28회/분 → 3초 단일 NDJSON)를 태운다.
 *   측정(measure): 앱과 동일한 supabase-js realtime 구독으로 격리 `qa-fixture:*`
 *                  room 에서 insert → 수신 지연을 잰다. 실유저 공간과 무관.
 *
 * 계약: 누락 0 · send 실패 0 · 동일 표본수 · A1 p95 ≤ baseline p95.
 * 부수 계약: 측정 전 구간 chat write 차단 카운트 == 0 (부하 페이지가 조용함을 실증).
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { assertSendAllowed, installChatWriteInterceptor } from "./send-guard.mjs";

const ENV_PATH = process.env.QA_ENV_PATH || "/Users/harinclaw/Projects/kbo-everyday/.env.local";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASELINE_BASE = process.env.QA_BASELINE_BASE || "http://localhost:3012";
const A1_BASE = process.env.QA_A1_BASE || "http://localhost:3011";
const LOAD_GAME_ID = process.env.QA_LOAD_GAME_ID || "20260821LGHH0";
const ROOM_ID = process.env.QA_FIXTURE_ROOM ?? null;
const ROUNDS = Number(process.env.QA_ROUNDS || 14);
const WARMUP = Number(process.env.QA_WARMUP || 2);

// [P0] 발송형 QA 관문 — staging ref + 비공개 fixture room 이 아니면 여기서 죽는다.
assertSendAllowed({ roomId: ROOM_ID, purpose: "staging p95 measure" });

// [P0] 부하용 gameId 는 반드시 과거(종료) 경기. 당일·미래 금지(우회 플래그 없음).
// 이 페이지는 읽기 전용으로만 쓰지만, 가드는 완화하지 않고 그대로 통과시킨다.
{
  const ymd = String(LOAD_GAME_ID).slice(0, 8);
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(ymd) || ymd >= todayKst) {
    console.error(`[GUARD-FAIL] QA_LOAD_GAME_ID=${LOAD_GAME_ID} — 당일/미래/형식불명 금지.`);
    process.exit(1);
  }
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
}

const stamp = Date.now().toString(36);
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

let browser = null;
const blockedWrites = [];
const account = { email: `qa-p95-${stamp}@keubo.fan`, password: `QaP9!${stamp}`, nickname: `qaP95${stamp.slice(-5)}` };

async function openLoadPage(base, label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  // 부하 페이지는 읽기 전용이어야 한다. chat write 가 나가면 차단하고 기록한다
  // (guarded room 은 fixture — 실경기방 write 는 구조적으로 전부 차단된다).
  await installChatWriteInterceptor(context, ROOM_ID, (i) => blockedWrites.push({ label, ...i }));
  const page = await context.newPage();
  await page.goto(`${base}/games/${LOAD_GAME_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  return { context, page, label };
}

async function measure(label, rounds) {
  // 앱과 동일한 supabase-js realtime 구독 경로.
  const sub = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    accessToken: async () => account.session.access_token,
  });
  const arrivals = new Map();
  const channel = sub
    .channel(`p95-${label}-${stamp}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${ROOM_ID}` },
      (payload) => {
        const t = payload?.new?.content;
        if (t && !arrivals.has(t)) arrivals.set(t, Date.now());
      });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`subscribe timeout (${label})`)), 30000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") { clearTimeout(to); resolve(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(to); reject(new Error(`subscribe ${status}`)); }
    });
  });

  const writer = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    accessToken: async () => account.session.access_token,
  });

  const lat = [];
  const missing = [];
  let sendFail = 0;
  for (let i = 1; i <= rounds; i++) {
    const text = `⚾ ${stamp}-${label}-${i}`;
    const t0 = Date.now();
    const { error } = await writer.from("chat_messages").insert({ room_id: ROOM_ID, user_id: account.userId, content: text });
    if (error) { sendFail++; continue; }
    const deadline = Date.now() + 20000;
    while (!arrivals.has(text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (arrivals.has(text)) {
      if (i > WARMUP) lat.push(arrivals.get(text) - t0);
    } else if (i > WARMUP) missing.push(text);
    await new Promise((r) => setTimeout(r, 400));
  }
  await sub.removeChannel(channel);
  return { lat, missing, sendFail };
}

async function main() {
  console.log(`[staging-p95] load_game=${LOAD_GAME_ID} room=${ROOM_ID} rounds=${ROUNDS} (warmup ${WARMUP})`);
  console.log(`  baseline=${BASELINE_BASE}\n  a1=${A1_BASE}`);

  const created = await admin.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true });
  if (created.error) throw new Error(`createUser: ${created.error.message}`);
  account.userId = created.data.user.id;
  const prof = await admin.from("profiles").upsert({ id: account.userId, nickname: account.nickname, team_id: 2002 }, { onConflict: "id" });
  if (prof.error) throw new Error(`profile: ${prof.error.message}`);
  const signIn = createClient(SUPABASE_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const signed = await signIn.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signed.error) throw signed.error;
  account.session = signed.data.session;
  console.log(`  account: ${account.userId}`);

  browser = await playwright.chromium.launch();
  const runs = {};
  for (const [label, base] of [["baseline", BASELINE_BASE], ["a1", A1_BASE]]) {
    const load = await openLoadPage(base, label);
    // 폴링이 정상 궤도에 오를 시간을 준다(두 빌드 동일).
    await load.page.waitForTimeout(8000);
    const notFound = await load.page.evaluate(() => (document.body.innerText || "").includes("경기를 찾을 수 없"));
    check(`[${label}] 부하 페이지 렌더 (경기 데이터 존재)`, !notFound, notFound ? "not-found 페이지" : "ok");
    runs[label] = await measure(label, ROUNDS);
    await load.context.close();
  }

  const b = runs.baseline, a = runs.a1;
  const bp95 = pct(b.lat, 95), ap95 = pct(a.lat, 95);
  const bp50 = pct(b.lat, 50), ap50 = pct(a.lat, 50);

  console.log(`\nbaseline n=${b.lat.length} p50=${bp50}ms p95=${bp95}ms`);
  console.log(`A1       n=${a.lat.length} p50=${ap50}ms p95=${ap95}ms`);

  check("측정 중 chat write 차단 0 (부하 페이지 읽기 전용 실증)", blockedWrites.length === 0, `blocked=${blockedWrites.length}`);
  check("send 실패 0", b.sendFail === 0 && a.sendFail === 0, `baseline=${b.sendFail} a1=${a.sendFail}`);
  check("누락 0", b.missing.length === 0 && a.missing.length === 0, `baseline=${b.missing.length} a1=${a.missing.length}`);
  check("동일 표본수", b.lat.length === a.lat.length && b.lat.length === ROUNDS - WARMUP, `baseline=${b.lat.length} a1=${a.lat.length} 기대=${ROUNDS - WARMUP}`);
  check("A1 p95 ≤ baseline p95 (원계약)", bp95 != null && ap95 != null && ap95 <= bp95, `baseline=${bp95}ms a1=${ap95}ms`);

  const ledger = {
    stamp, room: ROOM_ID, loadGameId: LOAD_GAME_ID, supabaseRef: new URL(SUPABASE_URL).hostname.split(".")[0],
    baselineBase: BASELINE_BASE, a1Base: A1_BASE, rounds: ROUNDS, warmup: WARMUP,
    baseline: { n: b.lat.length, p50: bp50, p95: bp95, samples: b.lat, sendFail: b.sendFail, missing: b.missing.length },
    a1: { n: a.lat.length, p50: ap50, p95: ap95, samples: a.lat, sendFail: a.sendFail, missing: a.missing.length },
    blockedWrites: blockedWrites.length, results,
  };
  const out = `scripts/qa/evidence/staging-p95-${stamp}.json`;
  writeFileSync(out, JSON.stringify(ledger, null, 1));
  console.log(`원장: ${out}`);
}

try {
  await main();
} catch (e) {
  console.error("UNCAUGHT:", e?.message ?? e);
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  console.log("\n[cleanup]");
  const del = await admin.from("chat_messages").delete().eq("room_id", ROOM_ID).like("content", `%${stamp}%`).select("id");
  check("cleanup — 삭제 error 없음", !del.error, del.error?.message ?? `deleted=${del.data?.length ?? "?"}`);
  const left = await admin.from("chat_messages").select("id").eq("room_id", ROOM_ID).like("content", `%${stamp}%`);
  check("postcondition — 잔존 0 (조회 성공 전제)",
    !left.error && Array.isArray(left.data) && left.data.length === 0,
    left.error ? `ERR ${left.error.message}` : `left=${left.data?.length}`);
  if (account.userId) {
    await admin.auth.admin.deleteUser(account.userId).catch(() => {});
    await admin.from("profiles").delete().eq("id", account.userId);
    const probe = await admin.auth.admin.getUserById(account.userId);
    const gone = probe.error && (probe.error.status === 404 || /user_not_found/i.test(probe.error.code ?? ""));
    check("postcondition — 계정 not-found 증명", !!gone, probe.error ? `${probe.error.status} ${probe.error.code ?? ""}` : "still exists");
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 요약 === 총 ${results.length} · PASS ${pass} · FAIL ${results.length - pass}`);
  process.exit(failed ? 1 : 0);
}
