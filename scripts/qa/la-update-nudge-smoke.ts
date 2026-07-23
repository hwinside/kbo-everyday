// ② 구버전 업데이트 넛지 판정 스모크 — npm run qa:la-nudge
import {
  shouldShowLaUpdateNudge,
  LA_CHANNEL_MIN_APP_BUILD,
} from "../../src/lib/notifications/la-nudge-policy";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
  }
}

check("게이트 상수: 채널 최소 빌드 = 16 (p2sChannelEligible과 동일)", LA_CHANNEL_MIN_APP_BUILD, 16);

const base = { platform: "ios", appBuild: 15, isLive: true, dismissed: false };
check("타깃: iOS build15 라이브 → 노출", shouldShowLaUpdateNudge(base), true);
check("build14도 노출", shouldShowLaUpdateNudge({ ...base, appBuild: 14 }), true);
check("build16(채널 지원) → 미노출", shouldShowLaUpdateNudge({ ...base, appBuild: 16 }), false);
check("build17+ → 미노출", shouldShowLaUpdateNudge({ ...base, appBuild: 18 }), false);
check("appBuild null(미보고/웹) → 미노출(보수적)", shouldShowLaUpdateNudge({ ...base, appBuild: null }), false);
check("Android → 미노출", shouldShowLaUpdateNudge({ ...base, platform: "android" }), false);
check("웹(platform 'web') → 미노출", shouldShowLaUpdateNudge({ ...base, platform: "web" }), false);
check("platform null → 미노출", shouldShowLaUpdateNudge({ ...base, platform: null }), false);
check("비라이브 → 미노출", shouldShowLaUpdateNudge({ ...base, isLive: false }), false);
check("dismiss 후 → 미노출(세션당 1회)", shouldShowLaUpdateNudge({ ...base, dismissed: true }), false);

// ── 컴포넌트 레벨 회귀 (jsdom + react-dom, 삼순 NO-GO 2026-07-23) ──
// 재현 조건 동일: iOS 브릿지(build15) 주입 → 라이브에서 배너 노출 후 isLive=false
// (live→final/취소) 전환 시 배너가 *즉시 0건*이어야 한다. 종전에는 effect early
// return으로 배너가 잔존(1→1)했던 계약 위반 회귀.
import { JSDOM } from "jsdom";

async function componentRegression() {
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="root"></div></body>`, { url: "https://keubo.fan/" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.sessionStorage = dom.window.sessionStorage;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.HTMLIFrameElement = dom.window.HTMLIFrameElement;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // 삼순 재현과 동일한 주입 브릿지: iOS + build15(채널 미지원 구버전).
  (dom.window as unknown as Record<string, unknown>).Capacitor = {
    getPlatform: () => "ios",
    Plugins: { App: { getInfo: async () => ({ build: "15" }) } },
  };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: LiveActivityUpdateNudge } = await import("../../src/components/game/LiveActivityUpdateNudge");

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const banner = () => container.querySelectorAll("[aria-label='\ub2eb\uae30']").length;

  await act(async () => {
    root.render(React.createElement(LiveActivityUpdateNudge, { isLive: true }));
  });
  await act(async () => {}); // 브릿지 getInfo 비동기 flush
  check("[컴포넌트] 라이브 + iOS build15 → 배너 1건", banner(), 1);

  const btn = container.querySelector("[aria-label='\ub2eb\uae30']") as HTMLElement;
  check("[컴포넌트] 닫기 버튼 hit target 44px 클래스(h-11/w-11)",
    btn.className.includes("h-11") && btn.className.includes("w-11"), true);

  // 핵심 회귀: live → final/취소 전환 시 즉시 숨김(잔존 1→1 금지).
  await act(async () => {
    root.render(React.createElement(LiveActivityUpdateNudge, { isLive: false }));
  });
  check("[컴포넌트] live→final 전환 → 배너 즉시 0건(잔존 금지)", banner(), 0);

  // 재라이브(데이터 글리치 등) 시 재판정 경로도 생존 — dismiss 전이라 다시 노출.
  await act(async () => {
    root.render(React.createElement(LiveActivityUpdateNudge, { isLive: true }));
  });
  await act(async () => {});
  check("[컴포넌트] 재라이브 → 재판정도 동작(배너 1건)", banner(), 1);

  // dismiss 후 세션내 재노출 없음(기존 계약 보존).
  await act(async () => {
    (container.querySelector("[aria-label='\ub2eb\uae30']") as HTMLElement).click();
  });
  check("[컴포넌트] dismiss → 즉시 0건", banner(), 0);
  await act(async () => {
    root.render(React.createElement(LiveActivityUpdateNudge, { isLive: false }));
  });
  await act(async () => {
    root.render(React.createElement(LiveActivityUpdateNudge, { isLive: true }));
  });
  await act(async () => {});
  check("[컴포넌트] dismiss 후 재라이브 → 세션당 1회 유지(0건)", banner(), 0);

  await act(async () => root.unmount());
}

// tsx가 이 파일을 CJS로 변환해 top-level await 불가 — promise 체인으로 마무리.
componentRegression()
  .then(() => {
    console.log(`\nla-update-nudge-smoke: ${pass} PASS / ${fail} FAIL`);
    if (fail > 0) process.exit(1);
  })
  .catch((e) => {
    console.error("component regression threw:", e);
    process.exit(1);
  });
