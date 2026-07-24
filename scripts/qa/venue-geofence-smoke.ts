/**
 * 직관 라이브 지오펜스/업로드 시간대 순수 판정 스모크.
 * 실행: npm run qa:venue-geofence
 * 배경: PR #689 삼순 NO-GO — 모든 경기 fail-closed(미매핑 구장/시간대 밖/저정확도/반경 밖/가짜 경기).
 */
import { resolveStadiumByName } from "../../src/lib/venue-stories/stadiums";
import {
  evaluateUploadWindow,
  evaluateGeofence,
  isVenueUploadBlocked,
} from "../../src/lib/venue-stories/geofence";
import {
  VENUE_GEOFENCE_DEFAULT_RADIUS_M,
  VENUE_GEOFENCE_MAX_RADIUS_M,
  VENUE_GEOFENCE_MAX_ACCURACY_M,
  VENUE_UPLOAD_WINDOW_BEFORE_MIN,
  VENUE_UPLOAD_WINDOW_AFTER_HOURS,
} from "../../src/lib/venue-stories/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const START = Date.parse("2026-07-18T18:30:00+09:00");
const win = { beforeMin: VENUE_UPLOAD_WINDOW_BEFORE_MIN, afterHours: VENUE_UPLOAD_WINDOW_AFTER_HOURS };

console.log("[resolveStadiumByName — 실제 개최 구장명(S_NM)]");
ok("잠실 → 잠실야구장, 반경 최대(1km)", resolveStadiumByName("잠실야구장")?.radiusM === VENUE_GEOFENCE_MAX_RADIUS_M);
ok("문학/인천 → SSG", resolveStadiumByName("인천SSG랜더스필드")?.name === "인천SSG랜더스필드");
ok("제2구장 울산 → 울산문수", resolveStadiumByName("울산문수야구장")?.name === "울산문수야구장");
ok("제2구장 포항 매핑", !!resolveStadiumByName("포항야구장"));
ok("제2구장 청주 매핑", !!resolveStadiumByName("청주야구장"));
ok("기본 구장 반경 700m", resolveStadiumByName("대구삼성라이온즈파크")?.radiusM === VENUE_GEOFENCE_DEFAULT_RADIUS_M);
ok("미매핑(올스타/중립 등) → null", resolveStadiumByName("올스타 특설구장") === null);
ok("빈값 → null", resolveStadiumByName("") === null);
ok("null → null", resolveStadiumByName(null) === null);

console.log("[evaluateUploadWindow — fail-closed]");
ok("취소 경기 → 차단", evaluateUploadWindow({ cancelled: true, hasCoord: true, startMs: START, now: START, ...win }).uploadOpen === false);
ok("미매핑 구장 → 차단", evaluateUploadWindow({ cancelled: false, hasCoord: false, startMs: START, now: START, ...win }).uploadOpen === false);
ok("시간 불명 → 차단", evaluateUploadWindow({ cancelled: false, hasCoord: true, startMs: null, now: START, ...win }).uploadOpen === false);
ok("경기 시작 2h 전 → 차단", evaluateUploadWindow({ cancelled: false, hasCoord: true, startMs: START, now: START - 2 * 3600_000, ...win }).uploadOpen === false);
ok("경기 시작 30분 전 → 허용(윈도우 60분)", evaluateUploadWindow({ cancelled: false, hasCoord: true, startMs: START, now: START - 30 * 60_000, ...win }).uploadOpen === true);
ok("경기 중(시작 +2h) → 허용", evaluateUploadWindow({ cancelled: false, hasCoord: true, startMs: START, now: START + 2 * 3600_000, ...win }).uploadOpen === true);
ok("경기 종료 후(시작 +7h) → 마감", evaluateUploadWindow({ cancelled: false, hasCoord: true, startMs: START, now: START + 7 * 3600_000, ...win }).uploadOpen === false);

