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
const PREFLIGHT_ONLY = process.env.QA_PREFLIGHT === "1";

// [P0-1] env 하한 강제 — 계약값은 env 로 **낮출 수 없다**(올리는 것만 허용).
// 하한을 env 에 맡기면 측정자가 계약을 스스로 완화할 수 있고, 그건 게이트가 아니다.
const MIN_SAMPLES_FLOOR = 40;
const SIG_WINDOW_FLOOR_MS = 60000;
const MIN_SAMPLES = Math.max(MIN_SAMPLES_FLOOR, Number(process.env.QA_MIN_SAMPLES || 0));
const SIG_WINDOW_MS = Math.max(SIG_WINDOW_FLOOR_MS, Number(process.env.QA_SIG_WINDOW_MS || 0));
const WARMUP_PAIRS = Math.max(1, Number(process.env.QA_WARMUP_PAIRS || 1));
// arm당 표본 = (PAIRS - WARMUP_PAIRS) * 2(A→B, B→A). MIN_SAMPLES 를 만족하는 최소 PAIRS 를
// 하한으로 깐다 → env 로 표본을 줄여 계약을 우회할 수 없다.
const PAIRS_FLOOR = Math.ceil(MIN_SAMPLES / 2) + WARMUP_PAIRS;
const PAIRS = PREFLIGHT_ONLY
  ? WARMUP_PAIRS + 1                                   // [P0-2] preflight 도 실표본 1쌍은 만든다
  : Math.max(PAIRS_FLOOR, Number(process.env.QA_PAIRS || 0));

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

