/**
 * 클라 dedupe 회귀 게이트 (PR #1253 — 삼순 NO-GO 반영 검증)
 *
 * 대상: src/lib/client-dedupe.ts (register-start/register-device//api/me dedupe 공용 로직)
 * 시나리오(삼순 지정):
 *  A. SIGNED_OUT → 동일 UID SIGNED_IN: invalidate 후 TTL 내여도 재조회
 *  B. 늦은 old response vs force: force가 in-flight를 supersede — 옛 응답 적용 차단
 *  C. force 실패 후 retry: fresh 마커가 남지 않아 다음 시도가 서버를 다시 탄다
 *  D. register-start skipped/실패 응답: 캐시 금지
 *  E. register-device 긴급공지 실패(cacheable:false): 캐시 금지
 *  F. 동일 signature 동시 호출: single-flight로 1회만 실행
 *  + TTL/유저 전환/스토리지 불가 기본 동작
 *
 * 검증력 증명: --selftest 는 결함주입 mutant(세대 fencing 제거 / cacheable 무시 /
 * single-flight 제거)가 반드시 RED가 되는지 확인한다(항상 GREEN인 게이트 방지).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSignatureCache,
  createSingleFlight,
  createProfileLoadLedger,
  shouldCacheRegisterResponse,
  type StorageLike,
} from "../../src/lib/client-dedupe";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(id: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${id}`);
  } else {
    fail += 1;
    failures.push(id);
    console.log(`  ❌ GATE-FAIL ${id}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** 수동 resolve 가능한 deferred */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function runScenarios(deps: {
  ledgerFactory: typeof createProfileLoadLedger;
  cacheDecision: typeof shouldCacheRegisterResponse;
  flightFactory: typeof createSingleFlight;
}): Promise<void> {
  const TTL = 10 * 60 * 1000;
  let clock = 1_000_000;
  const now = () => clock;

  // ── A. SIGNED_OUT → 동일 UID 재로그인 재조회 ──
  {
    const ledger = deps.ledgerFactory(TTL, now);
    let calls = 0;
    const run = () => { calls += 1; return Promise.resolve(true); };
    await ledger.load("u1", false, run);
    await ledger.load("u1", false, run); // fresh — skip
    check("A1 fresh-skip", calls === 1, `calls=${calls}`);
    ledger.invalidate(); // SIGNED_OUT
    await ledger.load("u1", false, run); // 동일 UID 재로그인 — TTL 내여도 재조회
    check("A2 same-uid-relogin-refetch", calls === 2, `calls=${calls}`);
  }

  // ── B. 늦은 old response vs force ──
  {
    const ledger = deps.ledgerFactory(TTL, now);
    const applied: string[] = [];
    const slow = deferred<boolean>();
    // old 요청: 느리게 응답. isCurrent가 false면 적용하지 않는 계약을 시뮬레이션.
    const oldRun = (isCurrent: () => boolean) =>
      slow.promise.then((ok) => {
        if (ok && isCurrent()) applied.push("old");
        return ok && isCurrent();
      });
    const p1 = ledger.load("u1", false, oldRun);
    // force(프로필 편집 직후): 즉시 최신 응답
    await ledger.load("u1", true, (isCurrent) => {
      if (isCurrent()) applied.push("fresh");
      return Promise.resolve(true);
    });
    slow.resolve(true); // 옛 응답 늦게 도착
    await p1;
    check("B1 late-old-response-discarded", applied.join(",") === "fresh", `applied=${applied.join(",")}`);
  }

  // ── C. force 실패 후 retry ──
  {
    const ledger = deps.ledgerFactory(TTL, now);
    let calls = 0;
    await ledger.load("u1", false, () => { calls += 1; return Promise.resolve(true); }); // fresh 확보
    await ledger.load("u1", true, () => { calls += 1; return Promise.resolve(false); }); // force 실패
    await ledger.load("u1", false, () => { calls += 1; return Promise.resolve(true); }); // 재시도 가능해야
    check("C1 force-failure-invalidates-fresh", calls === 3, `calls=${calls}`);
  }

  // ── D/E. 등록 응답 캐시 판정 ──
  {
    check("D1 http-fail-no-cache", deps.cacheDecision(false, null) === false);
    check("D2 skipped-no-cache", deps.cacheDecision(true, { success: true, skipped: "live_activity_off" }) === false);
    check("D3 normal-cache", deps.cacheDecision(true, { success: true }) === true);
    check("E1 notice-fail-no-cache", deps.cacheDecision(true, { success: true, cacheable: false }) === false);
    check("E2 notice-ok-cache", deps.cacheDecision(true, { success: true, cacheable: true }) === true);
  }

  // ── F. 동일 signature 동시 호출 single-flight ──
  {
    const flight = deps.flightFactory<boolean>();
    let calls = 0;
    const slow = deferred<boolean>();
    const fn = () => { calls += 1; return slow.promise; };
    const p1 = flight.run("sig-a", fn);
    const p2 = flight.run("sig-a", fn); // 동시 — 합쳐져야
    slow.resolve(true);
    await Promise.all([p1, p2]);
    check("F1 single-flight-dedupe", calls === 1, `calls=${calls}`);
    await flight.run("sig-a", () => { calls += 1; return Promise.resolve(true); }); // 종료 후 새 실행 허용
    check("F2 flight-clears-after-settle", calls === 2, `calls=${calls}`);
  }

  // ── F3. A→B→A interleave (삼순 2차 blocker①) ──
  {
    const flight = deps.flightFactory<boolean>();
    let aCalls = 0;
    let bCalls = 0;
    const slowA = deferred<boolean>();
    const slowB = deferred<boolean>();
    const pA1 = flight.run("sig-a", () => { aCalls += 1; return slowA.promise; });
    const pB = flight.run("sig-b", () => { bCalls += 1; return slowB.promise; }); // B 시작
    const pA2 = flight.run("sig-a", () => { aCalls += 1; return slowA.promise; }); // A 재호출 — 기존 A에 합쳍져야
    slowA.resolve(true);
    slowB.resolve(true);
    await Promise.all([pA1, pB, pA2]);
    check("F3 a-b-a-interleave", aCalls === 1 && bCalls === 1, `aCalls=${aCalls} bCalls=${bCalls}`);
  }

  // ── G. signature 캐시 TTL/유저 전환/스토리지 ──
  {
    const storage = makeStorage();
    const cache = createSignatureCache("k", 1000, { storage: () => storage, now });
    cache.put("sig1");
    check("G1 cache-hit", cache.has("sig1") === true);
    check("G2 other-sig-miss", cache.has("sig2") === false); // 계정/토큰 전환 = 다른 sig
    clock += 1001;
    check("G3 ttl-expiry", cache.has("sig1") === false);
    const noStore = createSignatureCache("k", 1000, { storage: () => null, now });
    noStore.put("sig1");
    check("G4 no-storage-noop", noStore.has("sig1") === false); // dedupe 없이 기존 동작
  }

  // ── H. 유저 전환 중 옛 유저 in-flight 차단 ──
  {
    const ledger = deps.ledgerFactory(TTL, now);
    const applied: string[] = [];
    const slow = deferred<boolean>();
    const p1 = ledger.load("u1", false, (isCurrent) =>
      slow.promise.then((ok) => {
        if (ok && isCurrent()) applied.push("u1");
        return ok && isCurrent();
      }));
    await ledger.load("u2", false, (isCurrent) => {
      if (isCurrent()) applied.push("u2");
      return Promise.resolve(true);
    });
    slow.resolve(true);
    await p1;
    check("H1 stale-user-inflight-discarded", applied.join(",") === "u2", `applied=${applied.join(",")}`);
  }

  await tick();
}

