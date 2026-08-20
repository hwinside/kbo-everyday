/**
 * 직관 스토리 뷰어 safe-area-inset-top 분기 — isIosNativeRuntime() 회귀 스모크.
 * 실행: npm run qa:venue-safe-area
 * 배경: 삼순 #843 NO-GO — `max(env(safe-area-inset-top,0px),44px)` 를 전 플랫폼에 강제하면
 *   Android·웹/PWA 뷰어에도 44px 가 강제돼 회귀. 원래 문제는 iOS 원격로드 WKWebView 에서만
 *   env(safe-area-inset-top) 이 0 으로 깨지는 케이스. iOS 네이티브 런타임에서만 44px 폴백을 건다.
 *   원격 로드 설치 앱은 npm core 가 'web' false-negative(PR #484/#833) 되므로 주입 브릿지까지 본다.
 */
import { isIosNativeRuntime } from "../../src/lib/capacitor/platform";

// VenueStoryViewer 와 동일한 분기식 (SSOT 복제 — 뷰어 인라인 로직 회귀 감지용)
// #1264: Android 네이티브가 주입하는 --safe-area-inset-* 변수를 1순위로 소비하고
// (Capacitor 8 SystemBars, API 35+), 미주입 플랫폼(iOS·웹)은 env()로 폴백하는 단일 계약.
function safeAreaInsetTop(): string {
  return isIosNativeRuntime()
    ? "max(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)), 44px)"
    : "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
}

const FALLBACK = "max(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)), 44px)";
const PURE = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
}

function withInjected(cap: unknown, fn: () => void) {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  const had = "window" in g;
  g.window = { Capacitor: cap };
  try {
    fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

console.log("[safe-area-inset-top 분기 — iOS 네이티브만 44px 폴백 (삼순 #843)]");

// iOS 원격로드 설치 앱: core=web false-negative 여도 주입 브릿지 ios → 44px 폴백 보장
withInjected({ getPlatform: () => "ios" }, () => {
  ok("iOS 원격로드(injected getPlatform()=ios) → 44px 폴백", safeAreaInsetTop() === FALLBACK);
});
withInjected({ isNativePlatform: () => true, getPlatform: () => "ios" }, () => {
  ok("iOS 네이티브(injected ios) → 44px 폴백", safeAreaInsetTop() === FALLBACK);
});

// Android 네이티브: env 순수값 유지(무변경 — NO-GO 회귀 방지)
withInjected({ isNativePlatform: () => true, getPlatform: () => "android" }, () => {
  ok("Android 네이티브 → env 순수값(44px 강제 안 함)", safeAreaInsetTop() === PURE);
});

// 웹/PWA: 주입 브릿지 없음 → env 순수값 유지(무변경)
withInjected(undefined, () => {
  ok("순수 web(주입 없음) → env 순수값", safeAreaInsetTop() === PURE);
});
withInjected({ getPlatform: () => "web", isNativePlatform: () => false }, () => {
  ok("web 브릿지 판정 → env 순수값", safeAreaInsetTop() === PURE);
});
// 브릿지 throw → non-iOS fail-closed(env 순수값)
withInjected(
  { get getPlatform(): never { throw new Error("bridge throw"); } },
  () => {
    ok("브릿지 throw → env 순수값(fail-closed)", safeAreaInsetTop() === PURE);
  },
);

console.log(`\n결과: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
