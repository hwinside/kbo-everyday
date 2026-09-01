/**
 * PR④ per-user 부트 번들 종단 게이트 — qa:user-boot-bundle
 *
 * 검증 축 (삼순 #1332 NO-GO ①④ 반영):
 *  [P] production-seam: 실제 소비자(native-live-activity.isLiveActivityEnabled)를 node 에서
 *      구동해 cold boot 시 /api/push/prefs fetch 0회(= 번들 1콜로 흡수), 부트 실패/미대기
 *      시 종전 fetch 1회 fallback 을 call-count 로 증명. 소비자-선행(NativePushMount race)
 *      시나리오 포함 — awaitBootPrefs 가 begin 을 기다렸다가 settle 값을 소비한다.
 *  [D] boot-cache 직접 계약: consume-once · userId 결속 · TTL · settle(null) fail-open ·
 *      invalidate · begin-grace 타임아웃.
 *  [M] mutation RED: boot-cache 실제 소스를 변조한 사본을 tsx 로 로드해 미니 스위트가
 *      실패함을 증명 (베이스라인 사본은 전축 PASS 필수). 검사 강도 선택자 없음.
 *  [S] 구조 배선: Android 게이트·game-chat 훅·AuthContext 의 배선 존재 (node 에서 원리적으로
 *      구동 불가한 축 — Android 분기·React 훅 — 은 구조 검사로 한정, 한계 명시).
 *
 * 실행: npx tsx scripts/qa/user-boot-bundle-gate.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

// supabase 클라이언트 모듈 import 전에 더미 env (네트워크 호출 없음)
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

// ── fetch 스텁 (call-count) ─────────────────────────────────────────────
let pushPrefsFetchCount = 0;
let fetchPrefsValue: PrefsLike = PREFS_OFF;
const realFetch = globalThis.fetch;
function installFetchStub() {
  // @ts-expect-error 테스트 스텁 — globalThis.fetch 를 call-count 스텁으로 교체
  globalThis.fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/push/prefs")) {
      pushPrefsFetchCount += 1;
      return { ok: true, json: async () => ({ prefs: fetchPrefsValue }) };
    }
    throw new Error(`unexpected network call: ${url}`);
  };
}

// ── production-seam: 실제 소비자 구동 ───────────────────────────────────
// 단일 인스턴스 import(쿼리 버스트 없음) — 소비자의 "@/lib/boot-cache"·클라이언트와
// 게이트의 import 가 같은 모듈 인스턴스를 공유함을 보장. 시나리오 격리는 QA reset export.
async function loadConsumer() {
  return import(pathToFileURL(path.join(ROOT, "src/lib/native-live-activity.ts")).href);
}

async function patchSession(userId: string | null) {
  const { supabase } = await import(pathToFileURL(path.join(ROOT, "src/lib/supabase/client.ts")).href);
  supabase.auth.getSession = async () => ({
    data: { session: userId ? { access_token: "qa-token", user: { id: userId } } : null },
  });
  return supabase;
}

async function productionSeamScenarios() {
  const bootCache = await import(pathToFileURL(path.join(ROOT, "src/lib/boot-cache.ts")).href);
  const consumer = await loadConsumer();
  installFetchStub();

  // P1 cold boot + 소비자 선행(race): consumer 가 begin 전에 호출돼도 settle 값을 소비, fetch 0
  await patchSession("u-p1");
  {
    consumer.__qaResetLiveActivityPrefCache();
    pushPrefsFetchCount = 0;
    const pending: Promise<boolean> = consumer.__qaIsLiveActivityEnabled();
    await new Promise((r) => setTimeout(r, 30)); // 소비자 먼저 대기 상태 진입
    bootCache.beginBootLoad("u-p1");
    bootCache.settleBootLoad("u-p1", PREFS_OFF);
    const enabled = await pending;
    check("P1 cold-boot race: 번들 소비·fetch 0", enabled === false && pushPrefsFetchCount === 0,
      `enabled=${enabled} fetch=${pushPrefsFetchCount}`);
  }

  // P2 부트 실패(settle null) → 종전 fetch 1회 fallback
  await patchSession("u-p2");
  {
    consumer.__qaResetLiveActivityPrefCache();
    pushPrefsFetchCount = 0;
    fetchPrefsValue = PREFS_ON;
    bootCache.beginBootLoad("u-p2");
    bootCache.settleBootLoad("u-p2", null);
    const enabled = await consumer.__qaIsLiveActivityEnabled();
    check("P2 boot 실패 fallback: fetch 1", enabled === true && pushPrefsFetchCount === 1,
      `enabled=${enabled} fetch=${pushPrefsFetchCount}`);
  }

  // P3 계정 전환: uA 번들을 uB 가 소비하지 못함 → fetch 1 (begin 유예 경유라 ~5s)
  await patchSession("u-p3b");
  {
    consumer.__qaResetLiveActivityPrefCache();
    pushPrefsFetchCount = 0;
    fetchPrefsValue = PREFS_OFF;
    bootCache.beginBootLoad("u-p3a");
    bootCache.settleBootLoad("u-p3a", PREFS_ON);
    const enabled = await consumer.__qaIsLiveActivityEnabled();
    check("P3 계정전환: 타계정 번들 미소비·fetch 1", enabled === false && pushPrefsFetchCount === 1,
      `enabled=${enabled} fetch=${pushPrefsFetchCount}`);
  }

  // P4 소비자 세션 캐시: 같은 인스턴스 2회째는 fetch 재발생 없음 (종전 계약 보존)
  await patchSession("u-p4");
  {
    consumer.__qaResetLiveActivityPrefCache();
    pushPrefsFetchCount = 0;
    bootCache.beginBootLoad("u-p4");
    bootCache.settleBootLoad("u-p4", PREFS_ON);
    const first = await consumer.__qaIsLiveActivityEnabled();
    const second = await consumer.__qaIsLiveActivityEnabled();
    check("P4 소비자 모듈 캐시 보존", first === true && second === true && pushPrefsFetchCount === 0,
      `fetch=${pushPrefsFetchCount}`);
  }
}

// ── direct + mutation 공용 미니 스위트 ──────────────────────────────────
// 스케일된 상수(BEGIN 50ms/SETTLE 100ms) 사본에서 실행된다.
async function miniSuite(m: {
  beginBootLoad: (u: string) => void;
  settleBootLoad: (u: string, p: PrefsLike | null) => void;
  awaitBootPrefs: (u: string, s: string) => Promise<PrefsLike | null>;
  invalidateBootCache: () => void;
}): Promise<string[]> {
  const fails: string[] = [];
  const expect = (id: string, cond: boolean) => { if (!cond) fails.push(id); };

  // A 소비자 선행 race → begin/settle 후 소비
  {
    const p = m.awaitBootPrefs("u1", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 10));
    m.beginBootLoad("u1");
    m.settleBootLoad("u1", PREFS_ON);
    expect("A race-consume", (await p) !== null);
  }
  // A2 지연 settle: begin 후 소비자 대기 → 늦은 settle 소비 (pending resolve 계약)
  {
    m.beginBootLoad("u1b");
    const p = m.awaitBootPrefs("u1b", "liveActivityGate");
    await new Promise((r) => setTimeout(r, 20));
    m.settleBootLoad("u1b", PREFS_ON);
    expect("A2 delayed-settle", (await p) !== null);
  }
  // B settle(null) fail-open
  m.beginBootLoad("u2"); m.settleBootLoad("u2", null);
  expect("B null-failopen", (await m.awaitBootPrefs("u2", "liveActivityGate")) === null);
  // C consume-once
  m.beginBootLoad("u3"); m.settleBootLoad("u3", PREFS_ON);
  expect("C first-consume", (await m.awaitBootPrefs("u3", "liveActivityGate")) !== null);
  expect("C consume-once", (await m.awaitBootPrefs("u3", "liveActivityGate")) === null);
  // C2 슬라이스 독립
  expect("C2 slice-independent", (await m.awaitBootPrefs("u3", "androidLockCardGate")) !== null);
  // D userId 결속
  m.beginBootLoad("uA"); m.settleBootLoad("uA", PREFS_ON);
  expect("D user-binding", (await m.awaitBootPrefs("uB", "liveActivityGate")) === null);
  // E TTL — Date.now 전진
  m.beginBootLoad("u5"); m.settleBootLoad("u5", PREFS_ON);
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { expect("E ttl", (await m.awaitBootPrefs("u5", "liveActivityGate")) === null); }
  finally { Date.now = realNow; }
  // F begin 부재 → grace 타임아웃 미스
  expect("F begin-timeout", (await m.awaitBootPrefs("u-none", "liveActivityGate")) === null);
  // G invalidate
  m.beginBootLoad("u6"); m.settleBootLoad("u6", PREFS_ON);
  m.invalidateBootCache();
  expect("G invalidate", (await m.awaitBootPrefs("u6", "liveActivityGate")) === null);
  // H 재settle(재부트) 시 consume 리셋
  m.beginBootLoad("u7"); m.settleBootLoad("u7", PREFS_ON);
  expect("H first", (await m.awaitBootPrefs("u7", "liveActivityGate")) !== null);
  m.beginBootLoad("u7"); m.settleBootLoad("u7", PREFS_ON);
  expect("H resettle-reconsume", (await m.awaitBootPrefs("u7", "liveActivityGate")) !== null);
  return fails;
}

const TMP_DIR = path.join(ROOT, "scripts/qa/.tmp-boot-cache");

function scaleTimeouts(src: string): string {
  const out = src
    .replace("const BEGIN_GRACE_MS = 5 * 1000;", "const BEGIN_GRACE_MS = 50;")
    .replace("const SETTLE_TIMEOUT_MS = 10 * 1000;", "const SETTLE_TIMEOUT_MS = 100;");
  if (out === src) throw new Error("timeout scale anchors missing — boot-cache.ts 상수 변경됨, 게이트 동기화 필요");
  return out;
}

interface Mutation { id: string; find: string | RegExp; replace: string }
const MUTATIONS: Mutation[] = [
  { id: "m1-user-binding-removed", find: "if (cache.userId !== userId) return null;", replace: "" },
  { id: "m2-ttl-removed", find: "if (Date.now() - cache.at > BOOT_CACHE_TTL_MS) return null;", replace: "" },
  { id: "m3-consume-once-removed", find: "if (consumed.has(slice)) return null;\n  consumed.add(slice);", replace: "" },
  { id: "m4-settle-not-resolving", find: "    pending.resolve();\n    pending = null;", replace: "    pending = null;" },
  { id: "m5-resettle-consume-reset-removed", find: "  cache = { userId, prefs, at: Date.now() };\n  consumed = new Set();", replace: "  cache = { userId, prefs, at: Date.now() };" },
];

async function mutationScenarios() {
  const srcPath = path.join(ROOT, "src/lib/boot-cache.ts");
  const original = readFileSync(srcPath, "utf8");
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // 베이스라인(스케일만 적용)은 전축 PASS 필수 — 스위트 자체 검증력 증명의 전제
  const basePath = path.join(TMP_DIR, "boot-cache.baseline.ts");
  writeFileSync(basePath, scaleTimeouts(original));
  const baseline = await import(pathToFileURL(basePath).href);
  const baseFails = await miniSuite(baseline);
  check("M0 baseline 전축 PASS", baseFails.length === 0, baseFails.join(",") || "ok");

  for (const mu of MUTATIONS) {
    const mutated = scaleTimeouts(original.replace(mu.find, mu.replace));
    if (mutated === scaleTimeouts(original)) {
      check(`M ${mu.id}`, false, "mutation 패치 미적용 (anchor 소실) — FAIL");
      continue;
    }
    const mPath = path.join(TMP_DIR, `boot-cache.${mu.id}.ts`);
    writeFileSync(mPath, mutated);
    const mod = await import(pathToFileURL(mPath).href);
    const fails = await miniSuite(mod);
    check(`M ${mu.id} → RED`, fails.length > 0, fails.join(",") || "미검출(스위트 무력)");
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
}

// ── 구조 배선 검사 (node 구동 불가 축 — 한계 명시) ──────────────────────
function structuralScenarios() {
  const gameNotif = readFileSync(path.join(ROOT, "src/lib/capacitor/game-notification.ts"), "utf8");
  check("S1 android 게이트 awaitBootPrefs 배선",
    /awaitBootPrefs\(bootUserId, "androidLockCardGate"\)/.test(gameNotif) &&
    gameNotif.indexOf("awaitBootPrefs(bootUserId") < gameNotif.indexOf('fetch("/api/push/prefs"'));

  const hook = readFileSync(path.join(ROOT, "src/hooks/useGameChatVisibility.ts"), "utf8");
  check("S2 game-chat profile 파생 + PUT 후 refreshProfile",
    /profile\.game_chat_enabled !== false/.test(hook) && /void refreshProfile\(\)/.test(hook));

  const auth = readFileSync(path.join(ROOT, "src/lib/supabase/AuthContext.tsx"), "utf8");
  check("S3 AuthContext begin/settle + include=prefs 네이티브 게이팅",
    /beginBootLoad\(userId\)/.test(auth) &&
    /settleBootLoad\(userId, null\)/.test(auth) &&
    /isNativeRuntime\(\)/.test(auth) &&
    /include=prefs/.test(auth));

  const nla = readFileSync(path.join(ROOT, "src/lib/native-live-activity.ts"), "utf8");
  check("S4 QA export 존재(P축 seam)", /__qaIsLiveActivityEnabled/.test(nla));
}

async function main() {
  console.log("== user-boot-bundle gate ==");
  await productionSeamScenarios();
  await mutationScenarios();
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
