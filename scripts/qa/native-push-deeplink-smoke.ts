/** iOS/Android 알림 탭 → 앱 상태 기반 딥링크 actual 배선 회귀. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://keubo.fan/",
});

const navigations: string[] = [];
const fakeLocation = {
  get href() { return "https://keubo.fan/"; },
  set href(value: string) { navigations.push(value); },
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
type Loaders = Parameters<PushModule["listenForNotificationTap"]>[0];
type PushModule = {
  listenForNotificationTap: (loaders?: {
    messaging: () => Promise<{
      addListener: (event: "notificationActionPerformed", callback: TapCallback) => Promise<{ remove: () => Promise<void> }>;
    }>;
    app: () => Promise<{
      getState: () => Promise<{ isActive: boolean }>;
      addListener: (event: "appStateChange", callback: StateCallback) => Promise<{ remove: () => Promise<void> }>;
    }>;
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

function harness(options?: { active?: boolean; retained?: unknown }) {
  let active = options?.active ?? false;
  let tapCallback: TapCallback | null = null;
  let stateCallback: StateCallback | null = null;
  let messagingAdds = 0;
  let appAdds = 0;
  const loaders: NonNullable<Loaders> = {
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
  };
  return {
    loaders,
    tap: (event: unknown) => tapCallback?.(event),
    activate: () => { active = true; stateCallback?.({ isActive: true }); },
    counts: () => ({ messagingAdds, appAdds }),
  };
}

async function reset(native = true, clearPending = true) {
  injectedCapacitor = native
    ? { isNativePlatform: () => true, getPlatform: () => "ios" }
    : undefined;
  navigations.length = 0;
  (await pushModule()).__resetNotificationTapForTest(clearPending);
}

test("1) remote-load: npm core가 web이어도 주입 bridge iOS면 실제 listener를 붙인다", async () => {
  await reset(true);
  const h = harness({ active: false });
  await (await pushModule()).listenForNotificationTap(h.loaders);
  assert.deepEqual(h.counts(), { messagingAdds: 1, appAdds: 1 });
});

test("2) web에서는 native loader/listener를 호출하지 않는다", async () => {
  await reset(false);
  const h = harness();
  await (await pushModule()).listenForNotificationTap(h.loaders);
  assert.deepEqual(h.counts(), { messagingAdds: 0, appAdds: 0 });
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
  assert.deepEqual(h.counts(), { messagingAdds: 1, appAdds: 1 });
});

test("12) actual mount가 정적 gate 전에 딥링크 listener를 호출", async () => {
  const source = await readFile(new URL("../../src/components/NativePushMount.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ listenForNotificationTap \} from "@\/lib\/native-push-deeplink"/);
  const call = source.indexOf("void listenForNotificationTap();");
  const gate = source.indexOf("if (!isNativeRuntime()) return;");
  assert.ok(call >= 0 && gate >= 0 && call < gate, "mount 호출 제거·정적 gate 뒤 이동을 차단");
  assert.doesNotMatch(source, /if \(!isNative\) return/);
});
