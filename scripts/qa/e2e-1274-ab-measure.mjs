#!/usr/bin/env node
/**
 * PR #1274 A1 멀티플렉스 — 삼순 5차 리뷰 설계안 그대로의 A/B 실측.
 *
 * 설계 (삼순 지정):
 *  - Preview 두 브라우저 context 에서 "오직 최초 /api/game-live 만" 현재 Production 200
 *    live payload 로 route-fulfill 해 isLive 를 켠다.
 *  - /api/game-relay-events 와 Supabase Realtime 은 실제 Preview 경로 그대로.
 *  - 같은 기기/계정/경기로 Production baseline → Preview A1 순서, 각 3회(라운드):
 *    누락·중복 0, 원격 도착 p95 비열화, 60초 네트워크 카운트
 *    (relay-family 20 · standalone live/detail 0 · include events/live/detail 4/7/2).
 *
 * P0: 하린아빠/공유 계정 금지 → 일회용 계정 2개 생성, 종료 시 삭제 + error 결속 postcondition.
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { assertSendAllowed, installChatWriteInterceptor, installFixtureRoomRewrite } from "./send-guard.mjs";

const ENV_PATH = process.env.QA_ENV_PATH || "/Users/harinclaw/Projects/kbo-everyday/.env.local";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_BASE = "https://keubo.fan";
const PREVIEW_BASE = process.env.QA_PREVIEW_BASE
  || "https://kbo-everyday-git-perf-live-poll-multiplex-hwinsides-projects.vercel.app";
const BYPASS = process.env.VERCEL_BYPASS || process.env.VERCEL_PROTECTION_BYPASS_TOKEN || "";
const GAME_ID = process.env.QA_GAME_ID || "20260821KTSK0";
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
}const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROUNDS = Number(process.env.QA_ROUNDS || 3);
const NET_WINDOW_MS = Number(process.env.QA_NET_WINDOW_MS || 60000);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
}

const stamp = Date.now().toString(36);
const accounts = [
  { label: "A", email: `qa-ab-a-${stamp}@keubo.fan`, password: `QaAbA!${stamp}`, nickname: `qaAbA${stamp.slice(-5)}` },
  { label: "B", email: `qa-ab-b-${stamp}@keubo.fan`, password: `QaAbB!${stamp}`, nickname: `qaAbB${stamp.slice(-5)}` },
];
let browser = null;
const sentTexts = []; // { text, senderIdx, env }
const sendFailures = [];

async function setupAccount(a) {
  const created = await admin.auth.admin.createUser({
    email: a.email, password: a.password, email_confirm: true,
  });
  if (created.error) throw new Error(`createUser ${a.label}: ${created.error.message}`);
  a.userId = created.data.user.id;
  const prof = await admin.from("profiles").upsert(
    { id: a.userId, nickname: a.nickname, team_id: 2002 }, { onConflict: "id" },
  );
  if (prof.error) throw new Error(`profile ${a.label}: ${prof.error.message}`);
  const authClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signed = await authClient.auth.signInWithPassword({ email: a.email, password: a.password });
  if (signed.error || !signed.data.session) throw signed.error ?? new Error(`sign-in ${a.label}`);
  a.session = signed.data.session;
  console.log(`  ${a.label}: ${a.userId} nick=${a.nickname}`);
}

async function fetchProdLivePayload() {
  const res = await fetch(`${PROD_BASE}/api/game-live?date=${GAME_ID.slice(0, 8)}`);
  if (!res.ok) throw new Error(`prod game-live ${res.status}`);
  const body = await res.text();
  const games = JSON.parse(body).games ?? [];
  const target = games.find((g) => g.gameId === GAME_ID);
  if (!target?.isLive) throw new Error(`game ${GAME_ID} not live in prod payload`);
  return body;
}

function newNetCounter() {
  return {
    active: false,
    relayFamily: 0,
    standaloneLive: 0,
    standaloneDetail: 0,
    include: { events: 0, live: 0, detail: 0 },
    urls: [],
  };
}

async function openUi(a, base, { fulfillLivePayload = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  // 단일 결속: guard 승인 room 밖으로 나가는 chat write 는 네트워크 경계에서 abort (fail-close)
  await installChatWriteInterceptor(context, ROOM_ID);
  // rewrite 는 guard 뒤에 등록 → 먼저 실행 → guard 가 재작성된 최종 body 를 검증한다.
  await installFixtureRoomRewrite(context, ROOM_ID);
  await context.addInitScript(
    ([at, rt]) => {
      sessionStorage.setItem("kbo-pending-session", JSON.stringify({
        access_token: at, refresh_token: rt,
      }));
    },
    [a.session.access_token, a.session.refresh_token],
  );
  // event-driven 수신시각: MutationObserver 가 DOM 삽입 순간을 기록.
  // 앱이 세션 주입 후 하드 리로드를 하므로 1회성 evaluate 가 아니라
  // addInitScript 로 설치해 내비게이션마다 다시 붙는다 (run5 0표본 원인).
  await context.addInitScript(() => {
    window.__qaArrivals = window.__qaArrivals || {};
    window.__qaTargets = window.__qaTargets || [];
    // regex 키 추출은 인접 텍스트(시각 등)의 숫자를 삼켜 키가 어긋난다(diag 실측:
    // "r1-1" 이 "r1-122" 로 기록). 사전 등록된 타깃 문자열 포함 검사로 판정한다.
    const record = (root) => {
      const text = root.textContent || "";
      for (const t of window.__qaTargets) {
        if (!(t in window.__qaArrivals) && text.includes(t)) window.__qaArrivals[t] = Date.now();
      }
    };
    // init script 시점엔 documentElement 가 아직 없다(run6 ready:false 실측).
    // document 자체는 항상 존재하므로 이를 observe 대상으로 쓴다.
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) {
        if (n.nodeType === 1) record(n);
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    window.__qaObserverReady = true;
  });
  a.net = newNetCounter();
  a.fulfilled = 0;
  if (fulfillLivePayload) {
    // 최초 1회만 fulfill 하면 이후 실제 Preview 503 이 isLive 를 도로 꺼서
    // multiplex 가 죽는다(1차 실측). 전부 fulfill 하되, 계측창 안에서
    // game-live "요청이 발생했다는 사실" 자체를 standalone 카운트로 판정한다
    // — A1 정상이면 계측창 60초 동안 요청 0회여야 하므로 검출력은 동일하다.
    await context.route("**/api/game-live*", async (route) => {
      a.fulfilled += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: fulfillLivePayload,
      });
    });
  }
  const page = await context.newPage();
  page.on("request", (req) => {
    if (!a.net.active) return;
    const url = req.url();
    if (url.includes("/api/game-relay-events")) {
      a.net.relayFamily += 1;
      try {
        const u = new URL(url);
        const inc = (u.searchParams.get("include") || "").split(",").filter(Boolean);
        for (const ch of inc) {
          if (ch in a.net.include) a.net.include[ch] += 1;
        }
      } catch { /* noop */ }
      a.net.urls.push(url.slice(url.indexOf("/api/")));
    } else if (url.includes("/api/game-live")) {
      a.net.standaloneLive += 1;
      a.net.urls.push(url.slice(url.indexOf("/api/")));
    } else if (url.includes("/api/game-relay?") || url.endsWith("/api/game-relay")) {
      a.net.relayLegacy = (a.net.relayLegacy ?? 0) + 1;
      a.net.urls.push(url.slice(url.indexOf("/api/")));
    } else if (url.includes("/api/game-detail")) {
      a.net.standaloneDetail += 1;
      a.net.urls.push(url.slice(url.indexOf("/api/")));
    }
  });
  const bypassQ = base === PREVIEW_BASE && BYPASS
    ? `?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${BYPASS}`
    : "";
  await page.goto(`${base}/games/${GAME_ID}${bypassQ}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  a.context = context;
  a.page = page;
  return page;
}

async function composer(a) {
  const c = a.page.locator('[data-composer="game-chat"]').first();
  await c.waitFor({ state: "visible", timeout: 60000 });
  return c;
}

async function sendMessage(a, text) {
  const c = await composer(a);
  const box = c.locator('textarea[name="chat-message"]');
  await box.waitFor({ state: "visible", timeout: 20000 });
  // 3초 frame 재렌더로 controlled input 이 리셋될 수 있어 fill→검증→재시도 루프.
  for (let attempt = 1; attempt <= 12; attempt++) {
    await box.click();
    await box.fill(text);
    await a.page.waitForTimeout(150);
    const val = await box.inputValue().catch(() => "");
    if (val !== text) continue; // 재렌더가 지움 — 재시도
    const btn = c.locator("button:has(svg.lucide-send)").first();
    const enabled = await btn.isEnabled().catch(() => false);
    if (enabled) {
      try {
        await btn.click({ timeout: 2000 });
        return;
      } catch { /* 재렌더로 detach — 재시도 */ }
    } else {
      // 버튼이 안 풀리면 Enter 전송 fallback
      await box.press("Enter").catch(() => {});
      await a.page.waitForTimeout(450);
      const after = await box.inputValue().catch(() => "");
      if (after === "") return; // 전송됨
    }
  }
  throw new Error(`send failed after retries: ${text}`);
}

async function waitArrival(a, text, sendAtMs, timeoutMs = 30000) {
  // 같은 머신이므로 Node Date.now 와 page Date.now 는 동일 클럭.
  try {
    const arrival = await a.page.waitForFunction(
      (t) => window.__qaArrivals && window.__qaArrivals[t],
      text,
      { timeout: timeoutMs, polling: 50 },
    );
    const at = await arrival.jsonValue();
    return Math.max(0, at - sendAtMs);
  } catch {
    // 진단: observer 상태·기록 키·DOM 존재 여부를 함께 남긴다 (0표본 규명용)
    try {
      const diag = await a.page.evaluate((t) => ({
        ready: window.__qaObserverReady === true,
        keys: Object.keys(window.__qaArrivals || {}).slice(0, 5),
        qsa: document.querySelectorAll("[data-chat-msg]").length,
        found: [...document.querySelectorAll("[data-chat-msg]")].some((e) => (e.textContent || "").includes(t)),
      }), text);
      console.log(`    [diag ${a.label}] ${JSON.stringify(diag)}`);
    } catch { /* noop */ }
    return null;
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

async function measureEnv(envName, base, { fulfillLivePayload = null } = {}) {
  console.log(`\n=== [${envName}] ${base} ===`);
  for (const a of accounts) {
    await openUi(a, base, { fulfillLivePayload });
  }
  for (const a of accounts) {
    let okC = true;
    try { await composer(a); } catch { okC = false; }
    check(`[${envName}] ${a.label} 채팅 작성창 노출`, okC);
    if (!okC) throw new Error(`${envName} composer missing for ${a.label}`);
  }

  // —— 60초 네트워크 창 (A 컨텍스트 기준) ——
  console.log(`  [${envName}] 네트워크 60초 계측 시작...`);
  accounts[0].net = newNetCounter();
  accounts[0].net.active = true;
  await new Promise((r) => setTimeout(r, NET_WINDOW_MS));
  accounts[0].net.active = false;
  const n = accounts[0].net;
  console.log(`  [${envName}] relay-events=${n.relayFamily} legacy-relay=${n.relayLegacy ?? 0} standalone live=${n.standaloneLive} detail=${n.standaloneDetail} include=${JSON.stringify(n.include)}`);

  // —— draft 보존 (frame 재렌더가 입력을 지우면 실사용 회귀) ——
  {
    const c = await composer(accounts[0]);
    const box = c.locator('textarea[name="chat-message"]');
    const sentinel = `draft-${stamp}`;
    await box.click();
    await box.fill(sentinel);
    await accounts[0].page.waitForTimeout(4000); // 3초 cadence 1회 이상 통과
    const kept = await box.inputValue().catch(() => "");
    check(`[${envName}] 입력 draft 4초(프레임 1주기+) 보존`, kept === sentinel,
      kept === sentinel ? "" : `value="${kept}"`);
    await box.fill("");
  }

  // —— 채팅 라운드 ——
  const latencies = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const msgs = [];
    for (let i = 1; i <= 3; i++) {
      const t = `⚾ ${stamp}-${envName}-r${r}-${i}`;
      try {
        await accounts[1].page.evaluate((x) => { (window.__qaTargets = window.__qaTargets || []).push(x); }, t);
        await sendMessage(accounts[0], t);
        const sendAt = Date.now();
        msgs.push({ text: t, senderIdx: 0 });
        sentTexts.push({ text: t, senderIdx: 0, env: envName });
        const ms = await waitArrival(accounts[1], t, sendAt);
        check(`[${envName}] r${r}-${i} A→B 수신`, ms !== null, ms !== null ? `${ms}ms` : "timeout(누락)");
        if (ms !== null) latencies.push(ms);
      } catch (e) {
        sendFailures.push(`${envName} r${r}-${i}`);
        check(`[${envName}] r${r}-${i} A→B 수신`, false, `send: ${e.message.slice(0, 80)}`);
      }
    }
    const tb = `⚾ ${stamp}-${envName}-r${r}-B`;
    try {
      await accounts[0].page.evaluate((x) => { (window.__qaTargets = window.__qaTargets || []).push(x); }, tb);
      await sendMessage(accounts[1], tb);
      const sendAtB = Date.now();
      sentTexts.push({ text: tb, senderIdx: 1, env: envName });
      const msB = await waitArrival(accounts[0], tb, sendAtB);
      check(`[${envName}] r${r} B→A 수신`, msB !== null, msB !== null ? `${msB}ms` : "timeout(누락)");
      if (msB !== null) latencies.push(msB);
    } catch (e) {
      sendFailures.push(`${envName} r${r}-B`);
      check(`[${envName}] r${r} B→A 수신`, false, `send: ${e.message.slice(0, 80)}`);
    }
  }

  // —— 중복 검사 (수신자 DOM + DB 각 1건) ——
  let dupFail = 0;
  for (const m of sentTexts.filter((x) => x.env === envName)) {
    const receiver = accounts[m.senderIdx === 0 ? 1 : 0];
    const domCount = await receiver.page.locator(`[data-chat-msg]:has-text(${JSON.stringify(m.text)})`).count();
    // query-guard: bounded -- 이번 런 고유 stamp content 완전일치 1건 기대 조회다.
    const { data: rows, error } = await admin
      .from("chat_messages").select("id").eq("room_id", ROOM_ID).eq("content", m.text);
    if (error || domCount !== 1 || (rows?.length ?? -1) !== 1) {
      dupFail += 1;
      console.log(`    dup? ${m.text} dom=${domCount} db=${error ? "ERR" : rows?.length}`);
    }
  }
  check(`[${envName}] 중복 0 (DOM·DB 각 정확히 1건)`, dupFail === 0, `violations=${dupFail}`);

  for (const a of accounts) { try { await a.context.close(); } catch { /* noop */ } }
  return { net: n, latencies, p50: pct(latencies, 50), p95: pct(latencies, 95) };
}

async function cleanup() {
  console.log("\n[cleanup]");
  const errs = [];
  const del = await admin.from("chat_messages").delete()
    .eq("room_id", ROOM_ID).in("user_id", accounts.map((a) => a.userId).filter(Boolean));
  if (del.error) errs.push(`messages: ${del.error.message}`);
  for (const a of accounts) {
    if (!a.userId) continue;
    const p = await admin.from("profiles").delete().eq("id", a.userId);
    if (p.error) errs.push(`profile ${a.label}: ${p.error.message}`);
    const u = await admin.auth.admin.deleteUser(a.userId);
    if (u.error) errs.push(`user ${a.label}: ${u.error.message}`);
  }
  check("cleanup — 삭제 호출 error 없음", errs.length === 0, errs.join(" / ") || "all null");
  // postcondition: 조회 성공 + 잔존 0 (fail-open 방지 — error 를 0 으로 읽지 않는다)
  // query-guard: bounded -- 이번 런 QA 계정(최대 4명) user_id in() 한정 조회다.
  const left = await admin.from("chat_messages").select("id")
    .eq("room_id", ROOM_ID).in("user_id", accounts.map((a) => a.userId).filter(Boolean));
  check("postcondition — QA 메시지 잔존 0 (조회 성공 전제)",
    !left.error && Array.isArray(left.data) && left.data.length === 0,
    left.error ? `ERR ${left.error.message}` : `left=${left.data?.length}`);
  for (const a of accounts) {
    if (!a.userId) continue;
    const g = await admin.auth.admin.getUserById(a.userId);
    const gone = g.error && (g.error.status === 404 || g.error.code === "user_not_found");
    check(`postcondition — ${a.label} 계정 not-found 증명`, Boolean(gone),
      g.error ? `${g.error.status ?? g.error.code}` : "still exists");
  }
  if (browser) await browser.close().catch(() => {});
}

async function main() {
  console.log(`[A/B] game=${GAME_ID} rounds=${ROUNDS} netWindow=${NET_WINDOW_MS}ms`);
  console.log(`  prod=${PROD_BASE}\n  preview=${PREVIEW_BASE}`);
  const livePayload = await fetchProdLivePayload();
  console.log(`  prod live payload 확보 (${livePayload.length}B, ${GAME_ID} isLive=true)`);

  for (const a of accounts) await setupAccount(a);
  browser = await playwright.chromium.launch({ headless: true, executablePath: CHROME });

  const prod = await measureEnv("PROD", PROD_BASE);
  const useFulfill = process.env.QA_FULFILL !== "0";
  const prev = await measureEnv("PREVIEW", PREVIEW_BASE, useFulfill ? { fulfillLivePayload: livePayload } : {});

  console.log("\n=== 네트워크 계약 판정 (Preview A1, 60초) ===");
  const relayCombined = prev.net.relayFamily + (prev.net.relayLegacy ?? 0);
  check("relay-family 합산 ≈ 20 (relay-events + relay, 3초 grid)",
    relayCombined >= 18 && relayCombined <= 22,
    `events=${prev.net.relayFamily} legacy=${prev.net.relayLegacy ?? 0} combined=${relayCombined}`);
  check("standalone /api/game-live 0 (최초 fulfill 제외)", prev.net.standaloneLive === 0,
    `got=${prev.net.standaloneLive}`);
  check("standalone /api/game-detail 0", prev.net.standaloneDetail === 0,
    `got=${prev.net.standaloneDetail}`);
  console.log(`  include 분포: events=${prev.net.include.events} live=${prev.net.include.live} detail=${prev.net.include.detail} (기대 4/7/2 부근)`);
  check("include events ≈ 4", Math.abs(prev.net.include.events - 4) <= 2, `got=${prev.net.include.events}`);
  check("include live ≈ 7", Math.abs(prev.net.include.live - 7) <= 2, `got=${prev.net.include.live}`);
  check("include detail ≈ 2", Math.abs(prev.net.include.detail - 2) <= 1, `got=${prev.net.include.detail}`);

  console.log("\n=== 지연 비교 ===");
  console.log(`  PROD    n=${prod.latencies.length} p50=${prod.p50}ms p95=${prod.p95}ms [${prod.latencies.join(",")}]`);
  console.log(`  PREVIEW n=${prev.latencies.length} p50=${prev.p50}ms p95=${prev.p95}ms [${prev.latencies.join(",")}]`);
  check("send/retry 실패 0 (양쪽)", sendFailures.length === 0, sendFailures.join(", ") || "0");
  check("양쪽 동일 표본수", prod.latencies.length === prev.latencies.length
    && prod.latencies.length === ROUNDS * 4,
    `prod=${prod.latencies.length} a1=${prev.latencies.length} 기대=${ROUNDS * 4}`);
  check("A1 p95 ≤ baseline p95 (원계약, 완화대 없음)",
    prev.p95 !== null && prod.p95 !== null && prev.p95 <= prod.p95,
    `baseline=${prod.p95}ms a1=${prev.p95}ms`);

  writeFileSync(
    `/Users/harinclaw/.openclaw/workspace/state/qa/ab-1274-${stamp}.json`,
    JSON.stringify({ stamp, gameId: GAME_ID, prod, preview: prev, results }, null, 2),
  );
  console.log(`\n원장: state/qa/ab-1274-${stamp}.json`);
}

main()
  .catch((e) => { console.error("UNCAUGHT:", e.message); failed++; })
  .finally(async () => {
    await cleanup();
    const passN = results.filter((r) => r.ok).length;
    console.log(`\n=== 요약 === 총 ${results.length} · PASS ${passN} · FAIL ${results.length - passN}`);
    process.exit(failed ? 1 : 0);
  });
