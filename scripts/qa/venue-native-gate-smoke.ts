/**
 * 직관 라이브 업로드 앱 전용 게이트 — isNativeRuntime() 회귀 스모크.
 * 실행: npm run qa:venue-native-gate
 * 배경: 삼순 #833 blocker — 정적 isNative(npm core 모듈 로드 시 1회 저장)는 원격 로드
 *   (server.url=keubo.fan) 설치 앱에서 'web' false-negative 되는 운영 사고(PR #484)가 있었다.
 *   window.Capacitor 주입 브릿지를 OR로 확인해야 설치 앱이 앱 전용 게이트에 막히지 않는다.
 */
import { isNativeRuntime } from "../../src/lib/capacitor/platform";

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

// node 환경에서 npm core는 항상 web(false/'web') → 주입 브릿지(window.Capacitor)만 시뮬한다.
// 이는 원격 로드 앱의 dual-instance(core=web + injected native) 상황을 그대로 재현한다.
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

console.log("[isNativeRuntime — 원격 로드 앱 false-negative 방어 (삼순 #833)]");

// 순수 web/PWA: 주입 브릿지 없음 → 차단(false)
withInjected(undefined, () => {
  ok("순수 web(주입 없음) → false(웹 업로드 차단)", isNativeRuntime() === false);
});
withInjected({}, () => {
  ok("브릿지 존재하나 메서드 없음 → false", isNativeRuntime() === false);
});
withInjected({ getPlatform: () => "web", isNativePlatform: () => false }, () => {
  ok("브릿지 web 판정 → false", isNativeRuntime() === false);
});

// 원격 로드 설치 앱: core=web false-negative여도 주입 브릿지로 허용(true)
withInjected({ isNativePlatform: () => true, getPlatform: () => "ios" }, () => {
  ok("core=web + injected isNativePlatform()=true → true(허용)", isNativeRuntime() === true);
});
withInjected({ getPlatform: () => "ios" }, () => {
  ok("injected getPlatform()=ios(isNativePlatform 부재) → true", isNativeRuntime() === true);
});
withInjected({ getPlatform: () => "android" }, () => {
  ok("injected getPlatform()=android → true", isNativeRuntime() === true);
});

// bridge 접근 throw → web fail-closed(false)
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
    ok("bridge 메서드 throw → false(web fail-closed)", isNativeRuntime() === false);
  },
);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
