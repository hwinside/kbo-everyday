#!/usr/bin/env node
/**
 * PR #1274 — 인터리브 쌍측정 (순차 측정의 방 트래픽 노이즈 상쇄).
 * 같은 계정 2개로 PROD/A1 각각 컨텍스트를 동시에 열고(총 4페이지, 같은 방),
 * 메시지를 PROD→A1 교대로 즉시 연속 전송해 같은 방 상태에서 쌍을 만든다.
 * 계약: 누락·중복 0 · send 실패 0 · 동일 표본수 · A1 p95 ≤ PROD p95.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { assertSendAllowed, installChatWriteInterceptor, installFixtureRoomRewrite } from "./send-guard.mjs";

const ENV_PATH = "/Users/harinclaw/Projects/kbo-everyday/.env.local";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_BASE = "https://keubo.fan";
const A1_BASE = process.env.QA_A1_BASE || "http://localhost:3103";
const GAME_ID = process.env.QA_GAME_ID || "20260821LGHH0";
// 격리 staging 전용 — 실경기방(game:*) 은 send-guard 가 차단한다. 반드시 qa-fixture:* 를 env 로 지정.
const ROOM_ID = process.env.QA_FIXTURE_ROOM ?? null;
// [P0] 실유저 공간 발송 영구 차단 — production ref/공개 경기방이면 여기서 죽는다(우회 없음).
assertSendAllowed({ roomId: ROOM_ID, purpose: "chat send QA" });



// [P0 GUARD 2026-08-21] 라이브/당일/미래 경기 방 발송 절대 금지 (실유저 노출 사고 재발 방지)
// 종료가 확정된 과거 날짜 경기 또는 더미 room_id만 허용. QA_ALLOW_LIVE 같은 우회 플래그 금지.
// (2026-08-22: 격리 staging 도입 후에도 이 가드는 유지한다 — 방어는 겹칠수록 좋고,
//  p95 부하는 라이브 경기가 아니라 합성 부하 발생기로 재현한다.)
{
  const ymd = String(GAME_ID).slice(0, 8);
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(ymd) || ymd >= todayKst) {
    console.error(`[GUARD-FAIL] GAME_ID=${GAME_ID} — 당일/미래/형식불명 경기 방은 발송 금지. 과거(종료) 경기로만 실행하세요.`);
    process.exit(1);
  }
}const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAIRS = Number(process.env.QA_PAIRS || 12);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
}
const stamp = Date.now().toString(36);
const accounts = [
  { label: "A", email: `qa-pair-a-${stamp}@keubo.fan`, password: `QaPr!${stamp}A`, nickname: `qaPrA${stamp.slice(-5)}` },
  { label: "B", email: `qa-pair-b-${stamp}@keubo.fan`, password: `QaPr!${stamp}B`, nickname: `qaPrB${stamp.slice(-5)}` },
];
let browser = null;

async function setupAccount(a) {
  const created = await admin.auth.admin.createUser({ email: a.email, password: a.password, email_confirm: true });
  if (created.error) throw new Error(`createUser ${a.label}: ${created.error.message}`);
  a.userId = created.data.user.id;
  const prof = await admin.from("profiles").upsert({ id: a.userId, nickname: a.nickname, team_id: 2002 }, { onConflict: "id" });
  if (prof.error) throw new Error(`profile ${a.label}: ${prof.error.message}`);
  const c = createClient(SUPABASE_URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const signed = await c.auth.signInWithPassword({ email: a.email, password: a.password });
  if (signed.error || !signed.data.session) throw signed.error ?? new Error(`sign-in ${a.label}`);
  a.session = signed.data.session;
  console.log(`  ${a.label}: ${a.userId}`);
}

async function openPage(a, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  // 단일 결속: guard 승인 room 밖으로 나가는 chat write 는 네트워크 경계에서 abort (fail-close)
  await installChatWriteInterceptor(context, ROOM_ID);
  // rewrite 는 guard 뒤에 등록 → 먼저 실행 → guard 가 재작성된 최종 body 를 검증한다.
  await installFixtureRoomRewrite(context, ROOM_ID);
  await context.addInitScript(([at, rt]) => {
    sessionStorage.setItem("kbo-pending-session", JSON.stringify({ access_token: at, refresh_token: rt }));
  }, [a.session.access_token, a.session.refresh_token]);
  await context.addInitScript(() => {
    window.__qaArrivals = window.__qaArrivals || {};
    window.__qaTargets = window.__qaTargets || [];
    const record = (root) => {
      const text = root.textContent || "";
      for (const t of window.__qaTargets) {
        if (!(t in window.__qaArrivals) && text.includes(t)) window.__qaArrivals[t] = Date.now();
      }
    };
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) { if (n.nodeType === 1) record(n); }
    });
    mo.observe(document, { childList: true, subtree: true });
    window.__qaObserverReady = true;
  });
  const page = await context.newPage();
  await page.goto(`${base}/games/${GAME_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  return { context, page };
}

async function composerOf(page) {
  const c = page.locator('[data-composer="game-chat"]').first();
  await c.waitFor({ state: "visible", timeout: 60000 });
  return c;
}

async function sendOn(page, text) {
  const c = await composerOf(page);
  const box = c.locator('textarea[name="chat-message"]');
  await box.waitFor({ state: "visible", timeout: 20000 });
  for (let attempt = 1; attempt <= 12; attempt++) {
    await box.click();
    await box.fill(text);
    await page.waitForTimeout(150);
    const val = await box.inputValue().catch(() => "");
    if (val !== text) continue;
    const btn = c.locator("button:has(svg.lucide-send)").first();
    if (await btn.isEnabled().catch(() => false)) {
      try { await btn.click({ timeout: 2000 }); return; } catch { /* retry */ }
    } else {
      await box.press("Enter").catch(() => {});
      await page.waitForTimeout(450);
      if ((await box.inputValue().catch(() => "x")) === "") return;
    }
  }
  throw new Error(`send failed: ${text}`);
}

