/**
 * 직관 라이브 공개 롤아웃 회귀 — AdminOnly 게이트 해제 + 불변 조건 봉인 스모크.
 * 실행: npm run qa:venue-public-rollout
 * 배경: iOS 1.0.11 심사 릴리즈와 함께 직관 라이브를 전체 로그인 유저에게 오픈.
 *  - 게이트 해제: 트레이가 AdminOnly 로 다시 감싸지면 실패 (일반유저 노출 회귀)
 *  - 불변 조건: 일반유저 GPS 지오펜스(클라+서버 fail-closed)·구버전 앱 업데이트 안내는 유지
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const page = readFileSync("src/app/(main)/games/[gameId]/page.tsx", "utf8");
const geo = readFileSync("src/lib/venue-stories/geo.ts", "utf8");
const composer = readFileSync("src/components/game/VenueStoryComposer.tsx", "utf8");
const route = readFileSync("src/app/api/venue-stories/route.ts", "utf8");

console.log("[게이트 해제 — 일반유저 트레이 노출]");
ok(
  "게임 페이지가 VenueStorySection 을 렌더",
  /<VenueStorySection\s+gameId=\{gameId\}\s*\/>/.test(page),
);
ok(
  "게임 페이지에 AdminOnly 게이트 없음 (재도입 시 실패)",
  !/AdminOnly/.test(page),
  "AdminOnly 참조 검출",
);

console.log("[불변 조건 — 구버전 앱(위치 플러그인 부재) 안내]");
ok(
  "네이티브 플러그인 부재 감지 유지",
  /isNativePlatform\(\)\s*&&\s*!Capacitor\.isPluginAvailable\("Geolocation"\)/.test(geo),
);
ok(
  "'앱 업데이트' 안내 문구 유지",
  /앱을 최신 버전으로 업데이트/.test(geo) && /needsUpdate:\s*true/.test(geo),
);

console.log("[불변 조건 — 지오펜스 게이트 유지 (fail-closed)]");
ok(
  "클라: 일반유저는 GPS 필수 (admin QA 만 생략)",
  /if\s*\(!isAdmin\)\s*\{/.test(composer) && /getVenuePosition\(\)/.test(composer),
);
ok(
  "서버: 지오펜스 실패 시 403 (QA bypass 외 우회 없음)",
  /if\s*\(!geo\.ok\s*&&\s*!qaBypass\)/.test(route),
);
ok(
  "서버: QA bypass 업로드는 admin_qa 로 분리(승률 오염 방지)",
  /geo\.ok\s*\?\s*"story_geofence"\s*:\s*"admin_qa"/.test(route),
);

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
