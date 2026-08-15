/** iOS/Android 알림 탭 → 앱 상태 기반 딥링크 actual 배선 회귀.
 *
 * 커버 축:
 *  - background 탭(#1070): 콜백 시점 이동 금지 → appStateChange(active)에서 1회 이동
 *  - cold-start 탭(#1198): 네이티브 PushDeepLink.consume() stash 회수 → 같은 pending으로 수렴
 *  - 중복 이동 0: cold native pending + retained JS 이벤트 동시 전달
 *  - TTL / 1회 소비 / 구빌드 플러그인 미탑재 / 외부·protocol-relative·backslash 차단
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://keubo.fan/",
});

const navigations: string[] = [];
let currentPath = "/";
const fakeLocation = {
  get href() { return `https://keubo.fan${currentPath}`; },
  set href(value: string) { navigations.push(value); },
  get pathname() { return currentPath.split("?")[0].split("#")[0]; },
  get search() {
    const q = currentPath.indexOf("?");
    if (q < 0) return "";
    return currentPath.slice(q).split("#")[0];
  },
  get hash() {
    const h = currentPath.indexOf("#");
    return h < 0 ? "" : currentPath.slice(h);
  },
  origin: "https://keubo.fan",
};
let injectedCapacitor: { isNativePlatform: () => boolean; getPlatform: () => string } | undefined;

const windowProxy = new Proxy(dom.window as unknown as Record<string | symbol, unknown>, {
  get(target, prop) {
    if (prop === "location") return fakeLocation;
    if (prop === "Capacitor") return injectedCapacitor;
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
});

const globals = globalThis as Record<string, unknown>;
globals.window = windowProxy;
globals.document = dom.window.document;

type TapCallback = (event: unknown) => void;
type StateCallback = (state: { isActive: boolean }) => void;
type UrlOpenCallback = (data: { url: string }) => void;
type Loaders = NonNullable<Parameters<PushModule["listenForNotificationTap"]>[0]>;
type PushModule = {
  listenForNotificationTap: (loaders?: {
    messaging: () => Promise<{
      addListener: (event: "notificationActionPerformed", callback: TapCallback) => Promise<{ remove: () => Promise<void> }>;
    }>;
    app: () => Promise<{
      getState: () => Promise<{ isActive: boolean }>;
      addListener: (event: "appStateChange", callback: StateCallback) => Promise<{ remove: () => Promise<void> }>;
    }>;
    pushDeepLink: () => Promise<{ consume: () => Promise<{ url?: string }> }>;
    urlOpen: (callback: UrlOpenCallback) => Promise<void>;
  }) => Promise<void>;
  __resetNotificationTapForTest: (clearPending?: boolean) => void;
};

let moduleCache: PushModule | null = null;
async function pushModule(): Promise<PushModule> {
  moduleCache ??= await import("../../src/lib/native-push-deeplink") as unknown as PushModule;
  return moduleCache;
}

const tap = (url: unknown) => ({ notification: { data: { url } } });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(options?: {
  active?: boolean;
  retained?: unknown;
  /** 네이티브 cold-start stash 반환값. undefined = stash 없음 */
  nativePending?: string;
  /** true면 PushDeepLink 로더가 throw — 구빌드(플러그인 미탑재) 재현 */
  nativeMissing?: boolean;
}) {
  let active = options?.active ?? false;
  let tapCallback: TapCallback | null = null;
  let stateCallback: StateCallback | null = null;
  let urlOpenCallback: UrlOpenCallback | null = null;
  let urlOpenSubscribes = 0;
  let messagingAdds = 0;
  let appAdds = 0;
  let nativeConsumes = 0;
  // 네이티브 stash 재현 — consume는 1회 소비(반환 후 비움). setNativePending으로
  // 런타임에 새 stash 주입 가능(warm LA 탭 재현).
  let nativePending: string | undefined = options?.nativePending;
  const loaders: Loaders = {
    messaging: async () => ({
      addListener: async (_event, callback) => {
        messagingAdds += 1;
        tapCallback = callback;
        if (options?.retained !== undefined) callback(options.retained);
        return { remove: async () => undefined };
      },
    }),
    app: async () => ({
      getState: async () => ({ isActive: active }),
      addListener: async (_event, callback) => {
        appAdds += 1;
        stateCallback = callback as StateCallback;
        return { remove: async () => undefined };
      },
    }),
    urlOpen: async (callback) => {
      urlOpenSubscribes += 1;
      urlOpenCallback = callback;
    },
    pushDeepLink: async () => {
      if (options?.nativeMissing) throw new Error("PushDeepLink does not have an implementation");
      return {
        consume: async () => {
          nativeConsumes += 1;
          const url = nativePending;
          nativePending = undefined; // 네이티브와 동일하게 1회 소비
          return url !== undefined ? { url } : {};
        },
      };
    },
  };
  return {
    loaders,
    tap: (event: unknown) => tapCallback?.(event),
    activate: () => { active = true; stateCallback?.({ isActive: true }); },
    deactivate: () => { active = false; stateCallback?.({ isActive: false }); },
    openUrl: (url: string) => { urlOpenCallback?.({ url }); },
    setNativePending: (url: string) => { nativePending = url; },
    counts: () => ({ messagingAdds, appAdds, nativeConsumes }),
    urlOpenCount: () => urlOpenSubscribes,
  };
}

