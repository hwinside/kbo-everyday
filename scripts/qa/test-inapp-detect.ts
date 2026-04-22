// Manual sanity check for detectInApp() against real-world UA strings.
// Run: `npx tsx scripts/qa/test-inapp-detect.mjs`
//
// Excluded from tsconfig via .mjs so prod build ignores it. We only rely on
// tsx-at-runtime to resolve the TS import; the actual TS type-check for the
// module happens in the main app build.
import { detectInApp } from "../../src/lib/detect-inapp";

/** @type {[string, string|null, 'ios'|'android'|'other'][]} */
const cases = [
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 301.0.0.0.0 (iPhone15,2; iOS 16_6; ko_KR; ko; scale=3.00; 1170x2532; 540810510) NW/3",
    "instagram",
    "ios",
  ],
  [
    "Mozilla/5.0 (Linux; Android 13; SM-S918N Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 Instagram 315.0.0.0.0 Android",
    "instagram",
    "android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 Barcelona",
    "threads",
    "ios",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.5",
    "kakaotalk",
    "ios",
  ],
  [
    "Mozilla/5.0 (Linux; Android 13; SM-S901N) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.136 Mobile Safari/537.36;KAKAOTALK 10.4.5",
    "kakaotalk",
    "android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) NAVER(inapp; search; 1000; 12.7.6)",
    "naver-app",
    "ios",
  ],
  [
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/420.0.0.30.120;]",
    "facebook",
    "android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/13.8.0",
    "line",
    "ios",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    null,
    "ios",
  ],
  [
    "Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
    null,
    "android",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    null,
    "other",
  ],
];

let pass = 0;
let fail = 0;
for (const [ua, expKind, expOs] of cases) {
  const r = detectInApp(ua);
  const ok = r.kind === expKind && r.os === expOs;
  console.log(
    `${ok ? "PASS" : "FAIL"} kind=${r.kind} os=${r.os} label=${r.label} :: ${ua.slice(0, 80)}`,
  );
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
