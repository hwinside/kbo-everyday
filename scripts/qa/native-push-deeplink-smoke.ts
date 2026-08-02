/**
 * 알림 탭 딥링크 — 앱 활성화 후 이동 계약 회귀.
 *
 * 사고(2026-08-02, 하린아빠 실기기 제보): iOS 백그라운드에서 라인업 알림을 탭하면
 * 경기 라인업이 아니라 홈이 열린다. A17(안드)은 정상 → 서버 payload·push_url·JS 핸들러
 * 계약은 모두 정상이고, 깨진 축은 "탭 이벤트가 뜨는 시점"의 플랫폼 비대칭이다.
 *   - Android: handleOnNewIntent(Intent) — 앱이 포그라운드로 올라온 뒤 JS 전달 → 즉시 이동 OK
 *   - iOS: UNUserNotificationCenter didReceive(response:) — 백그라운드→활성 전환 *중* 호출.
 *     이 시점 WKWebView 는 JS 네비게이션이 억제돼 location.href 대입이 유실된다.
 *
 * 성공기준:
 *   1. visible(=포그라운드, Android 상당)이면 즉시 이동 — 종전 동작 무회귀
 *   2. hidden(=iOS 백그라운드 탭)이면 이동하지 않고 보관만
 *   3. 이후 활성화(visibilitychange→visible)되면 보관분이 정확히 그 URL 로 이동
 *   4. 보관분은 1회만 소비 — 재활성화 때 같은 곳으로 재진입하지 않는다
 *   5. 활성화 전에 새 탭이 오면 마지막 URL 이 이긴다(오래된 딥링크로 끌려가지 않음)
 *   6. visibilitychange 가 안 오는 경로 대비 — focus / pageshow 로도 소비된다
 *
 * 실행: tsx --test scripts/qa/native-push-deeplink-smoke.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://keubo.fan/",
});

/** 현재 문서 가시성 — 테스트가 직접 제어한다. */
let visibility: "visible" | "hidden" = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  get: () => visibility,
  configurable: true,
});

/** location.href 대입을 가로채 "실제 이동한 URL" 을 기록.
 *  jsdom 의 window.location 은 [Unforgeable] 라 재정의가 막힌다 → window 를 Proxy 로 감싸
 *  location 접근만 가로채고 나머지(addEventListener 등)는 실제 jsdom 동작을 그대로 쓴다. */
const navigations: string[] = [];
const fakeLocation = {
  get href() {
    return "https://keubo.fan/";
  },
  set href(v: string) {
    navigations.push(v);
  },
  origin: "https://keubo.fan",
};

const windowProxy = new Proxy(dom.window as unknown as Record<string | symbol, unknown>, {
  get(target, prop) {
    if (prop === "location") return fakeLocation;
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
  set(target, prop, value) {
    if (prop === "location") {
      fakeLocation.href = String(value);
      return true;
    }
    return Reflect.set(target, prop, value);
  },
});

const globals = globalThis as Record<string, unknown>;
globals.window = windowProxy;
globals.document = dom.window.document;

// 모듈은 window/document 를 세팅한 뒤에 로드해야 한다(모듈 스코프 보관 변수 초기화 시점).
// top-level await 는 이 러너의 cjs 출력에서 못 쓰므로 지연 로드한다.
type PushModule = {
  navigateOnAppActive: (url: string) => void;
  handleNotificationTapEvent: (event: unknown) => void;
  registerNotificationTapListener: (messaging: {
    addListener: (event: "notificationActionPerformed", cb: (event: unknown) => void) => Promise<unknown>;
  }) => Promise<void>;
  __resetPendingTapForTest: () => void;
};
let cached: PushModule | null = null;
async function loadModule(): Promise<PushModule> {
  if (!cached) cached = (await import("../../src/lib/native-push-deeplink")) as unknown as PushModule;
  return cached;
}

async function reset(state: "visible" | "hidden"): Promise<PushModule> {
  const m = await loadModule();
  navigations.length = 0;
  visibility = state;
  m.__resetPendingTapForTest();
  return m;
}

function activate(via: "visibilitychange" | "focus" | "pageshow") {
  visibility = "visible";
  if (via === "visibilitychange") {
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  } else {
    dom.window.dispatchEvent(new dom.window.Event(via));
  }
}

test("1) 포그라운드(visible) 탭은 즉시 이동 — Android 무회귀", async () => {
  const { navigateOnAppActive } = await reset("visible");
  navigateOnAppActive("/games/20260802HHKT0?tab=lineup");
  assert.deepEqual(navigations, ["/games/20260802HHKT0?tab=lineup"]);
});

test("2) 백그라운드(hidden) 탭은 이동하지 않고 보관 — iOS 사고 재현 지점", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/20260802HHKT0?tab=lineup");
  assert.deepEqual(navigations, [], "활성화 전에는 이동하면 안 된다(유실 구간)");
});

test("3) 활성화되면 보관분이 그 URL 로 정확히 이동", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/20260802HHKT0?tab=lineup");
  assert.deepEqual(navigations, []);
  activate("visibilitychange");
  assert.deepEqual(
    navigations,
    ["/games/20260802HHKT0?tab=lineup"],
    "홈이 아니라 알림이 가리킨 경로로 가야 한다",
  );
});

test("4) 보관분은 1회만 소비 — 재활성화 때 재진입 없음", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/20260802HHKT0?tab=lineup");
  activate("visibilitychange");
  assert.equal(navigations.length, 1);

  // 유저가 다른 화면으로 갔다가 앱을 다시 열어도 옛 딥링크로 끌려가면 안 된다.
  visibility = "hidden";
  activate("visibilitychange");
  assert.equal(navigations.length, 1, "이미 소비한 딥링크가 다시 발동하면 안 된다");
});

