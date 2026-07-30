/**
 * 7/30 장애 안내 배너 렌더 회귀 — 종료시각(2026-07-30 23:30 KST) 전 노출 / 후 미노출
 * + 동일 mount에서 23:29→23:30 시각 전진 시 자동 소멸(삼순 1차 리뷰 P1).
 * 실행: npm run qa:outage-banner
 */
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OutageNoticeBanner from "../../src/components/home/OutageNoticeBanner";

const NOTICE_END_MS = new Date("2026-07-30T23:30:00+09:00").getTime();
const realNow = Date.now;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

function renderAt(nowMs: number): string {
  Date.now = () => nowMs;
  try {
    return renderToStaticMarkup(React.createElement(OutageNoticeBanner));
  } finally {
    Date.now = realNow;
  }
}

// 종료시각 1분 전 — 노출 + 문안 포함(삼순 버전)
const before = renderAt(NOTICE_END_MS - 60_000);
ok("종료시각 전: 배너 노출", before.length > 0);
ok(
  "종료시각 전: 문안 포함(삼순 버전)",
  before.includes("서비스 이용에 불편을 드려 죄송합니다") &&
    before.includes("19:45부터 정상화되었습니다") &&
    before.includes("운영과 모니터링을 더욱 철저히 하겠습니다"),
);

// 종료시각 정각/이후 — 미노출
ok("종료시각 정각: 미노출", renderAt(NOTICE_END_MS) === "");
ok("종료시각 1분 후: 미노출", renderAt(NOTICE_END_MS + 60_000) === "");

// 동일 mount 자동 소멸 — 23:29에 mount된 채로 23:30 전진 시 timer가 DOM을 직접 숨김
// (jsdom + react-dom/client 실제 mount, fake timer로 소멸 콜백 캡처 후 시간 전진 실행, remount 없음)
async function sameMountAutoHide() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  (global as Record<string, unknown>).window = dom.window;
  (global as Record<string, unknown>).document = dom.window.document;
  (global as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");

  const realSetTimeout = global.setTimeout;
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  let nowMs = NOTICE_END_MS - 60_000; // 23:29
  Date.now = () => nowMs;
  // @ts-expect-error fake timer (컴포넌트의 소멸 타이머 캡처)
  global.setTimeout = (cb: () => void, ms: number) => {
    scheduled.push({ cb, ms });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  try {
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(OutageNoticeBanner));
    });
    ok("동일 mount: 23:29 노출", container.innerHTML.includes("서비스 이용 안내"));
    const disposal = scheduled.filter((s) => Math.abs(s.ms - 60_000) < 1_500);
    ok("동일 mount: 잔여시간 소멸 timer 예약됨", disposal.length === 1);
    // 시간을 23:30 이후로 전진시키고 예약된 소멸 콜백 실행 (remount 없이)
    nowMs = NOTICE_END_MS + 1_000;
    await act(async () => {
      disposal.forEach((s) => s.cb());
    });
    ok("동일 mount: 23:30 전진 시 자동 소멸(remount 없음)", container.innerHTML === "");
    await act(async () => {
      root.unmount();
    });
  } finally {
    global.setTimeout = realSetTimeout;
    Date.now = realNow;
  }
}

sameMountAutoHide().then(() => {
  console.log(`\noutage-notice-banner-smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
