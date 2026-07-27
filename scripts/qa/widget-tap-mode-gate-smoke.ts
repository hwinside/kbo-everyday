/**
 * 위젯 탭 동작 모드 — get/setWidgetTapMode 네이티브 라우팅 게이트 회귀 스모크.
 * 실행: npm run qa:widget-tap-mode
 * 배경: 삼순 #904 blocker② — 원격 로드(server.url=keubo.fan) 설치 앱은 npm core 정적
 *   isNative/isIOS/isAndroid가 'web' false-negative 되어(PR #484/#833 운영 사고) 위젯 탭
 *   모드 카드가 숨거나 get/set이 no-op 된다. get/setWidgetTapMode는 정적 분기 대신
 *   isIosNativeRuntime()(→iOS LiveActivity) / isNativeRuntime()(→안드 GameNotification) /
 *   둘 다 false(→web fail-closed no-op) 로 라우팅한다. 이 스모크는 그 라우팅 판정을
 *   dual-instance(core=web + window.Capacitor 주입=native) 매트릭스로 고정한다.
 */
import { isNativeRuntime, isIosNativeRuntime } from "../../src/lib/capacitor/platform";

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

// node 환경 npm core는 항상 web → 주입 브릿지(window.Capacitor)만 시뮬해 원격 로드
// dual-instance(core=web + injected native)를 재현한다(venue-native-gate-smoke 미러).
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

// get/setWidgetTapMode의 실제 라우팅 결정을 재현하는 순수 판정:
//   iOS 네이티브        → "ios"     (getIosWidgetTapMode / setIosWidgetTapMode)
//   iOS 아닌 네이티브   → "android" (GameNotification.get/setWidgetTapMode)
//   비네이티브(web)     → "web"     (fail-closed: open + refreshSupported:false, set no-op)
function routeTapMode(): "ios" | "android" | "web" {
  if (isIosNativeRuntime()) return "ios";
  if (isNativeRuntime()) return "android";
  return "web";
}

console.log("[widget-tap-mode 라우팅 게이트 — 원격 로드 dual-instance (삼순 #904 blocker②)]");

// 순수 web/PWA: 주입 없음 → web fail-closed(카드 숨김 + get open/false, set no-op)
withInjected(undefined, () => {
  ok("순수 web(주입 없음) → web (fail-closed no-op)", routeTapMode() === "web");
});
withInjected({}, () => {
  ok("브릿지 존재하나 메서드 없음 → web", routeTapMode() === "web");
});
withInjected({ getPlatform: () => "web", isNativePlatform: () => false }, () => {
  ok("브릿지 web 판정 → web", routeTapMode() === "web");
});

// 원격 로드 iOS 설치 앱: core=web false-negative여도 주입 브릿지로 iOS 라우팅
withInjected({ isNativePlatform: () => true, getPlatform: () => "ios" }, () => {
  ok("core=web + injected ios → ios (LiveActivity 라우팅)", routeTapMode() === "ios");
});
withInjected({ getPlatform: () => "ios" }, () => {
  ok("injected getPlatform()=ios (isNativePlatform 부재) → ios", routeTapMode() === "ios");
});

// 원격 로드 안드 설치 앱: iOS 아님 + 네이티브 → android(GameNotification)
withInjected({ isNativePlatform: () => true, getPlatform: () => "android" }, () => {
  ok("core=web + injected android → android (GameNotification 라우팅)", routeTapMode() === "android");
});
withInjected({ getPlatform: () => "android" }, () => {
  ok("injected getPlatform()=android → android", routeTapMode() === "android");
});

// bridge 접근 throw → web fail-closed(정적/주입 모두 실패해도 앱을 열지 no-op)
withInjected(
  {
    isNativePlatform: () => {
      throw new Error("bridge boom");
    },
    getPlatform: () => {
      throw new Error("bridge boom");
    },
  },
  () => {
    ok("bridge 메서드 throw → web (fail-closed)", routeTapMode() === "web");
  },
);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
