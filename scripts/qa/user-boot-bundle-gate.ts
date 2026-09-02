/**
 * PR④ per-user 부트 번들 종단 게이트 — qa:user-boot-bundle (v3)
 *
 * 검증 축 (삼순 #1332 1·2차 NO-GO 반영):
 *  [E] actual seam 종단: 실제 boot-loader.performBootLoad(AuthContext 1차 경로의 분리 모듈)를
 *      fetch 스텁 위에서 구동 — cold boot 에서 /api/me/boot 정확히 1콜 + 소비자(실제
 *      native-live-activity.isLiveActivityEnabled)가 push/prefs fetch 0회로 소비.
 *      include=prefs 게이팅(native vs web) call-URL 검증 포함.
 *  [P] production-seam call-count: 실소비자 구동 — race·fallback·계정전환·세션캐시.
 *  [L] late consumer 지연 제거: 부트 종료 후 소비(캐시 만료 포함)는 begin 유예 없이
 *      즉시 fallback (경과시간 상한으로 5s 대기 부재 증명).
 *  [G] generation 결속: invalidate 후 옛 settle 이 캐시를 재생성하지 못함 · 연속 begin
 *      (force-load supersede)이 구 waiter 를 즉시 해제.
 *  [D] direct 계약 + [M] mutation RED: 실소스 변조 사본 실행(베이스라인 전축 PASS 전제) —
 *      boot-cache 5종 + 배선 제거 3종(include 게이팅·settle(null)·Android awaitBootPrefs).
 *
 * 한계(명시): AuthContext(.tsx React Provider)·Android Capacitor 분기·React 훅은 node 에서
 * 원리적으로 구동 불가 — AuthContext→performBootLoad 위임과 Android/game-chat 배선은
 * 구조 검사 + 배선 제거 mutation RED 로 커버한다.
 *
 * 실행: npx tsx scripts/qa/user-boot-bundle-gate.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qa-dummy.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "qa-dummy-anon-key";

const ROOT = path.resolve(__dirname, "../..");
const results: Array<{ id: string; ok: boolean; note?: string }> = [];
function check(id: string, ok: boolean, note?: string) {
  results.push({ id, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${id}${note ? ` — ${note}` : ""}`);
}

type PrefsLike = Record<string, boolean>;
const PREFS_ON: PrefsLike = { live_activity: true };
const PREFS_OFF: PrefsLike = { live_activity: false };

// ── fetch 스텁 (call-count + URL 기록) ──────────────────────────────────
let pushPrefsFetchCount = 0;
let bootFetchCount = 0;
let bootFetchUrls: string[] = [];
let fetchPrefsValue: PrefsLike = PREFS_OFF;
let bootResponse: { ok: boolean; profile: Record<string, unknown> | null; prefs: PrefsLike | null } =
  { ok: true, profile: { id: "u" }, prefs: PREFS_OFF };
const realFetch = globalThis.fetch;
function installFetchStub() {
  // @ts-expect-error 테스트 스텁 — globalThis.fetch 를 call-count 스텁으로 교체
  globalThis.fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/me/boot")) {
      bootFetchCount += 1;
      bootFetchUrls.push(url);
      return {
        ok: bootResponse.ok,
        json: async () => ({ profile: bootResponse.profile, prefs: bootResponse.prefs }),
      };
    }
    if (url.includes("/api/push/prefs")) {
      pushPrefsFetchCount += 1;
      return { ok: true, json: async () => ({ prefs: fetchPrefsValue }) };
    }
    throw new Error(`unexpected network call: ${url}`);
  };
}
function resetCounts() {
  pushPrefsFetchCount = 0;
  bootFetchCount = 0;
  bootFetchUrls = [];
}

// ── 모듈 로드 (단일 인스턴스 — 소비자·로더·캐시가 같은 boot-cache 를 공유) ──
async function loadModules() {
  const bootCache = await import(pathToFileURL(path.join(ROOT, "src/lib/boot-cache.ts")).href);
  const consumer = await import(pathToFileURL(path.join(ROOT, "src/lib/native-live-activity.ts")).href);
  const loader = await import(pathToFileURL(path.join(ROOT, "src/lib/boot-loader.ts")).href);
  return { bootCache, consumer, loader };
}

async function patchSession(userId: string | null) {
  const { supabase } = await import(pathToFileURL(path.join(ROOT, "src/lib/supabase/client.ts")).href);
  supabase.auth.getSession = async () => ({
    data: { session: userId ? { access_token: "***", user: { id: userId } } : null },
  });
}

async function endToEndScenarios(m: Awaited<ReturnType<typeof loadModules>>) {
  const { bootCache, consumer, loader } = m;

  // E1 actual cold boot: 소비자 선행 → performBootLoad(native) → boot 1콜·prefs 소비·push fetch 0
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-e1");
  resetCounts();
  bootResponse = { ok: true, profile: { id: "u-e1" }, prefs: PREFS_OFF };
  {
    const consumerPending: Promise<boolean> = consumer.__qaIsLiveActivityEnabled();
    await new Promise((r) => setTimeout(r, 20)); // 소비자 먼저 대기 진입 (NativePushMount race)
    const out = await loader.performBootLoad("tkn", "u-e1", () => true, true);
    const enabled = await consumerPending;
    check("E1 actual cold-boot: boot 1콜·소비자 push fetch 0·값 정확",
      out.status === "ok" && bootFetchCount === 1 && pushPrefsFetchCount === 0 && enabled === false,
      `boot=${bootFetchCount} push=${pushPrefsFetchCount} enabled=${enabled}`);
    check("E1b include=prefs (native)", bootFetchUrls[0]?.includes("include=prefs") === true, bootFetchUrls[0]);
  }

  // E2 웹 런타임: include=prefs 미포함 (DB read 증가 0 계약의 클라측 절반)
  bootCache.__qaResetBootCache();
  resetCounts();
  {
    const out = await loader.performBootLoad("tkn", "u-e2", () => true, false);
    check("E2 web: include=prefs 없음", out.status === "ok" && bootFetchCount === 1 &&
      bootFetchUrls[0] !== undefined && !bootFetchUrls[0].includes("include=prefs"), bootFetchUrls[0]);
  }

  // E3 boot 실패(non-ok): settle(null) → 대기 소비자 즉시 fallback fetch 1 (결박 없음)
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-e3");
  resetCounts();
  fetchPrefsValue = PREFS_ON;
  bootResponse = { ok: false, profile: null, prefs: null };
  {
    const consumerPending: Promise<boolean> = consumer.__qaIsLiveActivityEnabled();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    const out = await loader.performBootLoad("tkn", "u-e3", () => true, true);
    const enabled = await consumerPending;
    const elapsed = Date.now() - t0;
    check("E3 boot 실패: settle(null)·소비자 즉시 fallback fetch 1",
      out.status === "miss" && enabled === true && pushPrefsFetchCount === 1 && elapsed < 2000,
      `push=${pushPrefsFetchCount} elapsed=${elapsed}ms`);
  }

  // E4 isCurrent 탈락(stale): settle(null) — 옛 응답이 캐시를 만들지 않음
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-e4");
  resetCounts();
  bootResponse = { ok: true, profile: { id: "u-e4" }, prefs: PREFS_OFF };
  {
    const out = await loader.performBootLoad("tkn", "u-e4", () => false, true);
    fetchPrefsValue = PREFS_ON;
    const enabled = await consumer.__qaIsLiveActivityEnabled();
    check("E4 stale boot: 캐시 미생성·소비자 fallback",
      out.status === "stale" && enabled === true && pushPrefsFetchCount === 1,
      `push=${pushPrefsFetchCount}`);
  }
}

async function lateAndGenerationScenarios(m: Awaited<ReturnType<typeof loadModules>>) {
  const { bootCache, consumer, loader } = m;

  // L1 late 소비자(부트 종료 + 캐시 만료): begin 유예 없이 즉시 fallback (<2s, 5s 아님)
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-l1");
  resetCounts();
  bootResponse = { ok: true, profile: { id: "u-l1" }, prefs: PREFS_OFF };
  {
    await loader.performBootLoad("tkn", "u-l1", () => true, true);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000; // TTL 만료 (late 경기방 진입)
    try {
      fetchPrefsValue = PREFS_ON;
      const t0 = realNow();
      const enabled = await consumer.__qaIsLiveActivityEnabled();
      const elapsed = realNow() - t0;
      check("L1 late consumer: 즉시 fallback (begin 5s 대기 없음)",
        enabled === true && pushPrefsFetchCount === 1 && elapsed < 2000,
        `elapsed=${elapsed}ms push=${pushPrefsFetchCount}`);
    } finally { Date.now = realNow; }
  }

  // G1 invalidate 후 옛 settle 무시: 로그아웃/토글 뒤 옛 응답이 캐시 재생성 못 함
  bootCache.__qaResetBootCache();
  {
    const token = bootCache.beginBootLoad("u-g1");
    bootCache.invalidateBootCache(); // 로그아웃/토글
    bootCache.settleBootLoad(token, PREFS_ON); // 옛 settle 도착
    const got = await bootCache.awaitBootPrefs("u-g1", "liveActivityGate");
    check("G1 invalidate 후 옛 settle 무시", got === null, got === null ? "ok" : "stale cache 재생성!");
  }

  // G2 연속 begin(force-load) supersede: 구 waiter 즉시 해제 (10s 결박 없음)
  bootCache.__qaResetBootCache();
  {
    const t1 = bootCache.beginBootLoad("u-g2");
    const waiter = bootCache.awaitBootPrefs("u-g2", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const t2 = bootCache.beginBootLoad("u-g2"); // force-load — t1 supersede
    const got = await waiter; // 구 waiter — 즉시 풀려야 함
    const elapsed = Date.now() - t0;
    bootCache.settleBootLoad(t2, PREFS_ON);
    bootCache.settleBootLoad(t1, PREFS_OFF); // 뒤늦은 구 settle — 무시돼야 함
    const fresh = await bootCache.awaitBootPrefs("u-g2", "androidLockCardGate");
    check("G2 supersede: 구 waiter 즉시 해제 + 구 settle 무시",
      elapsed < 2000 && (got === null || got.live_activity === true) &&
      fresh !== null && fresh.live_activity === true,
      `elapsed=${elapsed}ms got=${JSON.stringify(got)} fresh=${JSON.stringify(fresh)}`);
  }
}

async function productionSeamScenarios(m: Awaited<ReturnType<typeof loadModules>>) {
  const { bootCache, consumer } = m;

  // P3 계정 전환: uA 번들을 uB 가 소비하지 못함 → fetch 1
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-p3b");
  resetCounts();
  fetchPrefsValue = PREFS_OFF;
  {
    const tok = bootCache.beginBootLoad("u-p3a");
    bootCache.settleBootLoad(tok, PREFS_ON);
    const enabled = await consumer.__qaIsLiveActivityEnabled();
    check("P3 계정전환: 타계정 번들 미소비·fetch 1", enabled === false && pushPrefsFetchCount === 1,
      `enabled=${enabled} fetch=${pushPrefsFetchCount}`);
  }

  // P4 소비자 세션 캐시: 같은 인스턴스 2회째는 fetch 재발생 없음 (종전 계약 보존)
  bootCache.__qaResetBootCache();
  consumer.__qaResetLiveActivityPrefCache();
  await patchSession("u-p4");
  resetCounts();
  {
    const tok = bootCache.beginBootLoad("u-p4");
    bootCache.settleBootLoad(tok, PREFS_ON);
    const first = await consumer.__qaIsLiveActivityEnabled();
    const second = await consumer.__qaIsLiveActivityEnabled();
    check("P4 소비자 모듈 캐시 보존", first === true && second === true && pushPrefsFetchCount === 0,
      `fetch=${pushPrefsFetchCount}`);
  }
}

// ── direct + mutation 공용 미니 스위트 (스케일 상수 사본에서 실행) ──────
interface CacheModule {
  beginBootLoad: (u: string) => { userId: string; generation: number };
  settleBootLoad: (t: { userId: string; generation: number }, p: PrefsLike | null) => void;
  awaitBootPrefs: (u: string, s: string) => Promise<PrefsLike | null>;
  invalidateBootCache: () => void;
  __qaResetBootCache: () => void;
}
async function miniSuite(m: CacheModule): Promise<string[]> {
  const fails: string[] = [];
  const expect = (id: string, cond: boolean) => { if (!cond) fails.push(id); };
  m.__qaResetBootCache();

  // A 소비자 선행 race → 최초 begin/settle 후 소비
  {
    const p = m.awaitBootPrefs("u1", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 10));
    const t = m.beginBootLoad("u1");
    m.settleBootLoad(t, PREFS_ON);
    expect("A race-consume", (await p) !== null);
  }
  // A2 지연 settle
  {
    const t = m.beginBootLoad("u1b");
    const p = m.awaitBootPrefs("u1b", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 20));
    m.settleBootLoad(t, PREFS_ON);
    expect("A2 delayed-settle", (await p) !== null);
  }
  // B settle(null) fail-open
  { const t = m.beginBootLoad("u2"); m.settleBootLoad(t, null);
    expect("B null-failopen", (await m.awaitBootPrefs("u2", "liveActivityGate")) === null); }
  // C consume-once + 슬라이스 독립
  { const t = m.beginBootLoad("u3"); m.settleBootLoad(t, PREFS_ON);
    expect("C first-consume", (await m.awaitBootPrefs("u3", "liveActivityGate")) !== null);
    expect("C consume-once", (await m.awaitBootPrefs("u3", "liveActivityGate")) === null);
    expect("C2 slice-independent", (await m.awaitBootPrefs("u3", "androidLockCardGate")) !== null); }
  // D userId 결속
  { const t = m.beginBootLoad("uA"); m.settleBootLoad(t, PREFS_ON);
    expect("D user-binding", (await m.awaitBootPrefs("uB", "liveActivityGate")) === null); }
  // E TTL
  { const t = m.beginBootLoad("u5"); m.settleBootLoad(t, PREFS_ON);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try { expect("E ttl", (await m.awaitBootPrefs("u5", "liveActivityGate")) === null); }
    finally { Date.now = realNow; } }
  // F late(everBegan 후 pending 부재) → 즉시 null. 스케일 grace 200ms 대비 상한 50ms —
  // m6(late grace 복원) mutation 이면 ~200ms 대기가 발생해 RED.
  { const t0 = Date.now();
    const got = await m.awaitBootPrefs("u-late", "liveActivityGate");
    expect("F late-immediate", got === null && Date.now() - t0 < 50); }
  // F2 최초 begin 전 grace 타임아웃 미스
  { m.__qaResetBootCache();
    expect("F2 pre-begin-timeout", (await m.awaitBootPrefs("u-none", "liveActivityGate")) === null); }
  // G invalidate + 옛 settle 무시
  { const t = m.beginBootLoad("u6");
    m.invalidateBootCache();
    m.settleBootLoad(t, PREFS_ON);
    expect("G invalidate-stale-settle", (await m.awaitBootPrefs("u6", "liveActivityGate")) === null); }
  // G2 supersede: 구 waiter "즉시" 해제(상한 50ms — m5 미resolve mutation 이면 SETTLE
  // 타임아웃 100ms 결박이 발생해 RED) + 구 settle 무시 + 신 settle 유효
  { const t1 = m.beginBootLoad("u8");
    const w = m.awaitBootPrefs("u8", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const t2 = m.beginBootLoad("u8"); // supersede — 구 waiter 는 여기서 풀려야 한다
    m.settleBootLoad(t2, PREFS_ON);
    m.settleBootLoad(t1, PREFS_OFF);
    await w;
    expect("G2 old-waiter-released-fast", Date.now() - t0 < 50);
    const fresh = await m.awaitBootPrefs("u8", "androidLockCardGate");
    expect("G2 supersede-new-settle", fresh !== null && fresh.live_activity === true); }
  // H 재settle(재부트) 시 consume 리셋
  { const t = m.beginBootLoad("u7"); m.settleBootLoad(t, PREFS_ON);
    expect("H first", (await m.awaitBootPrefs("u7", "liveActivityGate")) !== null);
    const t2 = m.beginBootLoad("u7"); m.settleBootLoad(t2, PREFS_ON);
    expect("H resettle-reconsume", (await m.awaitBootPrefs("u7", "liveActivityGate")) !== null); }
  return fails;
}

const TMP_DIR = path.join(ROOT, "scripts/qa/.tmp-boot-cache");

function scaleTimeouts(src: string): string {
  const out = src
    .replace("const BEGIN_GRACE_MS = 5 * 1000;", "const BEGIN_GRACE_MS = 200;")
    .replace("const SETTLE_TIMEOUT_MS = 10 * 1000;", "const SETTLE_TIMEOUT_MS = 100;");
  if (out === src) throw new Error("timeout scale anchors missing — boot-cache.ts 상수 변경됨, 게이트 동기화 필요");
  return out;
}

interface Mutation { id: string; find: string; replace: string }
const CACHE_MUTATIONS: Mutation[] = [
  { id: "m1-user-binding-removed", find: "if (cache.userId !== userId) return null;", replace: "" },
  { id: "m2-ttl-removed", find: "if (Date.now() - cache.at > BOOT_CACHE_TTL_MS) return null;", replace: "" },
  { id: "m3-consume-once-removed", find: "if (consumed.has(slice)) return null;\n  consumed.add(slice);", replace: "" },
  {
    id: "m4-generation-check-removed",
    find: "if (!pending || pending.generation !== token.generation || pending.userId !== token.userId) {\n    return; // superseded — 캐시/대기자에 영향 없음\n  }",
    replace: "if (!pending) { cache = { userId: token.userId, prefs, at: Date.now() }; consumed = new Set(); return; }",
  },
  { id: "m5-supersede-not-resolving", find: "    pending.resolve(); // 구 waiter 즉시 해제 → takeFresh 미스로 fallback\n    pending = null;", replace: "    pending = null;" },
  { id: "m6-late-grace-restored", find: "    if (everBegan) return null;", replace: "" },
];

async function mutationScenarios() {
  const srcPath = path.join(ROOT, "src/lib/boot-cache.ts");
  const original = readFileSync(srcPath, "utf8");
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // 베이스라인(스케일만 적용) 전축 PASS — 스위트 검증력의 전제
  const basePath = path.join(TMP_DIR, "boot-cache.baseline.ts");
  writeFileSync(basePath, scaleTimeouts(original));
  const baseline = await import(pathToFileURL(basePath).href) as unknown as CacheModule;
  const baseFails = await miniSuite(baseline);
  check("M0 baseline 전축 PASS", baseFails.length === 0, baseFails.join(",") || "ok");

  for (const mu of CACHE_MUTATIONS) {
    if (!original.includes(mu.find)) {
      check(`M ${mu.id}`, false, "mutation anchor 소실 — FAIL(게이트 동기화 필요)");
      continue;
    }
    const mutated = scaleTimeouts(original.replace(mu.find, mu.replace));
    const mPath = path.join(TMP_DIR, `boot-cache.${mu.id}.ts`);
    writeFileSync(mPath, mutated);
    const mod = await import(pathToFileURL(mPath).href) as unknown as CacheModule;
    const fails = await miniSuite(mod);
    check(`M ${mu.id} → RED`, fails.length > 0, fails.join(",") || "미검출(스위트 무력)");
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
}

// ── 배선 제거 mutation (route include 게이팅 · loader settle(null) · Android awaitBootPrefs) ──
// node 로 구동 가능한 축은 실행형(RED = 미니 실행 실패), 불가한 축(Android)은
// "배선 제거 시 구조검사 RED" 로 커버.
async function wiringMutationScenarios(m: Awaited<ReturnType<typeof loadModules>>) {
  const { bootCache } = m;

  // W1 loader 의 실패 settle(null) 제거 → E3 축(소비자 결박 해제) 이 깨짐을 실행으로 증명
  {
    const loaderSrc = readFileSync(path.join(ROOT, "src/lib/boot-loader.ts"), "utf8");
    const anchor = "  if (!bootSettled) settleBootLoad(bootToken, null); // 실패 fail-open — 대기 소비자 즉시 해제";
    if (!loaderSrc.includes(anchor)) {
      check("W1 loader-settle-null mutation", false, "anchor 소실");
    } else {
      rmSync(TMP_DIR, { recursive: true, force: true });
      mkdirSync(TMP_DIR, { recursive: true });
      // 사본 loader 가 실제 boot-cache 인스턴스를 쓰도록 상대 import 를 절대경로로 재작성
      const mutated = loaderSrc
        .replace(anchor, "")
        .replace('from "@/lib/boot-cache"', `from "${pathToFileURL(path.join(ROOT, "src/lib/boot-cache.ts")).href}"`)
        .replace('from "@/lib/capacitor/platform"', `from "${pathToFileURL(path.join(ROOT, "src/lib/capacitor/platform.ts")).href}"`)
        .replace('from "@/lib/notifications/prefs"', `from "${pathToFileURL(path.join(ROOT, "src/lib/notifications/prefs.ts")).href}"`);
      const mPath = path.join(TMP_DIR, "boot-loader.w1.ts");
      writeFileSync(mPath, mutated);
      const mutLoader = await import(pathToFileURL(mPath).href);
      bootCache.__qaResetBootCache();
      resetCounts();
      bootResponse = { ok: false, profile: null, prefs: null };
      await mutLoader.performBootLoad("tkn", "u-w1", () => true, true);
      // settle(null) 이 빠졌으니 pending 이 살아있고, waiter 는 SETTLE_TIMEOUT 까지 결박된다.
      const t0 = Date.now();
      const got = await bootCache.awaitBootPrefs("u-w1", "liveActivityGate");
      const blocked = Date.now() - t0 > 2000; // 실스케일 10s 대기 발생 = 계약 위반 검출
      check("W1 loader-settle-null 제거 → RED(waiter 결박 검출)", got === null && blocked,
        `blockedMs=${Date.now() - t0}`);
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  }

  // W2 route include 게이팅 제거 → 구조검사 RED 증명 (실행: route 는 next 서버 전용이라 소스 판정)
  {
    const routeSrc = readFileSync(path.join(ROOT, "src/app/api/me/boot/route.ts"), "utf8");
    const hasGating = routeSrc.includes('searchParams.get("include") === "prefs"') &&
      /includePrefs\s*\?/.test(routeSrc);
    check("W2 route include=prefs 게이팅 존재", hasGating);
    const mutated = routeSrc.replace('request.nextUrl.searchParams.get("include") === "prefs"', "true");
    const mutatedStillGated = mutated.includes('searchParams.get("include") === "prefs"');
    check("W2b 게이팅 제거 mutation → 구조검사 RED", !mutatedStillGated);
  }

  // W3 Android awaitBootPrefs 배선 제거 → 구조검사 RED 증명
  {
    const src = readFileSync(path.join(ROOT, "src/lib/capacitor/game-notification.ts"), "utf8");
    const predicate = (code: string) =>
      /awaitBootPrefs\(bootUserId, "androidLockCardGate"\)/.test(code) &&
      code.indexOf("awaitBootPrefs(bootUserId") < code.indexOf('fetch("/api/push/prefs"');
    check("W3 android 배선 존재", predicate(src));
    const mutated = src.replace(/const bootPrefs = bootUserId \? await awaitBootPrefs\(bootUserId, "androidLockCardGate"\) : null;/, "const bootPrefs = null;");
    check("W3b android 배선 제거 mutation → 구조검사 RED", !predicate(mutated));
  }
}

// ── 구조 배선 검사 (node 구동 불가 축 — 한계 명시) ──────────────────────
function structuralScenarios() {
  const auth = readFileSync(path.join(ROOT, "src/lib/supabase/AuthContext.tsx"), "utf8");
  check("S1 AuthContext → performBootLoad 위임 + invalidate 배선",
    /performBootLoad\(accessToken, userId, isCurrent\)/.test(auth) &&
    /invalidateBootCache\(\)/.test(auth));

  const hook = readFileSync(path.join(ROOT, "src/hooks/useGameChatVisibility.ts"), "utf8");
  check("S2 game-chat profile 파생 + PUT 후 refreshProfile",
    /profile\.game_chat_enabled !== false/.test(hook) && /void refreshProfile\(\)/.test(hook));

  const nla = readFileSync(path.join(ROOT, "src/lib/native-live-activity.ts"), "utf8");
  check("S3 iOS 게이트 awaitBootPrefs 배선 + 토글 시 invalidate",
    /awaitBootPrefs\(bootUserId, "liveActivityGate"\)/.test(nla) &&
    /invalidateBootCache\(\);/.test(nla));

  const tiers = readFileSync(path.join(ROOT, "scripts/qa/gate-tiers.json"), "utf8");
  check("S4 gate-tiers.json 등록", /"qa:user-boot-bundle"/.test(tiers));
}

async function main() {
  console.log("== user-boot-bundle gate (v3) ==");
  installFetchStub();
  const m = await loadModules();
  await endToEndScenarios(m);
  await lateAndGenerationScenarios(m);
  await productionSeamScenarios(m);
  await mutationScenarios();
  await wiringMutationScenarios(m);
  structuralScenarios();
  // @ts-expect-error 테스트 스텁 복원 (globalThis.fetch 타입 불일치 허용)
  globalThis.fetch = realFetch;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    console.error("FAILED:", failed.map((f) => f.id).join(", "));
    process.exit(1);
  }
}

void main();