// ── production wiring 검증 (삼순 2차 blocker②) ────────────────────────
// 순수 helper만 GREEN이고 소비처 배선이 빠져도 모르는 것을 막는다: 실제 소스를 읽어
// 핵심 계약 배선(임포트·invalidate 호출·isCurrent 관통·캐시 판정·single-flight·
// cacheable 보고)을 assert. 선택자는 파일명이 아니라 식별자/호출 문면(8/17 lesson).
interface WiringCheck { id: string; ok: boolean; detail?: string }

export function checkWiring(files: {
  authContext: string;
  nativePush: string;
  nativeLiveActivity: string;
  registerDeviceRoute: string;
}): WiringCheck[] {
  const c: WiringCheck[] = [];
  const add = (id: string, ok: boolean, detail?: string) => c.push({ id, ok, detail });
  const { authContext: ac, nativePush: np, nativeLiveActivity: la, registerDeviceRoute: rt } = files;

  // AuthContext — ledger 배선 + fencing 관통 + no-session invalidate 2곳 + force 우회
  add("W1 authctx-imports-ledger", /createProfileLoadLedger.*from "@\/lib\/client-dedupe"/.test(ac));
  add("W2 authctx-ledger-load", /profileLedger\.load\(userId,/.test(ac));
  add("W3 authctx-invalidate-both-branches", (ac.match(/profileLedger\.invalidate\(\)/g) ?? []).length >= 2,
    `count=${(ac.match(/profileLedger\.invalidate\(\)/g) ?? []).length}`);
  add("W4 authctx-isCurrent-threaded", /loadProfileNow\(accessToken, userId, isCurrent\)/.test(ac));
  add("W5 authctx-isCurrent-guards", (ac.match(/isCurrent\(\)/g) ?? []).length >= 5,
    `count=${(ac.match(/isCurrent\(\)/g) ?? []).length}`);
  add("W6 authctx-refresh-force", /force:\s*true/.test(ac));

  // native-push — 캐시·single-flight·캐시 판정 배선
  add("W7 push-imports", /createSignatureCache, createSingleFlight, shouldCacheRegisterResponse.*client-dedupe/.test(np));
  add("W8 push-cache-check", /regCache\.has\(sig\)/.test(np));
  add("W9 push-single-flight", /regFlight\.run\(sig,/.test(np));
  add("W10 push-cache-decision", /shouldCacheRegisterResponse\(res\.ok, body\)/.test(np) && /regCache\.put\(sig\)/.test(np));

  // native-live-activity — 동일 배선
  add("W11 la-imports", /createSignatureCache, createSingleFlight, shouldCacheRegisterResponse.*client-dedupe/.test(la));
  add("W12 la-cache-check", /startRegCache\.has\(sig\)/.test(la));
  add("W13 la-single-flight", /startRegFlight\.run\(sig,/.test(la));
  add("W14 la-cache-decision", /shouldCacheRegisterResponse\(res\.ok, body\)/.test(la) && /startRegCache\.put\(sig\)/.test(la));

  // register-device route — 긴급공지 실패 cacheable:false 보고
  add("W15 route-cacheable-flag", /let cacheable = true/.test(rt) && /cacheable = false/.test(rt));
  add("W16 route-returns-cacheable", /NextResponse\.json\(\{ success: true, cacheable \}\)/.test(rt));
  return c;
}

function loadRealFiles() {
  return {
    authContext: readFileSync(join(ROOT, "src/lib/supabase/AuthContext.tsx"), "utf8"),
    nativePush: readFileSync(join(ROOT, "src/lib/native-push.ts"), "utf8"),
    nativeLiveActivity: readFileSync(join(ROOT, "src/lib/native-live-activity.ts"), "utf8"),
    registerDeviceRoute: readFileSync(join(ROOT, "src/app/api/push/register-device/route.ts"), "utf8"),
  };
}

// ── selftest mutants: 결함주입 시 게이트가 RED가 되는지 증명 ──────────
function mutantLedgerNoFencing(ttlMs: number, now: () => number = Date.now): ReturnType<typeof createProfileLoadLedger> {
  // 결함: force가 세대를 올리지 않고, invalidate가 fresh만 지움 → B·C 계열이 뚫린다
  let fresh: { userId: string; at: number } | null = null;
  return {
    invalidate() { fresh = null; },
    load(userId, force, run) {
      if (!force && fresh && fresh.userId === userId && now() - fresh.at < ttlMs) return Promise.resolve();
      const isCurrent = () => true; // fencing 없음
      return run(isCurrent).then((ok) => { if (ok) fresh = { userId, at: now() }; });
    },
  };
}

const mutantCacheDecision: typeof shouldCacheRegisterResponse = (resOk) => resOk; // cacheable/skipped 무시

function mutantNoSingleFlight<T>(): ReturnType<typeof createSingleFlight<T>> {
  return { run: (_key, fn) => fn() }; // 합치지 않음
}

async function main(): Promise<void> {
  const selftest = process.argv.includes("--selftest");

  if (!selftest) {
    console.log("[client-dedupe-gate] 실코드 검증");
    await runScenarios({
      ledgerFactory: createProfileLoadLedger,
      cacheDecision: shouldCacheRegisterResponse,
      flightFactory: createSingleFlight,
    });
    console.log("[client-dedupe-gate] production wiring 검증");
    for (const w of checkWiring(loadRealFiles())) {
      check(w.id, w.ok, w.detail);
    }
    console.log(`\nRESULT: ${fail === 0 ? "GREEN" : "RED"} (${pass} pass / ${fail} fail)`);
    if (fail > 0) {
      console.error("FAILED:", failures.join(", "));
      process.exit(1);
    }
    return;
  }

  // selftest: 각 mutant가 반드시 최소 1개 시나리오를 RED로 만들어야 한다
  console.log("[client-dedupe-gate] --selftest (결함주입 mutant는 RED여야 함)");
  const mutants: Array<[string, Parameters<typeof runScenarios>[0]]> = [
    ["M1 no-generation-fencing", {
      ledgerFactory: mutantLedgerNoFencing,
      cacheDecision: shouldCacheRegisterResponse,
      flightFactory: createSingleFlight,
    }],
    ["M2 ignore-cacheable-flag", {
      ledgerFactory: createProfileLoadLedger,
      cacheDecision: mutantCacheDecision,
      flightFactory: createSingleFlight,
    }],
    ["M3 no-single-flight", {
      ledgerFactory: createProfileLoadLedger,
      cacheDecision: shouldCacheRegisterResponse,
      flightFactory: mutantNoSingleFlight,
    }],
  ];
  let selftestOk = true;
  for (const [name, deps] of mutants) {
    pass = 0; fail = 0; failures.length = 0;
    await runScenarios(deps);
    const red = fail > 0;
    console.log(`  ${red ? "✅" : "❌ SELFTEST-FAIL"} mutant ${name} → ${red ? "RED (검출됨)" : "GREEN (검출 실패!)"}`);
    if (!red) selftestOk = false;
  }

  // wiring mutants: 실제 소스에서 핵심 배선을 제거해도 wiring 검사가 RED가 되는지
  const real = loadRealFiles();
  const wiringMutants: Array<[string, Parameters<typeof checkWiring>[0]]> = [
    ["W-M1 authctx-no-invalidate", { ...real, authContext: real.authContext.replaceAll("profileLedger.invalidate()", "/* removed */") }],
    ["W-M2 authctx-no-isCurrent", { ...real, authContext: real.authContext.replaceAll("loadProfileNow(accessToken, userId, isCurrent)", "loadProfileNow(accessToken, userId, () => true)") }],
    ["W-M3 push-ignore-decision", { ...real, nativePush: real.nativePush.replace("shouldCacheRegisterResponse(res.ok, body)", "res.ok") }],
    ["W-M4 la-no-flight", { ...real, nativeLiveActivity: real.nativeLiveActivity.replace("startRegFlight.run(sig,", "((_s: string, fn: () => Promise<void>) => fn())(sig,") }],
    ["W-M5 route-always-cacheable", { ...real, registerDeviceRoute: real.registerDeviceRoute.replace("cacheable = false", "cacheable = true") }],
  ];
  for (const [name, files] of wiringMutants) {
    const red = checkWiring(files).some((w) => !w.ok);
    console.log(`  ${red ? "✅" : "❌ SELFTEST-FAIL"} wiring mutant ${name} → ${red ? "RED (검출됨)" : "GREEN (검출 실패!)"}`);
    if (!red) selftestOk = false;
  }

  console.log(`\nSELFTEST: ${selftestOk ? "GREEN" : "RED"}`);
  if (!selftestOk) process.exit(1);
}

main().catch((e) => {
  console.error("GATE-ERROR:", e);
  process.exit(1);
});
