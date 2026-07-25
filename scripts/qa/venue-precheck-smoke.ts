/**
 * 직관 라이브 GPS 선체크(precheck) 순수 판정 스모크.
 * 실행: npm run qa:venue-precheck
 * 배경: PR #847 삼순 NO-GO 3건 — ①accuracy 무시(선체크 ok인데 서버 403) ②venue=null fail-open
 *       ③stale 위치 재사용. 선체크가 서버 evaluateGeofence 와 동일 축으로 판정하는지 직접 검증한다.
 */
import { readFileSync } from "node:fs";
import { resolveStadiumByName } from "../../src/lib/venue-stories/stadiums";
import { evaluateGeofence } from "../../src/lib/venue-stories/geofence";
import {
  classifyPrecheck,
  isPrecheckReusable,
  precheckGateReady,
  VENUE_PRECHECK_REUSE_TTL_MS,
  type PrecheckVenue,
} from "../../src/lib/venue-stories/precheck";
import { VENUE_GEOFENCE_MAX_ACCURACY_M } from "../../src/lib/venue-stories/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const jamsil = resolveStadiumByName("잠실야구장")!; // lat 37.5122, lng 127.0719, radius 1km
const venue: PrecheckVenue = {
  lat: jamsil.lat,
  lng: jamsil.lng,
  radiusM: jamsil.radiusM,
  stadiumName: jamsil.name,
};
const inside = { lat: 37.5125, lng: 127.0722 }; // ~40m
const outside = { lat: 37.56, lng: 127.0719 }; // ~5.3km
const MAX = VENUE_GEOFENCE_MAX_ACCURACY_M;

console.log("[classifyPrecheck — 서버 evaluateGeofence 와 동일 축(accuracy + 반경)]");

// ① inside + accurate → ok (측정값 재사용 대상)
ok("반경 안 + 정확 → ok", classifyPrecheck({ venue, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX }).status === "ok");

// ② outside → out + 거리
{
  const r = classifyPrecheck({ venue, measurement: { ...outside, accuracy: 20 }, maxAccuracy: MAX });
  ok("반경 밖 → out", r.status === "out");
  ok("반경 밖 → 거리 제공(>0)", (r.distanceM ?? 0) > 0);
}

// ③ 삼순 NO-GO #1: 반경 안이지만 저정확도 → failed (기존엔 ok로 통과 → 서버 403)
ok("반경 안 + 저정확도(>300m) → failed (accuracy 게이트)", classifyPrecheck({ venue, measurement: { ...inside, accuracy: 500 }, maxAccuracy: MAX }).status === "failed");
ok("반경 안 + accuracy null → failed", classifyPrecheck({ venue, measurement: { ...inside, accuracy: null }, maxAccuracy: MAX }).status === "failed");
ok("accuracy 경계(=300m)는 ok", classifyPrecheck({ venue, measurement: { ...inside, accuracy: MAX }, maxAccuracy: MAX }).status === "ok");
ok("선체크 판정 == 서버 evaluateGeofence 판정(저정확도)", (() => {
  const server = evaluateGeofence({ ...inside, accuracy: 500, coord: jamsil, maxAccuracy: MAX }).ok;
  const client = classifyPrecheck({ venue, measurement: { ...inside, accuracy: 500 }, maxAccuracy: MAX }).status === "ok";
  return server === false && client === false; // 둘 다 거절 → 괴리 없음
})());

// ④ 삼순 NO-GO #2: venue=null / 좌표 null → failed (fail-closed, 기존엔 ok로 fail-open)
ok("venue=null(구장 fetch 실패) → failed", classifyPrecheck({ venue: null, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX }).status === "failed");
ok("venue 좌표 null → failed", classifyPrecheck({ venue: { ...venue, lat: null, lng: null }, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX }).status === "failed");
ok("venue=null → 구장 정보 안내 문구", (classifyPrecheck({ venue: null, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX }).error ?? "").includes("구장 정보"));

// ⑤ 권한 거부(측정 에러) → failed(에러 노출) → 재시도(정상 측정) → ok
ok("권한 거부 → failed(에러 노출)", (() => {
  const r = classifyPrecheck({ venue, measurement: { error: "위치 권한을 허용해야 직관 인증이 가능해요" }, maxAccuracy: MAX });
  return r.status === "failed" && (r.error ?? "").includes("위치 권한");
})());
ok("재시도(정상 측정) → ok", classifyPrecheck({ venue, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX }).status === "ok");