// [P0-3] build SHA fail-close — 어느 빌드를 쟀는지 모르는 원장은 재현 근거가 되지 못한다.
// 40자 hex 가 아니면 측정 자체를 시작하지 않는다.
const BASELINE_SHA = process.env.QA_BASELINE_SHA ?? "";
const A1_SHA = process.env.QA_A1_SHA ?? "";
for (const [k, v] of [["QA_BASELINE_SHA", BASELINE_SHA], ["QA_A1_SHA", A1_SHA]]) {
  if (!/^[0-9a-f]{40}$/.test(v)) {
    console.error(`[GUARD-FAIL] ${k} 미설정/형식오류 — 원장에 build SHA 가 없으면 측정 무효.`);
    process.exit(1);
  }
}
if (BASELINE_SHA === A1_SHA) {
  console.error(`[GUARD-FAIL] baseline SHA == a1 SHA (${A1_SHA}) — 같은 빌드를 두 번 재고 있다.`);
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
// [P0-2] DB exact-1 증명 결과 — 원장에 그대로 실린다(측정 실패 시 null 로 남아 부재가 드러남).
let dbProof = null;
// non-inferiority 판정 결과 — 원장에 그대로 실려 Δ·상한이 사후에 바뀌지 않음을 보장한다.
let niResult = null;
// 원장은 cleanup 까지 끝난 뒤에 쓴다(삼순 4차 ③) — main() 이 던져도 지금까지의 근거를 남긴다.
let pendingLedger = null;
const results = [];

/* ── NI 게이트 순수함수 산출 ───────────────────────────────────────────
 * [삼순 3차 ④] NI 분기는 measure 모드에서만 돌아 실행 0건이었다. 검증 불가능한
 * 게이트는 게이트가 아니다 → 순수함수로 분리해 synthetic 데이터로 경계를 검증한다.
 * 반환: { ok, reason, detail, ni } — ok=false 면 무조건 FAIL(fail-close). */
const NI_MARGIN_MAX_MS = 100;   // 코드 상한 — env 로 높일 수 없다(낮추기만 허용)
const NI_BLOCK_PAIRS = 2;       // 라운드당 AB·BA → arm 당 2표본
const NI_ITERS = 20000;

function computeNonInferiority({ baseline, a1, marginRaw, sendFail, provenance }) {
  if (marginRaw !== undefined && marginRaw !== "" && !/^\d+$/.test(String(marginRaw)))
    return { ok: false, reason: "margin_invalid", detail: `불정 값: ${marginRaw}` };
  if (marginRaw !== undefined && marginRaw !== "" && Number(marginRaw) <= 0)
    return { ok: false, reason: "margin_invalid", detail: `불정 값: ${marginRaw}` };
  if (!provenance?.ok)
    return { ok: false, reason: "provenance", detail: provenance?.detail ?? "provenance 미비" };
  if (sendFail?.baseline !== 0 || sendFail?.a1 !== 0)
    return { ok: false, reason: "send_fail", detail: JSON.stringify(sendFail) };
  if (!Array.isArray(baseline) || !Array.isArray(a1) || baseline.length === 0 || baseline.length !== a1.length)
    return { ok: false, reason: "pairing", detail: `b=${baseline?.length} a1=${a1?.length}` };
  // [삼순 4차 ②] 표본수가 blockSize 로 나누어떨어지지 않으면 마지막 block 이 짧아져
  // 라운드 경계가 깨진다(부분 라운드가 온전한 라운드와 같은 가중치로 리샘플됨).
  // 조용히 보정하지 말고 fail-close — 측정 설계가 어긋난 것이다.
  if (baseline.length % NI_BLOCK_PAIRS !== 0)
    return { ok: false, reason: "block_alignment", detail: `n=${baseline.length} % blockSize=${NI_BLOCK_PAIRS} ≠ 0` };

  // env 는 더 엄격하게만 — 상한을 넘길 수 없다.
  const requested = marginRaw === undefined || marginRaw === "" ? NI_MARGIN_MAX_MS : Number(marginRaw);
  const margin = Math.min(requested, NI_MARGIN_MAX_MS);

  const q95 = (v) => { const s = [...v].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
  // 라운드 block — 같은 라운드 관측치는 부하·네트워크를 공유해 독립이 아니다.
  // 독립 가정으로 리샘플하면 CI 를 과소추정한다 → 라운드를 통째 리샘플.
  const blocks = [];
  for (let i = 0; i < baseline.length; i += NI_BLOCK_PAIRS)
    blocks.push({ b: baseline.slice(i, i + NI_BLOCK_PAIRS), a: a1.slice(i, i + NI_BLOCK_PAIRS) });

  let seed = 1274 >>> 0;   // 결정론 — 같은 입력이면 같은 판정
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const boots = new Array(NI_ITERS);
  for (let it = 0; it < NI_ITERS; it++) {
    const bb = [], aa = [];
    for (let k = 0; k < blocks.length; k++) {
      const blk = blocks[Math.floor(rnd() * blocks.length)];
      bb.push(...blk.b); aa.push(...blk.a);
    }
    boots[it] = q95(aa) - q95(bb);   // estimand = p95 차이
  }
  boots.sort((x, y) => x - y);
  const upper95 = boots[Math.floor(0.95 * boots.length)];   // 단측 95% 상한
  const P = baseline.map((b, i) => a1[i] - b);
  // [삼순 4차 ②] 경계는 **엄격한 미만**이다. upper95 === margin 은 "Δ 만큼 나쁘다"라
  // non-inferiority 를 증명하지 못한다 → FAIL. (`<` 로 고정, `<=` 아님)
  return {
    ok: true, pass: upper95 < margin,
    detail: `upper95=${upper95.toFixed(1)}ms observed=${(q95(a1) - q95(baseline)) >= 0 ? "+" : ""}${q95(a1) - q95(baseline)}ms blocks=${blocks.length} n=${baseline.length}`,
    ni: {
      statistic: "p95_delta", method: "round_block_bootstrap", blockSize: NI_BLOCK_PAIRS,
      blocks: blocks.length, iterations: NI_ITERS, seed: 1274,
      marginMs: margin, marginMaxMs: NI_MARGIN_MAX_MS, marginRequested: requested,
      observedP95Delta: q95(a1) - q95(baseline), upper95, n: baseline.length,
      aSlowerPairs: P.filter((x) => x > 0).length, aFasterPairs: P.filter((x) => x < 0).length,
    },
  };
}

/* ── --selftest-ni — synthetic 데이터로 NI 경계를 결정론적으로 검증 ────────────────
 * 삼순 ④ 요구: PASS/FAIL 경계 · 미설정/불법/상한초과 Δ · 0/불균형 쌍.
 * 이게 통과해야 NI 분기가 "실행된 적 있는 게이트"가 된다. */
if (process.argv.includes("--selftest-ni")) {
  const OK_PROV = { ok: true };
  const Z = { baseline: 0, a1: 0 };
  let pass = 0, fail = 0;
  const t = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  PASS — ${name}${detail ? ` :: ${detail}` : ""}`); }
    else { fail++; console.log(`  FAIL — ${name}${detail ? ` :: ${detail}` : ""}`); }
  };
  // 동일 분포(차이 0) → 상한이 Δ 아래 → PASS
  const base = Array.from({ length: 200 }, (_, i) => 400 + (i % 40) * 10);
  let r = computeNonInferiority({ baseline: base, a1: [...base], marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("동일 분포 → NI PASS", r.ok && r.pass, r.detail);
  // A1 이 전구간 +400ms 느림 → 상한이 Δ 초과 → FAIL
  r = computeNonInferiority({ baseline: base, a1: base.map((x) => x + 400), marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("+400ms 회귀 → NI FAIL (경계 검출력)", r.ok && !r.pass, r.detail);
  // Δ 미설정 → 상한값(100)으로 계약이 살아있다
  r = computeNonInferiority({ baseline: base, a1: base.map((x) => x + 400), marginRaw: undefined, sendFail: Z, provenance: OK_PROV });
  t("Δ 미설정이어도 계약 살아있음(=100 적용, FAIL)", r.ok && !r.pass && r.ni.marginMs === 100, `margin=${r.ni?.marginMs}`);
  // 상한 초과 Δ 주입 → 상한으로 clamp (999 주입해도 100)
  r = computeNonInferiority({ baseline: base, a1: base.map((x) => x + 400), marginRaw: "999", sendFail: Z, provenance: OK_PROV });
  t("Δ=999 주입 → 100 으로 clamp 되어 FAIL 유지", r.ok && !r.pass && r.ni.marginMs === 100, `margin=${r.ni?.marginMs} requested=${r.ni?.marginRequested}`);
  // 더 엄격한 Δ 는 허용
  r = computeNonInferiority({ baseline: base, a1: [...base], marginRaw: "10", sendFail: Z, provenance: OK_PROV });
  t("Δ=10 (더 엄격) 허용", r.ok && r.ni.marginMs === 10, `margin=${r.ni?.marginMs}`);
  // 불법 Δ
  for (const bad of ["abc", "-5", "0", "1e3", "50.5"]) {
    r = computeNonInferiority({ baseline: base, a1: [...base], marginRaw: bad, sendFail: Z, provenance: OK_PROV });
    t(`불법 Δ 거부: ${JSON.stringify(bad)}`, !r.ok && r.reason === "margin_invalid");
  }
  // sendFail ≠ 0 → fail-close
  r = computeNonInferiority({ baseline: base, a1: [...base], marginRaw: "100", sendFail: { baseline: 1, a1: 0 }, provenance: OK_PROV });
  t("sendFail≠0 → fail-close", !r.ok && r.reason === "send_fail");
  // provenance 깨짐 → fail-close
  r = computeNonInferiority({ baseline: base, a1: [...base], marginRaw: "100", sendFail: Z, provenance: { ok: false, detail: "same sha" } });
  t("provenance 깨짐 → fail-close", !r.ok && r.reason === "provenance");
  // 0 표본 / 불균형 쌍 → fail-close
  r = computeNonInferiority({ baseline: [], a1: [], marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("0 표본 → fail-close", !r.ok && r.reason === "pairing");
  r = computeNonInferiority({ baseline: base, a1: base.slice(0, 199), marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("불균형 쌍 → fail-close", !r.ok && r.reason === "pairing");
  // [삼순 4차 ②-a] block 경계 미정렬 — 마지막 라운드가 짧으면 리샘플 가중치가 깨진다.
  const odd = base.slice(0, 199);
  r = computeNonInferiority({ baseline: odd, a1: [...odd], marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("홀수 표본(block 미정렬) → fail-close", !r.ok && r.reason === "block_alignment", r.detail);
  // [삼순 4차 ②-b] 경계는 엄격한 미만 — upper95 === Δ 는 "Δ 만큼 나쁘다"라 PASS 가 아니다.
  // 전구간 +100ms 면 모든 리샘플에서 p95 delta 가 정확히 100 → upper95 === 100 === Δ.
  r = computeNonInferiority({ baseline: base, a1: base.map((x) => x + 100), marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("upper95 === Δ → FAIL (경계는 엄격한 미만)", r.ok && !r.pass && r.ni.upper95 === 100, `upper95=${r.ni?.upper95} Δ=${r.ni?.marginMs}`);
  // 상한 바로 아래(+99ms)는 PASS — 경계가 한 칸 차이를 실제로 가른다는 증명.
  r = computeNonInferiority({ baseline: base, a1: base.map((x) => x + 99), marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("upper95 = Δ-1 → PASS (경계 해상도 1ms)", r.ok && r.pass && r.ni.upper95 === 99, `upper95=${r.ni?.upper95} Δ=${r.ni?.marginMs}`);
  // 결정론 — 같은 입력 2회 호출이 동일해야 재현 가능한 근거다
  const j = base.map((x, i) => x + (i % 7) * 13);
  const r1 = computeNonInferiority({ baseline: base, a1: j, marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  const r2 = computeNonInferiority({ baseline: base, a1: j, marginRaw: "100", sendFail: Z, provenance: OK_PROV });
  t("결정론 — 동일 입력 → 동일 upper95", r1.ni.upper95 === r2.ni.upper95, `${r1.ni.upper95} vs ${r2.ni.upper95}`);
  console.log(`\n=== selftest-ni === 총 ${pass + fail} · PASS ${pass} · FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
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

/** 전송: matching POST **시작시각**을 반환한다(삼순 ④ — 도착 후 clamp 방지).
 *
 *  ⚠️ composer 는 폴링 응답마다 리렌더된다. locator 를 밖에서 한 번만 잡아두면
 *  재렌더 된 순간 stale 해지거나 fill 한 값이 지워져 POST 가 영영 안 나간다.
 *  그런데 baseline 은 standalone 폴링(live+detail+relay)이 더 잔아 재렌더 빈도가 높다
 *  → 하니스 결함이 **arm 에 상관**해 baseline 만 손해를 본다. 매 시도마다 재조회한다. */
/* ── 앱 전송 계약(useChat.sendMessage) ────────────────────────────────────────
 * 서비스는 도배방지를 위해 아래 조건에서 **조용히 `return false`** 한다(POST 없음):
 *   ① 기본 쿨다운  : now - lastSent < 3000ms
 *   ② 슬라이딩 윈도: 최근 60초 내 10건 이상 → 30초 뮤트
 *   ③ 중복/변형 도배: 정규화 키가 최근 5건에 있음
 *   ④ 모더레이션 차단
 * 즉 'clicked:true 인데 POST 없음'은 하니스 버그도 환경 잡음도 아니라
 * **서비스가 설계대로 거절한 것**이다. 측정 하니스는 이 계약을 우회하지 말고
 * **지켜야** 한다 — 우회하면 실유저가 못 하는 속도로 재는 셈이라 측정 자체가 무효다.
 * 그래서 페이지(=유저)별로 발송 간격을 앱 계약보다 보수적으로 페이싱한다. */
const SEND_MIN_GAP_MS = 3500;      // ① 3000 + 여유
const SEND_WINDOW_MS = 60_000;     // ②
const SEND_MAX_IN_WINDOW = 9;      // ② 10 미만으로 유지(경계 절대 접근 금지)
const sendHistory = new Map();     // page → number[]

/** 앱 계약을 만족할 때까지 대기한다. 반환: 실제로 기다린 ms(원장 기록용). */
async function awaitSendSlot(page) {
  const hist = sendHistory.get(page) ?? [];
  let waited = 0;
  for (;;) {
    const now = Date.now();
    const recent = hist.filter((t) => now - t < SEND_WINDOW_MS);
    const last = hist.length ? hist[hist.length - 1] : -Infinity;
    const gapWait = Math.max(0, SEND_MIN_GAP_MS - (now - last));
    // 윈도가 찼으면 가장 오래된 항목이 창 밖으로 나갈 때까지.
    const winWait = recent.length >= SEND_MAX_IN_WINDOW
      ? Math.max(0, SEND_WINDOW_MS - (now - recent[0]) + 250)
      : 0;
    const wait = Math.max(gapWait, winWait);
    if (wait <= 0) break;
    await page.waitForTimeout(Math.min(wait, 5000));
    waited += Math.min(wait, 5000);
  }
  return waited;
}
function noteSent(page) {
  const hist = sendHistory.get(page) ?? [];
  hist.push(Date.now());
  sendHistory.set(page, hist.filter((t) => Date.now() - t < SEND_WINDOW_MS * 2));
}

/** 실패 시 서비스가 왜 거절했는지 DOM 에서 직접 읽는다(원인 결속 — 삼순 요구). */
async function readRejectReason(page) {
  try {
    const c = await composerOf(page);
    const box = c.locator('textarea[name="chat-message"]');
    const ph = await box.getAttribute("placeholder").catch(() => null);
    const btnDisabled = await c.locator("button:has(svg.lucide-send)").first()
      .isDisabled().catch(() => null);
    return { placeholder: ph, sendDisabled: btnDisabled };
  } catch { return { placeholder: null, sendDisabled: null }; }
}

async function sendOn(page, text, diag) {
  const postAt = page.waitForRequest(
    (r) => r.method() === "POST" && /\/rest\/v1\/chat_messages/.test(r.url()) && (r.postData() ?? "").includes(text),
    { timeout: 20000 },
  ).then(() => Date.now());
  let attempts = 0, lastVal = null, clicked = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    attempts = attempt;
    try {
      const c = await composerOf(page);                       // ← 매 시도 재조회(stale 방지)
      const box = c.locator('textarea[name="chat-message"]');
      await box.waitFor({ state: "visible", timeout: 5000 });
      await box.click({ timeout: 3000 });
      await box.fill(text, { timeout: 3000 });
      lastVal = await box.inputValue().catch(() => null);
      if (lastVal !== text) continue;                          // 재렌더로 값이 날아감 → 재시도
      const btn = c.locator("button:has(svg.lucide-send)").first();
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 2000 });
        clicked = true;
        break;
      }
      await box.press("Enter").catch(() => {});
      await page.waitForTimeout(400);
      if ((await box.inputValue().catch(() => "x")) === "") { clicked = true; break; }
    } catch { await page.waitForTimeout(200); /* 재시도 */ }
  }
  if (diag) Object.assign(diag, { attempts, clicked, lastVal });
  return postAt;   // POST 가 안 나가면 timeout → 호출부에서 sendFail 로 집계
}

