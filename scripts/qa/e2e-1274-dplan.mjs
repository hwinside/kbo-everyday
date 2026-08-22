#!/usr/bin/env node
/**
 * PR #1274 — D안 p95 runner (삼순 HOLD 4축 전부 반영).
 *
 * ── 삼순 요구 ↔ 구현 대응 ────────────────────────────────────────────────
 * ① arm당 40+ 표본(warmup 제외), 교대 전송 → QA_PAIRS 기본 22쌍(=arm당 44), fail-close
 * ② 실제 GameChat DOM A↔B 도착 측정 + 중복 0 + draft 보존 검사 (sidecar 금지)
 * ③ deterministic `isLive=true` live/detail/relay fixture 를 baseline/A1 **양쪽 동일** fulfill
 *    → multiplexActive=true 성립. 추가로 60초 network signature 로 A1 의 3초 NDJSON
 *      멀티플렉스가 **실제 활성**임을 강제(미충족 시 FAIL).
 * ④ matching POST 시작시각 기준 지연(도착 후 Date.now() 로 인한 0ms clamp 제거)
 * ⑤ 원장에 baseline/A1 build SHA · fixture manifest sha256 · patch sha256 · cleanup 기록
 *
 * ── 안전 (완화 0) ─────────────────────────────────────────────────────────
 * write 는 test-only patch 가 매핑한 `game:<past>-qa-<slug>` 로만 나간다. send-guard 의
 * room·ref 이중 결속을 그대로 통과해야 하며, 실경기방·production ref 는 여전히 전면 차단.
 * 부하 페이지는 fixture fulfill 이라 업스트림(네이버)도 건드리지 않는다.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const GAME_ID = process.env.QA_LOAD_GAME_ID || "20260821LGHH0";
const ROOM_ID = process.env.QA_TEST_ROOM ?? null;
const PAIRS = Number(process.env.QA_PAIRS || 22);      // arm당 PAIRS*2, warmup 제외 40+
const WARMUP_PAIRS = Number(process.env.QA_WARMUP_PAIRS || 1);
const PREFLIGHT_ONLY = process.env.QA_PREFLIGHT === "1";
const MIN_SAMPLES = Number(process.env.QA_MIN_SAMPLES || 40);
const SIG_WINDOW_MS = Number(process.env.QA_SIG_WINDOW_MS || 60000);

// [P0] 발송형 QA 관문 — staging ref + 승인 room 패턴이 아니면 여기서 죽는다(우회 없음).
assertSendAllowed({ roomId: ROOM_ID, purpose: "D-plan p95 measure" });

// [P0] 부하 경기는 반드시 과거(종료). fixture 로 isLive 를 켜는 것은 **표시 상태**일 뿐,
// 실제 대상 경기는 종료된 과거 경기이며 write 는 QA room 으로만 나간다.
{
  const ymd = String(GAME_ID).slice(0, 8);
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(ymd) || ymd >= todayKst) {
    console.error(`[GUARD-FAIL] QA_LOAD_GAME_ID=${GAME_ID} — 당일/미래/형식불명 금지.`);
    process.exit(1);
  }
  if (!new RegExp(`^game:${ymd}-qa-[a-z0-9-]{4,}$`).test(String(ROOM_ID))) {
    console.error(`[GUARD-FAIL] QA_TEST_ROOM=${ROOM_ID} — game:${ymd}-qa-<slug> 형식이어야 한다.`);
    process.exit(1);
  }
}

const FIX_DIR = "scripts/qa/fixtures";
const manifest = JSON.parse(readFileSync(`${FIX_DIR}/manifest.json`, "utf8"));
const fixture = {
  live: readFileSync(`${FIX_DIR}/game-live.json`, "utf8"),
  detail: readFileSync(`${FIX_DIR}/game-detail.json`, "utf8"),
  relay: readFileSync(`${FIX_DIR}/game-relay.json`, "utf8"),
};
// fixture 무결성: 실행 시점 파일이 manifest 와 다르면 측정 근거가 흔들린다 → fail-close.
for (const [k, name] of [["live", "game-live.json"], ["detail", "game-detail.json"], ["relay", "game-relay.json"]]) {
  const got = createHash("sha256").update(fixture[k]).digest("hex");
  if (got !== manifest.files[name]) {
    console.error(`[FIXTURE-FAIL] ${name} sha256 불일치 — manifest 재생성 필요.`);
    process.exit(1);
  }
}
const patchSha = createHash("sha256")
  .update(readFileSync("scripts/qa/patches/test-only-room.patch"))
  .digest("hex");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
}
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const stamp = Date.now().toString(36);
const accounts = [
  { label: "A", email: `qa-dp-a-${stamp}@keubo.fan`, password: `QaDp!${stamp}A`, nickname: `qaDpA${stamp.slice(-5)}` },
  { label: "B", email: `qa-dp-b-${stamp}@keubo.fan`, password: `QaDp!${stamp}B`, nickname: `qaDpB${stamp.slice(-5)}` },
];
let browser = null;
const blockedWrites = [];

/** baseline/A1 공통 fixture fulfill — 두 arm 이 같은 바이트를 받는다(시차 제거). */
async function installFixtures(context, netLog) {
  await context.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    netLog.push({ t: Date.now(), path: p, include: u.searchParams.get("include") ?? "" });
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body });
    if (p === "/api/game-live") return json(fixture.live);
    if (p === "/api/game-detail") return json(fixture.detail);
    if (p === "/api/game-relay") return json(fixture.relay);
    if (p === "/api/game-relay-events") {
      // NDJSON envelope — 요청한 include 채널만 담아 실제 스트림 형식을 재현한다.
      const inc = (u.searchParams.get("include") ?? "").split(",").filter(Boolean);
      const lines = [{ channel: "relay", ok: true, status: 200, data: JSON.parse(fixture.relay) }];
      if (inc.includes("events")) lines.push({ channel: "events", ok: true, status: 200, data: { events: [] } });
      if (inc.includes("live")) lines.push({ channel: "live", ok: true, status: 200, data: JSON.parse(fixture.live) });
      if (inc.includes("detail")) lines.push({ channel: "detail", ok: true, status: 200, data: JSON.parse(fixture.detail) });
      return route.fulfill({
        status: 200, contentType: "application/x-ndjson",
        body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      });
    }
    if (p === "/api/game-chat/prefs") return json(JSON.stringify({ visible: true }));
    return route.fallback();
  });
}

