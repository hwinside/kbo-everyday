/**
 * 7/30 장애 안내 배너 렌더 회귀 — 종료시각(2026-07-30 23:30 KST) 전 노출 / 후 미노출.
 * 실행: npm run qa:outage-banner
 */
import React from "react";
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

// 종료시각 1분 전 — 노출 + 문안 포함
const before = renderAt(NOTICE_END_MS - 60_000);
ok("종료시각 전: 배너 노출", before.length > 0);
ok("종료시각 전: 문안 포함", before.includes("19:45부터 정상화되었습니다"));

// 종료시각 정각/이후 — 미노출
ok("종료시각 정각: 미노출", renderAt(NOTICE_END_MS) === "");
ok("종료시각 1분 후: 미노출", renderAt(NOTICE_END_MS + 60_000) === "");

console.log(`\noutage-notice-banner-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