async function waitArrival(page, text, timeoutMs = 20000) {
  try {
    await page.waitForFunction((t) => t in (window.__qaArrivals || {}), text, { timeout: timeoutMs, polling: 20 });
    return await page.evaluate((t) => window.__qaArrivals[t], text);
  } catch { return null; }
}

/** A1 멀티플렉스 활성 증명: include=live|detail 를 실은 NDJSON 요청이 있고,
 *  standalone live/detail 폴링이 그 창에서 반복되지 않아야 한다.
 *  창은 **고정 60초**(sinceMs ~ sinceMs+SIG_WINDOW_MS)만 재서 전체 실행시간에 따라
 *  기대 횟수가 변하지 않게 한다(삼순 P0-1). */
function signature(netLog, sinceMs, windowMs = SIG_WINDOW_MS) {
  const until = sinceMs + windowMs;
  const w = netLog.filter((r) => r.t >= sinceMs && r.t < until);
  const ndjson = w.filter((r) => r.path === "/api/game-relay-events");
  const inc = (name) => ndjson.filter((r) => r.include.split(",").includes(name)).length;
  return {
    windowMs,
    ndjson: ndjson.length,
    embedded: ndjson.filter((r) => /live|detail/.test(r.include)).length,
    incEvents: inc("events"),
    incLive: inc("live"),
    incDetail: inc("detail"),
    standaloneLive: w.filter((r) => r.path === "/api/game-live").length,
    standaloneDetail: w.filter((r) => r.path === "/api/game-detail").length,
    standaloneRelay: w.filter((r) => r.path === "/api/game-relay").length,
  };
}

