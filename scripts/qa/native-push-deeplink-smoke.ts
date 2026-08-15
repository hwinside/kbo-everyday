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
  let messagingAdds = 0;
  let appAdds = 0;
  let nativeConsumes = 0;
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
        stateCallback = callback;
        return { remove: async () => undefined };
      },
    }),
    pushDeepLink: async () => {
      if (options?.nativeMissing) throw new Error("PushDeepLink does not have an implementation");
      return {
        consume: async () => {
          nativeConsumes += 1;
          return options?.nativePending !== undefined ? { url: options.nativePending } : {};
        },
      };
    },
  };
  return {
    loaders,
    tap: (event: unknown) => tapCallback?.(event),
    activate: () => { active = true; stateCallback?.({ isActive: true }); },
    counts: () => ({ messagingAdds, appAdds, nativeConsumes }),
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
});

test("12) actual mount가 정적 gate 전에 딥링크 listener를 호출", async () => {
  const source = await readFile(new URL("../../src/components/NativePushMount.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ listenForNotificationTap \} from "@\/lib\/native-push-deeplink"/);
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

test("18) background cold-start: stash는 보관만 하고 active 전에는 이동하지 않는다", async () => {
  await reset(true);
  const h = harness({ active: false, nativePending: "/games/COLDBG?tab=lineup" });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  await flush();
  assert.deepEqual(navigations, []);
  h.activate();
  assert.deepEqual(navigations, ["/games/COLDBG?tab=lineup"]);
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