async function reset(native = true, clearPending = true, path = "/") {
  injectedCapacitor = native
    ? { isNativePlatform: () => true, getPlatform: () => "ios" }
    : undefined;
  navigations.length = 0;
  currentPath = path;
  (await pushModule()).__resetNotificationTapForTest(clearPending);
}

test("1) remote-load: npm core가 web이어도 주입 bridge iOS면 실제 listener를 붙인다", async () => {
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  assert.deepEqual(h.counts(), { messagingAdds: 1, appAdds: 1, nativeConsumes: 1 });
  assert.equal(h.urlOpenCount(), 1, "urlOpen 디스패처 구독 1회");
});

test("2) web에서는 native loader/listener를 호출하지 않는다", async () => {
  await reset(false);
  const h = harness();
  await (await pushModule()).listenForNotificationTap(h.loaders);
  assert.deepEqual(h.counts(), { messagingAdds: 0, appAdds: 0, nativeConsumes: 0 });
});

test("3) background callback은 이동하지 않고 native appStateChange active에서 이동", async () => {
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  h.tap(tap("/games/20260802HHKT0?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, []);
  h.activate();
  await flush();
  assert.deepEqual(navigations, ["/games/20260802HHKT0?tab=lineup"]);
});

test("4) warm/active callback은 App.getState 확인 후 즉시 수렴", async () => {
  await reset(true);
  const h = harness({ active: true });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  h.tap(tap("/games/20260802SSLT0?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, ["/games/20260802SSLT0?tab=lineup"]);
});

test("5) listener 부착 전 retained 이벤트도 active 상태에서 소비", async () => {
  await reset(true);
  const h = harness({ active: true, retained: tap("/games/20260802LGOB0?tab=lineup") });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, ["/games/20260802LGOB0?tab=lineup"]);
});

test("6) callback 뒤 WebView reset/reload가 와도 localStorage pending을 새 attach가 복원", async () => {
  await reset(true);
  const before = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(before.loaders);
  before.tap(tap("/games/20260802HHKT0?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, []);

  await reset(true, false); // JS 등록 상태만 소실, localStorage는 WebView reload처럼 보존
  const after = harness({ active: true });
  await (await pushModule()).listenForNotificationTap(after.loaders);
  assert.deepEqual(navigations, ["/games/20260802HHKT0?tab=lineup"]);
});

test("7) pending은 1회만 소비돼 재활성화·재attach에서 중복 이동하지 않는다", async () => {
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  h.tap(tap("/games/G1?tab=lineup"));
  h.activate();
  h.activate();
  await flush();
  assert.deepEqual(navigations, ["/games/G1?tab=lineup"]);

  await reset(true, false);
  await (await pushModule()).listenForNotificationTap(harness({ active: true }).loaders);
  assert.deepEqual(navigations, []);
});

test("8) active 전 여러 알림이면 마지막 탭 URL만 이동", async () => {
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  h.tap(tap("/games/OLD?tab=lineup"));
  h.tap(tap("/games/NEW?tab=lineup"));
  h.activate();
  await flush();
  assert.deepEqual(navigations, ["/games/NEW?tab=lineup"]);
});

test("9) TTL 지난 pending은 reload 뒤 이동하지 않는다", async () => {
  await reset(true);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const h = harness({ active: false });
    await (await pushModule()).listenForNotificationTap(h.loaders);
    h.tap(tap("/games/STALE?tab=lineup"));
    now += 120_001;
    h.activate();
    await flush();
    assert.deepEqual(navigations, []);
  } finally {
    Date.now = realNow;
  }
});

test("10) 외부·protocol-relative·backslash URL은 차단", async () => {
  await reset(true);
  const h = harness({ active: true });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  for (const url of ["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "", 123]) {
    h.tap(tap(url));
  }
  await flush();
  assert.deepEqual(navigations, []);
});

test("11) 동시·반복 호출에도 listener는 각 1개", async () => {
  await reset(true);
  const h = harness({ active: false });
  const m = await pushModule();
  await Promise.all([
    m.listenForNotificationTap(h.loaders),
    m.listenForNotificationTap(h.loaders),
    m.listenForNotificationTap(h.loaders),
  ]);
  assert.deepEqual(h.counts(), { messagingAdds: 1, appAdds: 1, nativeConsumes: 1 });
  assert.equal(h.urlOpenCount(), 1, "urlOpen 디스패처 구독 1회");
});

test("12) actual mount가 정적 gate 전에 딥링크 listener를 정확히 1회 호출", async () => {
  const source = await readFile(new URL("../../src/components/NativePushMount.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ listenForNotificationTap \} from "@\/lib\/native-push-deeplink"/);
  const calls = source.match(/void listenForNotificationTap\(\);/g) ?? [];
  assert.equal(calls.length, 1, `mount 호출은 1회여야 함 (found ${calls.length}) — 중복 호출 금지`);
  const call = source.indexOf("void listenForNotificationTap();");
  const gate = source.indexOf("if (!isNativeRuntime()) return;");
  assert.ok(call >= 0 && gate >= 0 && call < gate, "mount 호출 제거·정적 gate 뒤 이동을 차단");
  assert.doesNotMatch(source, /if \(!isNative\) return/);
});

// ── cold-start(#1198) 축 ────────────────────────────────────────────────

test("13) cold-start: 네이티브 stash를 회수해 active 시 해당 페이지로 이동", async () => {
  await reset(true);
  const h = harness({ active: true, nativePending: "/games/COLD?tab=lineup" });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.equal(h.counts().nativeConsumes, 1);
  assert.deepEqual(navigations, ["/games/COLD?tab=lineup"]);
});

test("14) cold native pending + retained JS 이벤트 동시 전달 → 이동 1회", async () => {
  await reset(true);
  const h = harness({
    active: true,
    nativePending: "/games/SAME?tab=lineup",
    retained: tap("/games/SAME?tab=lineup"),
  });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, ["/games/SAME?tab=lineup"]);
});

test("15) 이미 목적지 페이지면 재이동하지 않는다(이동 후 재mount 중복 0)", async () => {
  await reset(true, true, "/games/SAME?tab=lineup");
  const h = harness({ active: true, nativePending: "/games/SAME?tab=lineup" });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, []);
});

test("16) 구빌드(PushDeepLink 미탑재)여도 JS 경로는 그대로 동작", async () => {
  await reset(true);
  const h = harness({ active: true, nativeMissing: true });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  assert.deepEqual(h.counts(), { messagingAdds: 1, appAdds: 1, nativeConsumes: 0 });
  h.tap(tap("/games/OLDBUILD?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, ["/games/OLDBUILD?tab=lineup"]);
});

test("16b) 구빌드여도 reload로 보존된 pending 복원 수렴은 계속 동작한다", async () => {
  // 네이티브 stash 회수 실패가 attach 시퀀스를 중단시키면 #1070 복원 경로까지 죽는다.
  await reset(true);
  const before = harness({ active: false, nativeMissing: true });
  await (await pushModule()).listenForNotificationTap(before.loaders);
  before.tap(tap("/games/OLDBUILD-RELOAD?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, []);

  await reset(true, false); // WebView reload — localStorage pending 보존
  const after = harness({ active: true, nativeMissing: true });
  await (await pushModule()).listenForNotificationTap(after.loaders);
  await flush();
  assert.deepEqual(navigations, ["/games/OLDBUILD-RELOAD?tab=lineup"]);
});

test("17) 네이티브 stash의 외부 URL도 차단", async () => {
  await reset(true);
  const h = harness({ active: true, nativePending: "//evil.example/x" });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, []);
});

test("22) warm LA 카드 탭: 백그라운드에서 생긴 네이티브 stash를 active 복귀 시 재회수해 이동", async () => {
  // #cs 2026-08-15 실기기 QA 재현 — 앱이 살아있는 채 잠금화면 LA 카드 탭:
  // AppDelegate continue가 stash를 쓰지만 JS는 이미 attach 완료 상태라,
  // active 복귀 이벤트에서 네이티브 stash를 재회수하지 않으면 영원히 안 움직인다.
  await reset(true);
  const h = harness({ active: true });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, []);

  h.deactivate(); // 잠금화면으로 — 앱 background
  h.setNativePending("/games/LATAP?tab=chat"); // LA 카드 탭 → continue stash
  h.activate(); // 앱 foreground 복귀
  await flush();
  assert.deepEqual(navigations, ["/games/LATAP?tab=chat"]);
});

test("23) LA widgetURL·AppDelegate continue 배선 — 카드 탭 딥링크 소스 계약", async () => {
  const widget = await readFile(new URL("../../ios/App/LiveActivity/KBOLiveActivityWidget.swift", import.meta.url), "utf8");
  // 잠금화면 카드 + DynamicIsland 전체 양쪽에 widgetURL 배선(2곳)
  const urls = widget.match(/\.widgetURL\(gameDeepLinkURL\(context\.attributes\.gameId\)\)/g) ?? [];
  assert.ok(urls.length >= 2, `잠금카드+DI widgetURL 배선 필요 (found ${urls.length})`);
  // DI는 특정 영역 뷰가 아니라 DynamicIsland 전체(minimal 블록 뒤)에 적용되어야
  // compact/minimal·모든 확장 영역 탭이 보장된다(삼순 #1204 R1-②).
  assert.match(widget, /minimal: \{[\s\S]*?\n {12}\}\n(?:[ \t]*\/\/[^\n]*\n)*[ \t]*\.widgetURL\(gameDeepLinkURL\(context\.attributes\.gameId\)\)/);
  assert.match(widget, /https:\/\/keubo\.fan\/games\//);

  // gameId 엄격 allowlist — 소스에서 정규식을 추출해 실제 판정을 재현(삼순 #1204 R1-③)
  const idReMatch = widget.match(/gameId\.range\(of: "([^"]+)", options: \.regularExpression\)/);
  assert.ok(idReMatch, "gameDeepLinkURL에 gameId allowlist 정규식 필요");
  const idRe = new RegExp(idReMatch![1]);
  assert.ok(idRe.test("20260815HHKT0"), "실제 gameId는 통과");
  for (const bad of ["../auth", "a/b", "a?x=1", "a#f", "", "a b", "게임", "a".repeat(33)]) {
    assert.ok(!idRe.test(bad), `비정상 gameId 차단 실패: ${bad}`);
  }

  const appDelegate = await readFile(new URL("../../ios/App/App/AppDelegate.swift", import.meta.url), "utf8");
  // continue(userActivity:)가 /games/<id> 폐쇄 allowlist로만 stash — 정규식 추출 후 실제 판정 재현
  assert.match(appDelegate, /NSUserActivityTypeBrowsingWeb/);
  const pathReMatch = appDelegate.match(/path\.range\(of: "([^"]+)", options: \.regularExpression\)/);
  assert.ok(pathReMatch, "continue에 /games/<id> allowlist 정규식 필요");
  const pathRe = new RegExp(pathReMatch![1]);
  assert.ok(pathRe.test("/games/20260815HHKT0"), "실제 경기 경로는 통과");
  for (const bad of [
    "/games/../auth/callback", // dot-segment auth 우회
    "/auth/callback",           // OAuth 콜백 직접
    "/games/x/../../auth",      // 중첩 dot-segment
    "/games/",                  // 빈 id
    "/games/abc/def",           // 하위 경로 주입
    "/",                        // 루트
    "/admin",                   // 임의 경로
  ]) {
    assert.ok(!pathRe.test(bad), `allowlist 우회 차단 실패: ${bad}`);
  }
  const stashes = appDelegate.match(/PushDeepLinkPlugin\.stash\(url:/g) ?? [];
  assert.ok(stashes.length >= 2, `launchOptions+continue 양쪽 stash 필요 (found ${stashes.length})`);
});

test("24b) 순서 역전: active가 먼저 오고 stash가 나중이어도 appUrlOpen 재회수로 이동", async () => {
  // iOS는 continue(stash)와 appStateChange(active)의 순서를 계약하지 않는다(삼순 #1204 R1-①).
  // active 이벤트가 먼저 소비 시도(빈손) 후 stash 도착 → appUrlOpen이 재회수 트리거.
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  h.activate(); // active 먼저 — 이 시점엔 stash 없음(빈손)
  await flush();
  assert.deepEqual(navigations, []);

  h.setNativePending("/games/REVERSE?tab=chat"); // continue 늦게 도착(stash)
  h.openUrl("https://keubo.fan/games/REVERSE?tab=chat"); // Capacitor appUrlOpen(stash 후 발행 보장)
  await flush();
  assert.deepEqual(navigations, ["/games/REVERSE?tab=chat"]);
});

// ── appUrlOpen 단일 디스패쳐(R2) — cold retained OAuth 경합 방지 ──────────────

test("25) 딥링크 모듈은 App.addListener('appUrlOpen')을 직접 등록하지 않는다(디스패쳐 경유)", async () => {
  // Capacitor iOS는 cold retained appUrlOpen을 첫 리스너에만 전달 후 삭제한다(삼순 R2).
  // 딥링크가 독립 등록하면 OAuth 콜백을 가로채 로그인이 깨진다 → 소스 계약으로 차단.
  const deeplink = await readFile(new URL("../../src/lib/native-push-deeplink.ts", import.meta.url), "utf8");
  assert.doesNotMatch(deeplink, /addListener\(\s*["']appUrlOpen["']/,
    "native-push-deeplink이 appUrlOpen을 직접 등록하면 안 된다(단일 디스패쳐 경유 필수)");
  assert.match(deeplink, /subscribeAppUrlOpen/);

  const auth = await readFile(new URL("../../src/lib/capacitor/auth.ts", import.meta.url), "utf8");
  assert.doesNotMatch(auth, /App\.addListener\(\s*["']appUrlOpen["']/,
    "capacitor/auth도 단일 디스패쳐를 경유해야 한다");
  assert.match(auth, /subscribeAppUrlOpen/);
});

test("26) 디스패쳐: 네이티브 리스너 1개 + retained 이벤트를 late subscriber에 replay", async () => {
  // "retained가 첫 리스너에만 전달" 재현: 네이티브는 첫 addListener 직후 이벤트를 1회만 발행.
  const { subscribeAppUrlOpen, __resetAppUrlOpenForTest } =
    await import("../../src/lib/capacitor/app-url-open") as unknown as {
      subscribeAppUrlOpen: (s: (e: { url: string }) => void) => Promise<void>;
      __resetAppUrlOpenForTest: () => void;
    };
  __resetAppUrlOpenForTest();

  let nativeAdds = 0;
  const oauthUrl = "https://keubo.fan/auth/callback?code=RETAINED";
  // 주입 브릿지의 App 플러그인 재현 — 첫 리스너 등록 순간 retained 이벤트를 전달하고 삭제.
  (injectedCapacitor as unknown as Record<string, unknown>) = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      App: {
        addListener: async (_e: string, cb: (ev: { url: string }) => void) => {
          nativeAdds += 1;
          if (nativeAdds === 1) cb({ url: oauthUrl }); // retained — 첫 리스너에만
          return { remove: async () => undefined };
        },
      },
    },
  };

  // LA 딥링크 구독이 먼저 붙는다(문제의 cold 순서) — retained는 이 시점에 발행됨
  const laSeen: string[] = [];
  await subscribeAppUrlOpen(({ url }) => { laSeen.push(url); });
  // OAuth 구독이 늘게 붙어도 replay로 같은 이벤트를 받는다 → 로그인 보존
  const oauthSeen: string[] = [];
  await subscribeAppUrlOpen(({ url }) => { oauthSeen.push(url); });

  assert.equal(nativeAdds, 1, "네이티브 appUrlOpen 리스너는 정확히 1개");
  assert.deepEqual(laSeen, [oauthUrl]);
  assert.deepEqual(oauthSeen, [oauthUrl], "late OAuth subscriber도 retained 이벤트를 받아야 한다");
  __resetAppUrlOpenForTest();
});

test("18) background cold-start: stash는 보관만 하고 active 전에는 이동하지 않는다", async () => {
  await reset(true);
  const h = harness({ active: false, nativePending: "/games/COLDBG?tab=lineup" });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, []);
  h.activate();
  await flush();
  assert.deepEqual(navigations, ["/games/COLDBG?tab=lineup"]);
});

// ── actual defaultLoaders(#1070 재발 방지) ───────────────────────────
// 위 1~19축은 fake loader 를 주입해 소비 로직만 본다. 실제 사고는 loader 가 npm core
// (Web 구현)에 붙어 네이티브 탭 이벤트를 못 받는 자리에서 난다 — 그 경로를 직접 태운다.

test("20) actual defaultLoaders: core=web + injected iOS면 주입 브릿지 플러그인에 붙는다", async () => {
  await reset(true);
  const injectedCalls: string[] = [];
  let tapCallback: TapCallback | null = null;
  let stateCallback: StateCallback | null = null;
  // npm core 는 web 으로 오판하는 설치 앱 재현 — 주입 브릿지만이 네이티브 진실이다.
  injectedCapacitor = {
    isNativePlatform: () => false,
    getPlatform: () => "ios",
    Plugins: {
      FirebaseMessaging: {
        addListener: async (event: string, cb: TapCallback) => {
          injectedCalls.push(`messaging:${event}`);
          tapCallback = cb;
          return { remove: async () => undefined };
        },
      },
      App: {
        getState: async () => {
          injectedCalls.push("app:getState");
          return { isActive: true };
        },
        addListener: async (event: string, cb: StateCallback) => {
          injectedCalls.push(`app:${event}`);
          stateCallback = cb;
          return { remove: async () => undefined };
        },
      },
      PushDeepLink: {
        consume: async () => {
          injectedCalls.push("pushDeepLink:consume");
          return {};
        },
      },
    },
  } as unknown as typeof injectedCapacitor;

  // loaders 인자 없이 호출 = actual defaultLoaders 경로
  await (await pushModule()).listenForNotificationTap();
  await flush();

  assert.ok(injectedCalls.includes("messaging:notificationActionPerformed"),
    `주입 FirebaseMessaging 에 붙어야 함 (calls=${injectedCalls.join(",")})`);
  assert.ok(injectedCalls.includes("app:appStateChange"),
    `주입 App 에 붙어야 함 (calls=${injectedCalls.join(",")})`);
  assert.ok(injectedCalls.includes("pushDeepLink:consume"),
    `주입 PushDeepLink 를 호출해야 함 (calls=${injectedCalls.join(",")})`);

  // 주입 경로로 받은 탭이 실제 이동으로 이어진다(배선 종단 확인)
  assert.ok(tapCallback, "tap callback 이 등록되어야 함");
  (tapCallback as unknown as TapCallback)(tap("/games/INJECTED?tab=lineup"));
  await flush();
  assert.deepEqual(navigations, ["/games/INJECTED?tab=lineup"]);
  assert.ok(stateCallback, "appStateChange callback 이 등록되어야 함");
});

test("21) actual defaultLoaders: 주입 브릿지가 없으면 npm core 로 fallback한다", async () => {
  await reset(true); // injectedCapacitor = isNativePlatform:true, Plugins 없음
  // Plugins 가 없으니 injectedPlugin() 은 undefined → npm 모듈 import 경로.
  // 이 환경엔 네이티브가 없어 addListener 가 throw 할 수 있지만, attach 실패는
  // 상위 catch 로 잡혀 registration 이 초기화되어야 한다(다음 mount 재시도 가능).
  const m = await pushModule();
  await assert.doesNotReject(() => m.listenForNotificationTap());
});

test("19) 네이티브 stash는 AppDelegate가 .background launch를 제외하고 상대경로만 저장", async () => {
  const appDelegate = await readFile(new URL("../../ios/App/App/AppDelegate.swift", import.meta.url), "utf8");
  assert.match(appDelegate, /application\.applicationState != \.background/);
  assert.match(appDelegate, /launchOptions\?\[\.remoteNotification\]/);
  assert.match(appDelegate, /PushDeepLinkPlugin\.stash\(url: url\)/);

  const plugin = await readFile(new URL("../../ios/App/App/PushDeepLinkPlugin.swift", import.meta.url), "utf8");
  // 저장·회수 양쪽에서 앱 내 상대경로만 허용(외부 스킴·protocol-relative 차단)
  const guards = plugin.match(/hasPrefix\("\/"\), !url\.hasPrefix\("\/\/"\)/g) ?? [];
  assert.ok(guards.length >= 2, `stash/consume 양쪽 경로 가드 필요 (found ${guards.length})`);
  // 1회 소비 — 반환 전에 제거
  assert.match(plugin, /defaults\.removeObject\(forKey: Self\.urlKey\)/);
  assert.match(plugin, /freshnessWindowSec/);

  const mainVC = await readFile(new URL("../../ios/App/App/MainViewController.swift", import.meta.url), "utf8");
  assert.match(mainVC, /registerPluginInstance\(PushDeepLinkPlugin\(\)\)/);
});