async function waitArrival(page, text, sendAtMs, timeoutMs = 30000) {
  try {
    const h = await page.waitForFunction((t) => window.__qaArrivals && window.__qaArrivals[t], text, { timeout: timeoutMs, polling: 50 });
    return Math.max(0, (await h.jsonValue()) - sendAtMs);
  } catch { return null; }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const sent = [];
async function measurePair(envName, senderPage, receiverPage, text, latencies, sendFails) {
  try {
    await receiverPage.evaluate((x) => { (window.__qaTargets = window.__qaTargets || []).push(x); }, text);
    await sendOn(senderPage, text);
    const at = Date.now();
    sent.push({ text, env: envName });
    const ms = await waitArrival(receiverPage, text, at);
    check(`[${envName}] ${text.slice(-8)} 수신`, ms !== null, ms !== null ? `${ms}ms` : "timeout(누락)");
    if (ms !== null) latencies.push(ms);
  } catch (e) {
    sendFails.push(`${envName}:${text.slice(-8)}`);
    check(`[${envName}] ${text.slice(-8)} 수신`, false, `send: ${e.message.slice(0, 60)}`);
  }
}

async function cleanup(pages) {
  console.log("\n[cleanup]");
  for (const p of pages) { try { await p.context.close(); } catch { /* noop */ } }
  const errs = [];
  const del = await admin.from("chat_messages").delete().eq("room_id", ROOM_ID)
    .in("user_id", accounts.map((a) => a.userId).filter(Boolean));
  if (del.error) errs.push(`messages: ${del.error.message}`);
  for (const a of accounts) {
    if (!a.userId) continue;
    const pr = await admin.from("profiles").delete().eq("id", a.userId);
    if (pr.error) errs.push(`profile ${a.label}: ${pr.error.message}`);
    const u = await admin.auth.admin.deleteUser(a.userId);
    if (u.error) errs.push(`user ${a.label}: ${u.error.message}`);
  }
  check("cleanup — 삭제 error 없음", errs.length === 0, errs.join(" / ") || "all null");
  // query-guard: bounded -- 이번 런 QA 계정(최대 4명) user_id in() 한정 조회다.
  const left = await admin.from("chat_messages").select("id").eq("room_id", ROOM_ID)
    .in("user_id", accounts.map((a) => a.userId).filter(Boolean));
  check("postcondition — 잔존 0 (조회 성공 전제)", !left.error && Array.isArray(left.data) && left.data.length === 0,
    left.error ? `ERR ${left.error.message}` : `left=${left.data?.length}`);
  for (const a of accounts) {
    if (!a.userId) continue;
    const g = await admin.auth.admin.getUserById(a.userId);
    const gone = g.error && (g.error.status === 404 || g.error.code === "user_not_found");
    check(`postcondition — ${a.label} not-found 증명`, Boolean(gone), g.error ? `${g.error.status ?? g.error.code}` : "still exists");
  }
  if (browser) await browser.close().catch(() => {});
}

async function main() {
  console.log(`[paired] game=${GAME_ID} pairs=${PAIRS}\n  prod=${PROD_BASE}\n  a1=${A1_BASE}`);
  for (const a of accounts) await setupAccount(a);
  browser = await playwright.chromium.launch({ headless: true, executablePath: CHROME });
  const prodA = await openPage(accounts[0], PROD_BASE);
  const prodB = await openPage(accounts[1], PROD_BASE);
  const a1A = await openPage(accounts[0], A1_BASE);
  const a1B = await openPage(accounts[1], A1_BASE);
  const pages = [prodA, prodB, a1A, a1B];
  for (const [i, p] of pages.entries()) await composerOf(p.page).then(() => console.log(`  page${i} composer ok`));

  const prodLat = [];
  const a1Lat = [];
  const sendFails = [];
  for (let i = 1; i <= PAIRS; i++) {
    // 교대 순서도 편향 없게 번갈아: 홀수 pair 는 PROD 먼저, 짝수 pair 는 A1 먼저
    const first = i % 2 === 1 ? "PROD" : "A1";
    const jobs = [
      ["PROD", prodA.page, prodB.page, `⚾ ${stamp}-P-${i}`, prodLat],
      ["A1", a1A.page, a1B.page, `⚾ ${stamp}-M-${i}`, a1Lat],
    ];
    if (first === "A1") jobs.reverse();
    for (const [env, sp, rp, text, lat] of jobs) {
      await measurePair(env, sp, rp, text, lat, sendFails);
    }
  }

  // 누락·중복: 수신자 DOM 1건 + DB 1건
  let dupFail = 0;
  for (const m of sent) {
    const rp = m.env === "PROD" ? prodB.page : a1B.page;
    const dom = await rp.locator(`[data-chat-msg]:has-text(${JSON.stringify(m.text)})`).count();
    // query-guard: bounded -- 이번 런 고유 stamp content 완전일치 1건 기대 조회다.
    const { data: rows, error } = await admin.from("chat_messages").select("id").eq("room_id", ROOM_ID).eq("content", m.text);
    if (error || dom !== 1 || (rows?.length ?? -1) !== 1) {
      dupFail++;
      console.log(`    dup? ${m.text} dom=${dom} db=${error ? "ERR" : rows?.length}`);
    }
  }
  check("중복 0 (DOM·DB 각 정확히 1건)", dupFail === 0, `violations=${dupFail}`);
  check("send/retry 실패 0", sendFails.length === 0, sendFails.join(",") || "0");
  check("동일 표본수", prodLat.length === a1Lat.length && prodLat.length === PAIRS,
    `prod=${prodLat.length} a1=${a1Lat.length} 기대=${PAIRS}`);
  const pp = { p50: pct(prodLat, 50), p95: pct(prodLat, 95) };
  const ap = { p50: pct(a1Lat, 50), p95: pct(a1Lat, 95) };
  console.log(`\nPROD n=${prodLat.length} p50=${pp.p50} p95=${pp.p95} [${prodLat.join(",")}]`);
  console.log(`A1   n=${a1Lat.length} p50=${ap.p50} p95=${ap.p95} [${a1Lat.join(",")}]`);
  check("A1 p95 ≤ baseline p95 (원계약)", ap.p95 !== null && pp.p95 !== null && ap.p95 <= pp.p95,
    `baseline=${pp.p95}ms a1=${ap.p95}ms`);
  writeFileSync(`/Users/harinclaw/.openclaw/workspace/state/qa/paired-1274-${stamp}.json`,
    JSON.stringify({ stamp, gameId: GAME_ID, interleaved: true, prod: { ...pp, latencies: prodLat }, a1: { ...ap, latencies: a1Lat }, results }, null, 2));
  console.log(`원장: state/qa/paired-1274-${stamp}.json`);
  await cleanup(pages);
}

main().catch(async (e) => {
  console.error("UNCAUGHT:", e.message);
  failed++;
  try { await cleanup([]); } catch { /* noop */ }
}).finally(() => {
  const passN = results.filter((r) => r.ok).length;
  console.log(`\n=== 요약 === 총 ${results.length} · PASS ${passN} · FAIL ${results.length - passN}`);
  process.exit(failed ? 1 : 0);
});