test("5) 활성화 전 새 탭이 오면 마지막 URL 이 이긴다", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/OLD0?tab=lineup");
  navigateOnAppActive("/games/NEW0?tab=lineup");
  activate("visibilitychange");
  assert.deepEqual(
    navigations,
    ["/games/NEW0?tab=lineup"],
    "방금 탭한 알림이 아니라 이전 알림으로 가면 오동작",
  );
});

test("6) focus 로도 소비된다(visibilitychange 미발생 경로 대비)", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/20260802SSLT0?tab=lineup");
  activate("focus");
  assert.deepEqual(navigations, ["/games/20260802SSLT0?tab=lineup"]);
});

test("7) pageshow 로도 소비된다(bfcache 복원 경로)", async () => {
  const { navigateOnAppActive } = await reset("hidden");
  navigateOnAppActive("/games/20260802LGOB0?tab=lineup");
  activate("pageshow");
  assert.deepEqual(navigations, ["/games/20260802LGOB0?tab=lineup"]);
});

// ── 실배선: 플러그인이 주는 실제 이벤트 모양을 그대로 핸들러에 통과시켜 검증 ────────
// (소스 문자열 검사가 아니라 실행 경로 그대로. 문자열 검사만 두면 구현을 되돌렸을 때
//  "이동이 실제로 어떻게 일어나는가"를 증명하지 못해 false-green 이 된다.)
const tapEvent = (url: unknown) => ({ notification: { data: url === undefined ? {} : { url } } });

test("8) 실배선 — 백그라운드 탭 이벤트는 즉시 이동하지 않고 활성화 후 그 경로로 간다", async () => {
  const { handleNotificationTapEvent } = await reset("hidden");
  handleNotificationTapEvent(tapEvent("/games/20260802HHKT0?tab=lineup"));
  assert.deepEqual(navigations, [], "iOS 사고 구간 — 전환 중 이동하면 유실된다");
  activate("visibilitychange");
  assert.deepEqual(navigations, ["/games/20260802HHKT0?tab=lineup"], "홈이 아니라 라인업으로");
});

test("9) 실배선 — 포그라운드 탭 이벤트는 즉시 이동(Android 무회귀)", async () => {
  const { handleNotificationTapEvent } = await reset("visible");
  handleNotificationTapEvent(tapEvent("/games/20260802SSLT0?tab=lineup"));
  assert.deepEqual(navigations, ["/games/20260802SSLT0?tab=lineup"]);
});

test("10) 실배선 — 외부/비정상 URL 은 이동하지 않는다(기존 계약 유지)", async () => {
  const { handleNotificationTapEvent } = await reset("visible");
  handleNotificationTapEvent(tapEvent("https://evil.example/pwn"));
  handleNotificationTapEvent(tapEvent("//evil.example/pwn"));
  handleNotificationTapEvent(tapEvent("/\\evil.example/pwn"));
  handleNotificationTapEvent(tapEvent(""));
  handleNotificationTapEvent(tapEvent(undefined));
  handleNotificationTapEvent(tapEvent(123));
  handleNotificationTapEvent(null);
  assert.deepEqual(navigations, [], "내부 경로(`/`) 이외엔 절대 이동하지 않는다");
});

// ── 실배선(actual): 등록 함수를 *실제로 호출*해 등록된 콜백을 붙잡아 검증 ──────────
// 앞서 공용 핸들러를 직접 부르는 테스트만 두었더니, 리스너를 사고 이전 코드로 되돌려도
// 그 테스트들이 그대로 통과했다(false-green). 그래서 플러그인을 스텁해 "리스너가 실제로 무엇을
// 등록하고, 그게 백그라운드에서 어떻게 동작하는지"를 실행 경로 그대로 고정한다.
type TapListener = (event: unknown) => void;
let capturedTapListener: TapListener | null = null;

async function registerActualListener(): Promise<void> {
  capturedTapListener = null;
  const { registerNotificationTapListener } = await loadModule();
  await registerNotificationTapListener({
    addListener: async (event, cb) => {
      if (event === "notificationActionPerformed") capturedTapListener = cb;
    },
  });
}

test("11) 실배선(actual) — 등록된 탭 리스너가 백그라운드에서 즉시 이동하지 않는다", async () => {
  await registerActualListener();
  assert.ok(capturedTapListener, "notificationActionPerformed 리스너가 등록되어야 한다");

  await reset("hidden");
  capturedTapListener!(tapEvent("/games/20260802HHKT0?tab=lineup"));
  assert.deepEqual(
    navigations,
    [],
    "iOS 사고 구간 — 전환 중 location.href 를 걸면 유실되고 홈에 머무른다",
  );

  activate("visibilitychange");
  assert.deepEqual(
    navigations,
    ["/games/20260802HHKT0?tab=lineup"],
    "활성화 된 뒤 알림이 가리킨 라인업으로 가야 한다",
  );
});

test("12) 실배선(actual) — 등록된 탭 리스너는 포그라운드에선 즉시 이동(Android 무회귀)", async () => {
  await registerActualListener();
  assert.ok(capturedTapListener);

  await reset("visible");
  capturedTapListener!(tapEvent("/games/20260802SSLT0?tab=lineup"));
  assert.deepEqual(navigations, ["/games/20260802SSLT0?tab=lineup"]);
});

test("13) native-push 실제 진입점이 공용 등록 함수에 결속돼 있다", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../src/lib/native-push.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /registerNotificationTapListener\(FirebaseMessaging\)/);
  assert.doesNotMatch(
    source,
    /notificationActionPerformed[\s\S]{0,300}window\.location\.href/,
    "실제 진입점이 전환 중 즉시 이동 코드로 되돌아가면 안 된다",
  );
});