const jamsil = resolveStadiumByName("잠실야구장")!; // lat 37.5122, lng 127.0719, radius 1km
const inside = { lat: 37.5125, lng: 127.0722 }; // ~40m
const outside = { lat: 37.5600, lng: 127.0719 }; // ~5.3km

console.log("[evaluateGeofence — 직관 인증 fail-closed]");
ok("반경 안 + 정확 → ok", evaluateGeofence({ ...inside, accuracy: 20, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === true);
ok("반경 밖 → 차단", evaluateGeofence({ ...outside, accuracy: 20, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("좌표 미제출 → 차단", evaluateGeofence({ lat: null, lng: null, accuracy: null, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("구장 미매핑(coord=null) → 차단", evaluateGeofence({ ...inside, accuracy: 20, coord: null, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("저정확도(accuracy>300m) → 차단", evaluateGeofence({ ...inside, accuracy: 500, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("accuracy 경계(=300m)는 통과", evaluateGeofence({ ...inside, accuracy: 300, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === true);
ok("accuracy 누락(null) → 차단(생략 우회 방지)", evaluateGeofence({ ...inside, accuracy: null, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("accuracy 음수 → 차단", evaluateGeofence({ ...inside, accuracy: -1, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("accuracy NaN → 차단", evaluateGeofence({ ...inside, accuracy: NaN, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("lat NaN → 차단", evaluateGeofence({ lat: NaN, lng: 127.07, accuracy: 20, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("lat 범위밖(>90) → 차단", evaluateGeofence({ lat: 200, lng: 127.07, accuracy: 20, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("lng 범위밖(>180) → 차단", evaluateGeofence({ lat: 37.51, lng: 999, accuracy: 20, coord: jamsil, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false);
ok("반경 경계 밖 살짝(700m 구장 900m) → 차단", (() => {
  const daegu = resolveStadiumByName("대구삼성라이온즈파크")!; // 700m
  // 대구 구장에서 정북 약 900m 지점
  const p = { lat: daegu.lat + 900 / 111_000, lng: daegu.lng };
  return evaluateGeofence({ ...p, accuracy: 20, coord: daegu, maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M }).ok === false;
})());

// 삼순 #832 왕복2: 클라·서버 공유 업로드 차단 판정(관리자 시간창만 우회, 취소은 fail-closed)
console.log("[isVenueUploadBlocked — 클라/서버 단일 소스 업로드 게이트]");
ok("uploadOpen=true → 누구든 통과(일반)", isVenueUploadBlocked({ uploadOpen: true, gateKind: "open", privileged: false }) === false);
ok("uploadOpen=true → 누구든 통과(관리자)", isVenueUploadBlocked({ uploadOpen: true, gateKind: "open", privileged: true }) === false);
ok("일반 유저 종료후(after-window) → 차단", isVenueUploadBlocked({ uploadOpen: false, gateKind: "after-window", privileged: false }) === true);
ok("관리자 종료후(after-window) → submit 허용(시간창 우회)", isVenueUploadBlocked({ uploadOpen: false, gateKind: "after-window", privileged: true }) === false);
ok("관리자 시작전(before-window) → submit 허용(시간창 우회)", isVenueUploadBlocked({ uploadOpen: false, gateKind: "before-window", privileged: true }) === false);
ok("관리자 취소 경기(cancelled) → 차단(media prepare 전, fail-closed)", isVenueUploadBlocked({ uploadOpen: false, gateKind: "cancelled", privileged: true }) === true);
ok("관리자 미지원 구장(no-coord) → 차단(fail-closed)", isVenueUploadBlocked({ uploadOpen: false, gateKind: "no-coord", privileged: true }) === true);
ok("관리자 시간미상(no-time) → 차단(fail-closed)", isVenueUploadBlocked({ uploadOpen: false, gateKind: "no-time", privileged: true }) === true);
ok("일반 유저 취소 경기(cancelled) → 차단", isVenueUploadBlocked({ uploadOpen: false, gateKind: "cancelled", privileged: false }) === true);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