console.log("[isPrecheckReusable — 삼순 NO-GO #3: 짧은 TTL, 만료 시 재측정]");
const now = 1_000_000;
ok("fresh(방금 측정) → 재사용 가능", isPrecheckReusable(now, now + 1_000, VENUE_PRECHECK_REUSE_TTL_MS) === true);
ok("TTL 경계(정확히 30s) → 재사용 가능", isPrecheckReusable(now, now + VENUE_PRECHECK_REUSE_TTL_MS, VENUE_PRECHECK_REUSE_TTL_MS) === true);
ok("stale(TTL 초과) → 재측정 강제(false)", isPrecheckReusable(now, now + VENUE_PRECHECK_REUSE_TTL_MS + 1, VENUE_PRECHECK_REUSE_TTL_MS) === false);
ok("측정값 없음(null) → 재측정(false)", isPrecheckReusable(null, now, VENUE_PRECHECK_REUSE_TTL_MS) === false);
ok("미래 타임스탬프(시계 역행) → fail-closed 재측정(false)", isPrecheckReusable(now + 5_000, now, VENUE_PRECHECK_REUSE_TTL_MS) === false);

console.log("[submit 최종 재검증 — fresh/stale 모두 서버 축으로 재판정]");
// 구장 안에서 선체크 ok 로 열었지만 이동해 반경 밖 → stale 재측정 좌표는 최종 게이트에서 거절
ok("stale 재측정이 반경 밖이면 최종 evaluateGeofence 거절", evaluateGeofence({ ...outside, accuracy: 20, coord: jamsil, maxAccuracy: MAX }).ok === false);
ok("fresh 재측정이 반경 안+정확이면 최종 통과", evaluateGeofence({ ...inside, accuracy: 20, coord: jamsil, maxAccuracy: MAX }).ok === true);
// 최종 게이트도 venue 정보 없으면(coord=null) fail-closed
ok("submit coord=null → 최종 게이트 fail-closed", evaluateGeofence({ ...inside, accuracy: 20, coord: null, maxAccuracy: MAX }).ok === false);

console.log("[precheckGateReady — 관리자 bypass / 일반 유저 ok 게이트]");
ok("관리자 → 선체크 상태 무관 submit 허용(idle)", precheckGateReady({ isAdmin: true, status: "idle" }) === true);
ok("관리자 → 선체크 failed 여도 submit 허용", precheckGateReady({ isAdmin: true, status: "failed" }) === true);
ok("일반 유저 ok → submit 허용", precheckGateReady({ isAdmin: false, status: "ok" }) === true);
ok("일반 유저 idle(최초 오픈·close→reopen) → picker/submit 차단", precheckGateReady({ isAdmin: false, status: "idle" }) === false);
ok("일반 유저 measuring → submit 차단", precheckGateReady({ isAdmin: false, status: "measuring" }) === false);
ok("일반 유저 out → submit 차단", precheckGateReady({ isAdmin: false, status: "out" }) === false);
ok("일반 유저 failed → submit 차단", precheckGateReady({ isAdmin: false, status: "failed" }) === false);

console.log("[picker wiring — idle 첫 렌더 race 이중 방어]");
const composerSource = readFileSync(
  new URL("../../src/components/game/VenueStoryComposer.tsx", import.meta.url),
  "utf8",
);
const openPickerSource = composerSource.match(/const openPicker = \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";
ok(
  "openPicker 내부가 precheckGateReady로 이중 방어",
  openPickerSource.includes("precheckGateReady({ isAdmin, status: precheck.status })"),
);
ok(
  "idle 첫 렌더는 위치 확인 카드로 대체",
  composerSource.includes('precheck.status === "idle" || precheck.status === "measuring"'),
);

console.log("[close·reopen late result — alive 가드 상태 판정]");
// 모달 닫힘/재오픈 후 도착하는 늦은 측정 결과는 컴포넌트 effect 의 alive=false 로 폐기된다.
// 순수 판정 자체는 결정적 — 같은 입력이면 같은 출력(늦게 도착해도 상태 오염 없음)을 보장.
ok("classifyPrecheck 결정적(동일 입력 동일 출력)", (() => {
  const a = classifyPrecheck({ venue, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX });
  const b = classifyPrecheck({ venue, measurement: { ...inside, accuracy: 20 }, maxAccuracy: MAX });
  return a.status === b.status && a.status === "ok";
})());

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