async function openChat(acct, base, label) {
  const netLog = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  // write 경계: guarded room 밖으로 나가는 chat write 는 네트워크에서 abort(fail-close).
  await installChatWriteInterceptor(context, ROOM_ID, (i) => blockedWrites.push({ label, ...i }));
  await installFixtures(context, netLog);
  await context.addInitScript(([at, rt]) => {
    sessionStorage.setItem("kbo-pending-session", JSON.stringify({ access_token: at, refresh_token: rt }));
  }, [acct.session.access_token, acct.session.refresh_token]);
  await context.addInitScript(() => {
    window.__qaArrivals = {};
    window.__qaTargets = [];
    window.__qaSeen = {};
    const scan = (root) => {
      const text = root.textContent || "";
      for (const t of window.__qaTargets) {
        if (text.includes(t)) {
          window.__qaSeen[t] = (window.__qaSeen[t] || 0) + 1;   // 중복 검출용
          if (!(t in window.__qaArrivals)) window.__qaArrivals[t] = Date.now();
        }
      }
    };
    new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) if (n.nodeType === 1) scan(n);
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  await page.goto(`${base}/games/${GAME_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  return { context, page, netLog, label };
}

async function composerOf(page) {
  const c = page.locator('[data-composer="game-chat"]').first();
  await c.waitFor({ state: "visible", timeout: 60000 });
  return c;
}

/** 전송: matching POST **시작시각**을 반환한다(삼순 ④ — 도착 후 clamp 방지). */
async function sendOn(page, text) {
  const c = await composerOf(page);
  const box = c.locator('textarea[name="chat-message"]');
  await box.waitFor({ state: "visible", timeout: 20000 });
  const postAt = page.waitForRequest(
    (r) => r.method() === "POST" && /\/rest\/v1\/chat_messages/.test(r.url()) && (r.postData() ?? "").includes(text),
    { timeout: 20000 },
  ).then(() => Date.now());
  for (let attempt = 1; attempt <= 10; attempt++) {
    await box.click();
    await box.fill(text);
    if ((await box.inputValue().catch(() => "")) !== text) continue;
    const btn = c.locator("button:has(svg.lucide-send)").first();
    if (await btn.isEnabled().catch(() => false)) {
      try { await btn.click({ timeout: 2000 }); break; } catch { /* retry */ }
    } else {
      await box.press("Enter").catch(() => {});
      await page.waitForTimeout(400);
      if ((await box.inputValue().catch(() => "x")) === "") break;
    }
  }
  return postAt;   // POST 가 안 나가면 timeout → 호출부에서 sendFail 로 집계
}

async function waitArrival(page, text, timeoutMs = 20000) {
  try {
    await page.waitForFunction((t) => t in (window.__qaArrivals || {}), text, { timeout: timeoutMs, polling: 20 });
    return await page.evaluate((t) => window.__qaArrivals[t], text);
  } catch { return null; }
}

/** A1 멀티플렉스 활성 증명: include=live|detail 를 실은 NDJSON 요청이 있고,
 *  standalone live/detail 폴링이 그 창에서 반복되지 않아야 한다. */
function signature(netLog, sinceMs) {
  const w = netLog.filter((r) => r.t >= sinceMs);
  const ndjson = w.filter((r) => r.path === "/api/game-relay-events");
  const embedded = ndjson.filter((r) => /live|detail/.test(r.include));
  return {
    ndjson: ndjson.length,
    embedded: embedded.length,
    standaloneLive: w.filter((r) => r.path === "/api/game-live").length,
    standaloneDetail: w.filter((r) => r.path === "/api/game-detail").length,
    standaloneRelay: w.filter((r) => r.path === "/api/game-relay").length,
  };
}

async function main() {
  console.log(`[dplan] game=${GAME_ID} room=${ROOM_ID} pairs=${PAIRS} (warmup ${WARMUP_PAIRS}) preflight=${PREFLIGHT_ONLY}`);
  console.log(`  baseline=${BASELINE_BASE}\n  a1=${A1_BASE}`);
  console.log(`  fixture manifest=${createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex").slice(0, 16)} patch=${patchSha.slice(0, 16)}`);

  for (const a of accounts) {
    const created = await admin.auth.admin.createUser({ email: a.email, password: a.password, email_confirm: true });
    if (created.error) throw new Error(`createUser ${a.label}: ${created.error.message}`);
    a.userId = created.data.user.id;
    const prof = await admin.from("profiles").upsert({ id: a.userId, nickname: a.nickname, team_id: 2002 }, { onConflict: "id" });
    if (prof.error) throw new Error(`profile ${a.label}: ${prof.error.message}`);
    const c = createClient(SUPABASE_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
    const s = await c.auth.signInWithPassword({ email: a.email, password: a.password });
    if (s.error) throw s.error;
    a.session = s.data.session;
    console.log(`  ${a.label}: ${a.userId}`);
  }

  browser = await playwright.chromium.launch();
  const arms = {};
  for (const [label, base] of [["baseline", BASELINE_BASE], ["a1", A1_BASE]]) {
    arms[label] = {
      A: await openChat(accounts[0], base, `${label}:A`),
      B: await openChat(accounts[1], base, `${label}:B`),
    };
    for (const side of ["A", "B"]) {
      await composerOf(arms[label][side].page);
      check(`[${label}:${side}] composer 표시 (실제 GameChat DOM)`, true);
    }
  }

  const sigStart = Date.now();
  const lat = { baseline: [], a1: [] };
  const missing = { baseline: [], a1: [] };
  const dups = { baseline: [], a1: [] };
  const sendFail = { baseline: 0, a1: 0 };
  const total = PREFLIGHT_ONLY ? 1 : PAIRS;

  for (let i = 1; i <= total; i++) {
    for (const label of ["baseline", "a1"]) {
      const arm = arms[label];
      // A→B, B→A 교대(방향 편향 제거). 각 방향이 1 표본.
      for (const [from, to] of [["A", "B"], ["B", "A"]]) {
        const text = `⚾ ${stamp}-${label}-${from}${to}-${i}`;
        for (const side of ["A", "B"]) {
          await arm[side].page.evaluate((t) => window.__qaTargets.push(t), text);
        }
        let t0 = null;
        try { t0 = await sendOn(arm[from].page, text); }
        catch { sendFail[label]++; continue; }
        const at = await waitArrival(arm[to].page, text);
        if (at == null) { if (i > WARMUP_PAIRS) missing[label].push(text); continue; }
        if (i > WARMUP_PAIRS) lat[label].push(at - t0);
        const seen = await arm[to].page.evaluate((t) => window.__qaSeen[t] || 0, text);
        if (seen > 1 && i > WARMUP_PAIRS) dups[label].push({ text, seen });
      }
    }
    if (i % 5 === 0) console.log(`  ...${i}/${total} pairs (baseline n=${lat.baseline.length} a1 n=${lat.a1.length})`);
  }

  // draft 보존: 전송하지 않은 입력이 폴링/리렌더로 날아가지 않아야 한다.
  for (const label of ["baseline", "a1"]) {
    const page = arms[label].A.page;
    const c = await composerOf(page);
    const box = c.locator('textarea[name="chat-message"]');
    const draft = `draft-${stamp}-${label}`;
    await box.click(); await box.fill(draft);
    await page.waitForTimeout(7000);   // 폴링 2주기 이상 경과
    check(`[${label}] draft 보존 (미전송 입력이 폴링에 안 날아감)`,
      (await box.inputValue().catch(() => "")) === draft);
    await box.fill("");
  }

  // signature 관측창은 계약(60s)을 **채워서** 판정한다. 짧은 창의 통과는
  // "아직 안 본 것"이지 "활성이 아님"도 "활성임"도 증명하지 못한다.
  // 페이지는 계속 폴링 중이므로 남은 시간만 대기하면 창이 자연히 찬다.
  while (Date.now() - sigStart < SIG_WINDOW_MS) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const sig = { baseline: signature(arms.baseline.A.netLog, sigStart), a1: signature(arms.a1.A.netLog, sigStart) };
  const elapsed = Date.now() - sigStart;
  console.log(`\nnetwork signature (${Math.round(elapsed / 1000)}s):`);
  console.log(`  baseline ${JSON.stringify(sig.baseline)}`);
  console.log(`  a1       ${JSON.stringify(sig.a1)}`);

  const bp95 = pct(lat.baseline, 95), ap95 = pct(lat.a1, 95);
  const bp50 = pct(lat.baseline, 50), ap50 = pct(lat.a1, 50);
  console.log(`\nbaseline n=${lat.baseline.length} p50=${bp50}ms p95=${bp95}ms`);
  console.log(`A1       n=${lat.a1.length} p50=${ap50}ms p95=${ap95}ms`);

  check("측정 중 chat write 차단 0 (전부 QA room 으로만 나감)", blockedWrites.length === 0, `blocked=${blockedWrites.length}`);
  check("send 실패 0", sendFail.baseline === 0 && sendFail.a1 === 0, JSON.stringify(sendFail));
  check("누락 0", missing.baseline.length === 0 && missing.a1.length === 0, `b=${missing.baseline.length} a1=${missing.a1.length}`);
  check("중복 0 (DOM 노출 1회)", dups.baseline.length === 0 && dups.a1.length === 0, `b=${dups.baseline.length} a1=${dups.a1.length}`);
  check("A1 멀티플렉스 활성 (include=live|detail NDJSON 실측)",
    sig.a1.embedded > 0, JSON.stringify(sig.a1));
  check("A1 standalone live/detail 폴링 감소 (baseline 대비)",
    sig.a1.standaloneLive + sig.a1.standaloneDetail < sig.baseline.standaloneLive + sig.baseline.standaloneDetail,
    `baseline=${sig.baseline.standaloneLive + sig.baseline.standaloneDetail} a1=${sig.a1.standaloneLive + sig.a1.standaloneDetail}`);
  check(`signature 관측창 ≥ ${SIG_WINDOW_MS / 1000}s`, elapsed >= SIG_WINDOW_MS, `${Math.round(elapsed / 1000)}s`);

  if (!PREFLIGHT_ONLY) {
    check(`arm당 표본 ≥ ${MIN_SAMPLES} (fail-close)`,
      lat.baseline.length >= MIN_SAMPLES && lat.a1.length >= MIN_SAMPLES,
      `baseline=${lat.baseline.length} a1=${lat.a1.length}`);
    check("동일 표본수", lat.baseline.length === lat.a1.length, `b=${lat.baseline.length} a1=${lat.a1.length}`);
    check("A1 p95 ≤ baseline p95 (원계약)", bp95 != null && ap95 != null && ap95 <= bp95, `baseline=${bp95}ms a1=${ap95}ms`);
  }

  const ledger = {
    stamp, mode: PREFLIGHT_ONLY ? "preflight" : "measure",
    room: ROOM_ID, gameId: GAME_ID,
    supabaseRef: new URL(SUPABASE_URL).hostname.split(".")[0],
    builds: { baseline: process.env.QA_BASELINE_SHA ?? null, a1: process.env.QA_A1_SHA ?? null },
    fixtures: manifest.files, patchSha256: patchSha,
    pairs: PAIRS, warmupPairs: WARMUP_PAIRS, signatureWindowMs: elapsed, signature: sig,
    baseline: { n: lat.baseline.length, p50: bp50, p95: bp95, samples: lat.baseline, sendFail: sendFail.baseline, missing: missing.baseline.length, dups: dups.baseline.length },
    a1: { n: lat.a1.length, p50: ap50, p95: ap95, samples: lat.a1, sendFail: sendFail.a1, missing: missing.a1.length, dups: dups.a1.length },
    blockedWrites: blockedWrites.length, results,
  };
  const out = `scripts/qa/evidence/dplan-${PREFLIGHT_ONLY ? "preflight" : "p95"}-${stamp}.json`;
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
  // query-guard: bounded -- 이번 런 고유 stamp 한정. 상한은 기대치보다 크게 잡아
  // 포화된 결과를 전수로 오독하지 않게 한다.
  const del = await admin.from("chat_messages").delete().eq("room_id", ROOM_ID).like("content", `%${stamp}%`).select("id").limit(PAIRS * 8);
  check("cleanup — 삭제 error 없음", !del.error, del.error?.message ?? `deleted=${del.data?.length ?? "?"}`);
  // query-guard: bounded -- 이번 런 고유 stamp 한정 잔존 확인. 상한은 기대치(PAIRS*4)보다
  // 크게 잡아 포화된 결과를 전수로 오독하지 않게 한다.
  const left = await admin.from("chat_messages").select("id").eq("room_id", ROOM_ID).like("content", `%${stamp}%`).limit(PAIRS * 8);
  check("postcondition — 잔존 0 (조회 성공 전제)",
    !left.error && Array.isArray(left.data) && left.data.length === 0,
    left.error ? `ERR ${left.error.message}` : `left=${left.data?.length}`);
  for (const a of accounts) {
    if (!a.userId) continue;
    await admin.auth.admin.deleteUser(a.userId).catch(() => {});
    await admin.from("profiles").delete().eq("id", a.userId);
    const probe = await admin.auth.admin.getUserById(a.userId);
    const gone = probe.error && (probe.error.status === 404 || /user_not_found/i.test(probe.error.code ?? ""));
    check(`postcondition — ${a.label} not-found 증명`, !!gone, probe.error ? `${probe.error.status} ${probe.error.code ?? ""}` : "still exists");
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 요약 === 총 ${results.length} · PASS ${pass} · FAIL ${results.length - pass}`);
  process.exit(failed ? 1 : 0);
}