// [P0-1] 고정 60초 창의 relay-family 총량 계약.
// 3초 cadence → 20회 ± jitter/지터 허용치. "감소했다"가 아니라 **범위**로 잠그어
// embedded 1건짜리나 standalone 잔존이 통과하는 구먹을 없앨다.
const RELAY_FAMILY_MIN = 18;
const RELAY_FAMILY_MAX = 22;
// 기대 횟수는 **생성기 계약에서 유도**한다(임의의 감으로 정하면 게이트가 거짓말을 한다).
//   shouldCombineGameEvents: pollIndex % 5 === 0  → fam 의 약 1/5
//   shouldEmbedLive:         pollIndex % 3 === 0  → fam 의 약 1/3
//   shouldEmbedDetail:       pollIndex % 10 === 0 → fam 의 약 1/10
// 지터·경계 절상을 감안해 ±1 허용폭을 둔다. 범위의 **양방향**을 잠그어
// "너무 적음"(멀티플렉스 미작동)과 "너무 많음"(중복 요청) 둘 다 잡는다.
const cadenceRange = (fam, everyN) => {
  const exp = fam / everyN;
  return [Math.max(1, Math.floor(exp) - 1), Math.ceil(exp) + 1];
};

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
  const sentTexts = [];   // [P0-2] DB exact-1 대조용 — 실제 POST 가 나간 content 만
  const sendFailDetail = [];   // 전송 실패의 증상(라운드·방향·재시도횟수·입력값) — 원장에 실린다
  const total = PAIRS;

  for (let i = 1; i <= total; i++) {
    // [P1] arm 순서 교대 — 매 라운드 먼저 재는 arm 을 바꿔 순서 편향(선행 arm 이 캐시·
    // 커넥션 워밍을 떠안는 효과)을 상쇄한다. 순차 측정이라도 순서가 고정이면 편향이 남는다.
    const order = i % 2 === 1 ? ["baseline", "a1"] : ["a1", "baseline"];
    for (const label of order) {
      const arm = arms[label];
      // A→B, B→A 교대(방향 편향 제거). 각 방향이 1 표본.
      for (const [from, to] of [["A", "B"], ["B", "A"]]) {
        const text = `⚾ ${stamp}-${label}-${from}${to}-${i}`;
        for (const side of ["A", "B"]) {
          await arm[side].page.evaluate((t) => window.__qaTargets.push(t), text);
        }
        // 앱의 도배방지 계약을 만족할 때까지 대기 — 우회가 아니라 준수다.
        const paced = await awaitSendSlot(arm[from].page);
        let t0 = null;
        const diag = { pacedMs: paced };
        try {
          t0 = await sendOn(arm[from].page, text, diag);
          noteSent(arm[from].page);
          sentTexts.push(text);
        }
        catch (e) {
          sendFail[label]++;
          // 재시도로 덮지 않고 **증상 + 거절 사유를 원장에 남긴다**.
          // placeholder/버튼 상태로 서비스가 쉬거나 쿨다운으로 거절했는지를 직접 결속한다.
          const why = await readRejectReason(arm[from].page);
          sendFailDetail.push({ arm: label, round: i, dir: `${from}${to}`, err: e?.name ?? String(e), ...diag, ...why });
          continue;
        }
        const at = await waitArrival(arm[to].page, text);
        if (at == null) { if (i > WARMUP_PAIRS) missing[label].push(text); continue; }
        if (i > WARMUP_PAIRS) lat[label].push(at - t0);
        const seen = await arm[to].page.evaluate((t) => window.__qaSeen[t] || 0, text);
        if (seen > 1 && i > WARMUP_PAIRS) dups[label].push({ text, seen });
      }
    }
    if (i % 5 === 0) console.log(`  ...${i}/${total} pairs (baseline n=${lat.baseline.length} a1 n=${lat.a1.length})`);
  }

  // [P0-2] 중복 증명의 DB exact-1 — DOM 카운트(`__qaSeen`)만으로는 "렌더링 1회"만
  // 말할 뿐, 서버가 같은 메시지를 2번 썼는지는 모른다(클라이언트 dedupe 가
  // 가리면 DOM 은 1회이다). cleanup **전에** stamp 한정 bounded 조회로
  // content별 DB 1건·총 기대 건수·포화 아님을 강제한다.
  {
    const expected = sentTexts.length;
    const cap = Math.max(expected * 3, 12);   // 상한 > 기대치 → 포화 여부를 판정할 수 있다
    // query-guard: bounded -- 이번 런 고유 stamp 한정 조회. 상한은 기대치의 3배로
    // 잡아 포화된 결과를 전수로 오독하지 않게 한다.
    const rows = await admin
      .from("chat_messages")
      .select("id,content")
      .eq("room_id", ROOM_ID)
      .like("content", `%${stamp}%`)
      .limit(cap);
    const ok = !rows.error && Array.isArray(rows.data);
    const counts = new Map();
    for (const r of rows.data ?? []) counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
    const over = [...counts.entries()].filter(([, n]) => n !== 1);
    const unknown = sentTexts.filter((t) => !counts.has(t));
    dbProof = {
      expected, fetched: rows.data?.length ?? null, cap,
      distinct: counts.size, over: over.length, missing: unknown.length,
      error: rows.error?.message ?? null,
    };
    check("[DB] 조회 성공 (error 없음 · 전수 전제)", ok, rows.error?.message ?? `fetched=${rows.data?.length}`);
    check("[DB] 포화 아님 (fetched < cap — 상한 도달은 전수 아님)",
      ok && rows.data.length < cap, `fetched=${rows.data?.length} cap=${cap}`);
    check("[DB] 전송 content 별 exact-1 (서버 중복 insert 0)",
      ok && over.length === 0, over.length ? JSON.stringify(over.slice(0, 3)) : "all 1");
    check("[DB] 총 건수 == 전송 건수", ok && rows.data.length === expected,
      `db=${rows.data?.length} sent=${expected}`);
    check("[DB] 누락된 전송 0", ok && unknown.length === 0, `missing=${unknown.length}`);
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
  check("send 실패 0", sendFail.baseline === 0 && sendFail.a1 === 0,
    `${JSON.stringify(sendFail)} ${sendFailDetail.length ? JSON.stringify(sendFailDetail.slice(0, 4)) : ""}`);
  check("누락 0", missing.baseline.length === 0 && missing.a1.length === 0, `b=${missing.baseline.length} a1=${missing.a1.length}`);
  check("중복 0 (DOM 노출 1회)", dups.baseline.length === 0 && dups.a1.length === 0, `b=${dups.baseline.length} a1=${dups.a1.length}`);
  // [P0-1] network fail-close — 범위로 잠근다("감소"로는 불충분).
  const famA1 = sig.a1.ndjson + sig.a1.standaloneRelay;
  const famBl = sig.baseline.ndjson + sig.baseline.standaloneRelay;
  check(`[a1] relay-family 총량 ${RELAY_FAMILY_MIN}~${RELAY_FAMILY_MAX} (고정 60s 창)`,
    famA1 >= RELAY_FAMILY_MIN && famA1 <= RELAY_FAMILY_MAX, `famA1=${famA1} ${JSON.stringify(sig.a1)}`);
  check(`[baseline] relay-family 총량 ${RELAY_FAMILY_MIN}~${RELAY_FAMILY_MAX} (동일 cadence 확인)`,
    famBl >= RELAY_FAMILY_MIN && famBl <= RELAY_FAMILY_MAX, `famBl=${famBl} ${JSON.stringify(sig.baseline)}`);
  check("[a1] standalone live == 0 (fail-close)", sig.a1.standaloneLive === 0, `${sig.a1.standaloneLive}`);
  check("[a1] standalone detail == 0 (fail-close)", sig.a1.standaloneDetail === 0, `${sig.a1.standaloneDetail}`);
  {
    const [liveMin, liveMax] = cadenceRange(famA1, 3);
    const [detMin, detMax] = cadenceRange(famA1, 10);
    const [evMin, evMax] = cadenceRange(famA1, 5);
    check(`[a1] include=live ${liveMin}~${liveMax} (shouldEmbedLive: pollIndex%3)`,
      sig.a1.incLive >= liveMin && sig.a1.incLive <= liveMax, `incLive=${sig.a1.incLive} fam=${famA1}`);
    check(`[a1] include=detail ${detMin}~${detMax} (shouldEmbedDetail: pollIndex%10)`,
      sig.a1.incDetail >= detMin && sig.a1.incDetail <= detMax, `incDetail=${sig.a1.incDetail} fam=${famA1}`);
    check(`[a1] include=events ${evMin}~${evMax} (shouldCombineGameEvents: pollIndex%5)`,
      sig.a1.incEvents >= evMin && sig.a1.incEvents <= evMax, `incEvents=${sig.a1.incEvents} fam=${famA1}`);
  }
  check("[baseline] embedded == 0 (대조군은 멀티플렉스 미사용)",
    sig.baseline.embedded === 0, `${sig.baseline.embedded}`);
  check("[baseline] standalone live+detail > 0 (A1 감소가 유의미함을 보장)",
    sig.baseline.standaloneLive + sig.baseline.standaloneDetail > 0,
    `${sig.baseline.standaloneLive + sig.baseline.standaloneDetail}`);
  check(`signature 관측창 ≥ ${SIG_WINDOW_MS / 1000}s`, elapsed >= SIG_WINDOW_MS, `${Math.round(elapsed / 1000)}s`);

  // [P0-2] preflight 도 실표본을 만들고 집계한다 — n=0 으로 누락·중복 검사를 건너뛰면
  // "PASS" 가 아무것도 증명하지 않는 false-GREEN 이다.
  check("표본 집계 성립 (n>0 — n=0 false-GREEN 방지)",
    lat.baseline.length > 0 && lat.a1.length > 0,
    `baseline=${lat.baseline.length} a1=${lat.a1.length}`);

  if (!PREFLIGHT_ONLY) {
    check(`arm당 표본 ≥ ${MIN_SAMPLES} (fail-close, env 로 하향 불가)`,
      lat.baseline.length >= MIN_SAMPLES && lat.a1.length >= MIN_SAMPLES,
      `baseline=${lat.baseline.length} a1=${lat.a1.length}`);
    check("동일 표본수", lat.baseline.length === lat.a1.length, `b=${lat.baseline.length} a1=${lat.a1.length}`);
    // [삼순 3차 ③] legacy 부등호는 **informational** 로 내린다(blocking 아님).
    // 4회 런에서 방향이 2:2 로 갈렸다 = 재현성이 없는 게이트다. 그걸 blocking 으로
    // 두면 NI 가 PASS 해도 legacy 가 동전던지기로 전체를 FAIL 시킨다.
    // 값은 버리지 않고 원장·출력에 남겨 추이를 볼 수 있게 한다.
    console.log(`  INFO — [참고·비판정] A1 p95 vs baseline p95 :: baseline=${bp95}ms a1=${ap95}ms delta=${(ap95 - bp95) >= 0 ? "+" : ""}${ap95 - bp95}ms`);

    // ── non-inferiority 게이트 (삼순 요구) ───────────────────────────────
    // 위 부등호 게이트는 4회 런에서 방향이 2:2 로 갈렸다 = 재현성이 없다.
    // 그렇다고 "CI 가 0 을 포함"은 동등성 증명이 아니다 — [-80,+142] 는
    // "차이 없음"이 아니라 "최대 +142ms 회귀도 배제 못 함"이다(검정력 부족).
    // 올바른 형태는 **사전 정의된 margin Δ 에 대한 단측 상한 검정**이다:
    //     paired delta 의 95% 단측 upper bound < Δ  ⇒ "Δ 보다 나쁘지 않다"가 증명됨
    // Δ 는 통계가 아니라 **제품 판단**이므로 env 로 외부 주입받고,
    // 미설정이면 게이트를 건너뛰지 않고 **FAIL** 한다(fail-close).
    // ⚠️ 결과를 보고 Δ 를 고르면 그게 사후선택이다. Δ 는 런 전에 확정해 원장에 박힌다.
    //
    // [삼순 2차] 판정 통계량은 median 이 아니라 **p95 delta** 여야 한다.
    //   계약이 보호하려는 것은 꼬리 지연이지 중앙값이 아니다. median 이 안정적이라
    //   쉽게 통과하지만, 그건 보호 대상을 안 재는 것이다.
    //   또한 단순 표본 부트스트랩은 같은 라운드의 관측치가 서로 독립이라고 가정해
    //   CI 를 과소추정한다 → **라운드 단위 block bootstrap** 으로 라운드를 통째 리샘플한다.
    const NI_MARGIN_MAX_MS = 100;   // 코드 상한 — env 로 높일 수 없다(낮추기만 허용)
    const dRaw = process.env.QA_NI_MARGIN_MS;
    const provenanceOk = !!(BASELINE_SHA && A1_SHA && BASELINE_SHA !== A1_SHA
      && patchSha && manifest?.files && Object.keys(manifest.files).length > 0);

    // [삼순 4차 ①] measure 경로가 selftest 순수함수를 안 타면 15/15 는 **실제 게이트를
    // 검증하지 못한다**(둘이 갈라져 selftest 가 거짓말을 한다). 동일 함수를 호출한다.
    const niOut = computeNonInferiority({
      baseline: lat.baseline, a1: lat.a1, marginRaw: dRaw, sendFail,
      provenance: {
        ok: provenanceOk,
        detail: `baseline=${BASELINE_SHA?.slice(0, 9)} a1=${A1_SHA?.slice(0, 9)} patch=${patchSha?.slice(0, 8)} fixtures=${Object.keys(manifest?.files ?? {}).length}`,
      },
    });
    niResult = niOut.ni ?? { failed: true, reason: niOut.reason, detail: niOut.detail };
    if (!niOut.ok) {
      check(`non-inferiority — fail-close (${niOut.reason})`, false, niOut.detail);
    } else {
      check(`non-inferiority — p95 delta 라운드 block bootstrap 단측 95% 상한 < Δ=${niOut.ni.marginMs}ms`,
        niOut.pass, niOut.detail);
    }
  }

  // [삼순 4차 ③] 원장을 여기서 바로 쓰면 **cleanup 결과가 파일에 남지 않는다**
  // (cleanup 은 finally 에서 돌아 이 시점 이후에 실행된다).
  // 잔존·계정 삭제 증명은 원장의 핵심 근거이므로, 쓰기를 finally 끝으로 미룬다.
  pendingLedger = {
    stamp, mode: PREFLIGHT_ONLY ? "preflight" : "measure",
    room: ROOM_ID, gameId: GAME_ID,
    supabaseRef: new URL(SUPABASE_URL).hostname.split(".")[0],
    builds: { baseline: BASELINE_SHA, a1: A1_SHA },
    fixtures: manifest.files, patchSha256: patchSha,
    pairs: PAIRS, warmupPairs: WARMUP_PAIRS, signatureWindowMs: elapsed, signature: sig,
    baseline: { n: lat.baseline.length, p50: bp50, p95: bp95, samples: lat.baseline, sendFail: sendFail.baseline, missing: missing.baseline.length, dups: dups.baseline.length },
    a1: { n: lat.a1.length, p50: ap50, p95: ap95, samples: lat.a1, sendFail: sendFail.a1, missing: missing.a1.length, dups: dups.a1.length },
    blockedWrites: blockedWrites.length, dbProof, sendFailDetail, nonInferiority: niResult,
  };
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
  // [삼순 4차 ③] cleanup 결과까지 results 에 들어온 뒤에 원장을 쓴다.
  // 잔존 0·계정 not-found 는 원장의 핵심 근거인데, 종전에는 파일에 안 남았다.
  // main() 이 던져 pendingLedger 가 없으면 쓸 것도 없으므로 건너뛴다.
  if (pendingLedger) {
    const out = `scripts/qa/evidence/dplan-${pendingLedger.mode === "preflight" ? "preflight" : "p95"}-${pendingLedger.stamp}.json`;
    writeFileSync(out, JSON.stringify({ ...pendingLedger, results }, null, 1));
    console.log(`원장: ${out}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 요약 === 총 ${results.length} · PASS ${pass} · FAIL ${results.length - pass}`);
  process.exit(failed ? 1 : 0);
}
