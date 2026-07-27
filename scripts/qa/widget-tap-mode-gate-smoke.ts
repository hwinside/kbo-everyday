/**
 * 위젯 탭 동작 모드 — *실제 exported* getWidgetTapMode/setWidgetTapMode 라우팅 회귀 스모크.
 * 실행: npm run qa:widget-tap-mode
 * 배경: 삼순 #904 왕복2 ③ — 기존 스모크는 routeTapMode *복제* 함수만 검사해, 실제
 *   game-notification.ts의 get/setWidgetTapMode가 삭제/오배선돼도 통과했다(회귀 사각).
 *   이제 실제 exported 함수를 호출하고 window.Capacitor.Plugins(LiveActivity=iOS /
 *   GameNotification=안드) 주입 stub으로 원격 로드 dual-instance(core=web + injected native)
 *   fallback 라우팅을 고정한다:
 *     (a) core proxy throw → injected iOS plugin get/set 성공 경로
 *     (b) core throw → injected Android plugin 성공 경로
 *     (c) 양쪽 실패 → get={open,false}, set=false (fail-closed)
 *   (window.Capacitor 주입 stub 패턴은 venue-native-gate-smoke 미러.)
 */

// game-notification → supabase/client 가 import 시 env 를 읽으므로 더미 주입(모듈 로드 크래시 방지).
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key";

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

// node 환경 npm core 는 항상 web → 주입 브릿지(window.Capacitor)만 시뮬해 원격 로드
// dual-instance(core=web + injected native)를 재현한다. Plugins 에 네이티브 stub 을 심어
// core registerPlugin proxy 가 (web 미구현으로) throw 한 뒤의 주입 폴백 경로를 검증한다.
interface InjectedCap {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}
async function withInjected(cap: InjectedCap | undefined, fn: () => Promise<void>) {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  const had = "window" in g;
  g.window = { Capacitor: cap };
  try {
    await fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

async function main() {
  // 실제 exported 함수 — 복제가 아니라 이걸 직접 호출한다(삼순 ③).
  const { getWidgetTapMode, setWidgetTapMode } = await import(
    "../../src/lib/capacitor/game-notification"
  );

  console.log("[widget-tap-mode 실함수 라우팅 게이트 — 원격 로드 dual-instance (삼순 #904 왕복2 ③)]");

  // (a) core proxy throw → injected iOS(LiveActivity) get/set 성공 경로
  const iosCalls: string[] = [];
  await withInjected(
    {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: {
        LiveActivity: {
          getWidgetTapMode: async () => ({ mode: "refresh", refreshSupported: true, reason: "none" }),
          setWidgetTapMode: async (o: { mode: string }) => { iosCalls.push(o.mode); },
        },
      },
    },
    async () => {
      const s = await getWidgetTapMode();
      ok("(a) iOS injected get → mode=refresh, refreshSupported=true, reason=none",
        s.mode === "refresh" && s.refreshSupported === true && s.reason === "none");
      const setOk = await setWidgetTapMode("refresh");
      ok("(a) iOS injected set → true & LiveActivity.setWidgetTapMode('refresh') 호출",
        setOk === true && iosCalls.length === 1 && iosCalls[0] === "refresh");
    },
  );

  // (b) core throw → injected Android(GameNotification) 성공 경로
  const andCalls: string[] = [];
  await withInjected(
    {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: {
        GameNotification: {
          getWidgetTapMode: async () => ({ mode: "refresh", refreshSupported: true }),
          setWidgetTapMode: async (o: { mode: string }) => { andCalls.push(o.mode); },
        },
      },
    },
    async () => {
      const s = await getWidgetTapMode();
      ok("(b) Android injected get → mode=refresh, refreshSupported=true, reason=none",
        s.mode === "refresh" && s.refreshSupported === true && s.reason === "none");
      const setOk = await setWidgetTapMode("open");
      ok("(b) Android injected set → true & GameNotification.setWidgetTapMode('open') 호출",
        setOk === true && andCalls.length === 1 && andCalls[0] === "open");
    },
  );

  // (c) 양쪽 실패 — iOS 네이티브지만 주입 플러그인 부재 → fail-closed
  await withInjected(
    { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: {} },
    async () => {
      const s = await getWidgetTapMode();
      ok("(c) iOS core+injected 모두 실패 → open/false/app_update(fail-closed)",
        s.mode === "open" && s.refreshSupported === false && s.reason === "app_update");
      const setOk = await setWidgetTapMode("refresh");
      ok("(c) iOS set 모두 실패 → false", setOk === false);
    },
  );

  // (c') Android 네이티브지만 주입 플러그인 부재 → fail-closed(구빌드 = 앱 업데이트 사유)
  await withInjected(
    { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} },
    async () => {
      const s = await getWidgetTapMode();
      ok("(c') Android core+injected 모두 실패 → open/false/app_update(fail-closed)",
        s.mode === "open" && s.refreshSupported === false && s.reason === "app_update");
      const setOk = await setWidgetTapMode("refresh");
      ok("(c') Android set 모두 실패 → false", setOk === false);
    },
  );

  // (d) 순수 web(주입 없음) → 카드 숨김 경로: get open/false/none, set no-op(false)
  await withInjected(undefined, async () => {
    const s = await getWidgetTapMode();
    ok("(d) 순수 web → open/false/none(카드 숨김)",
      s.mode === "open" && s.refreshSupported === false && s.reason === "none");
    const setOk = await setWidgetTapMode("refresh");
    ok("(d) web set → false(no-op)", setOk === false);
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

void main();
