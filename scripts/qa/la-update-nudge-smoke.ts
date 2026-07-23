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

console.log(`\nla-update-nudge-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
