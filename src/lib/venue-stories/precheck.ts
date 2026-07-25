// 직관 라이브 GPS 선체크 — 순수 판정(React·네트워크·GPS 플러그인 의존 없음, 단위 테스트 가능).
//
// 선체크(모달 열릴 때 미리 위치 측정)와 서버 최종 판정(POST /api/venue-stories)의 괴리를 없앤다.
// - 서버와 동일 축(shared evaluateGeofence + VENUE_GEOFENCE_MAX_ACCURACY_M)으로 판정해
//   "선체크 ok 인데 최종 POST 403" 을 막는다(삼순 NO-GO #1: accuracy 무시).
// - 구장 정보 미확보(venue=null/좌표 null)는 fail-closed(삼순 NO-GO #2: venue=null fail-open).
// - 선체크 측정값은 짧은 TTL 안에서만 재사용, 만료 시 submit 에서 재측정(삼순 NO-GO #3: stale 재사용).

import { evaluateGeofence } from "./geofence";
import { haversineMeters, type StadiumCoord } from "./stadiums";

export type PrecheckStatus = "idle" | "measuring" | "ok" | "out" | "failed";

export interface PrecheckState {
  status: PrecheckStatus;
  distanceM?: number | null;
  error?: string | null;
}

/** 선체크 판정에 필요한 구장 좌표/반경(서버 venue 응답 부분집합). */
export interface PrecheckVenue {
  lat: number | null;
  lng: number | null;
  radiusM: number;
  stadiumName: string | null;
}

/** GPS 측정 결과 — 성공(좌표+정확도) 또는 실패(권한거부·타임아웃 등 에러). */
export type PrecheckMeasurement =
  | { lat: number; lng: number; accuracy: number | null }
  | { error: string };

/**
 * 선체크 측정 결과 → 선체크 상태(순수). 서버 evaluateGeofence 와 동일 축으로 판정한다.
 * - venue 정보 미확보(null/좌표 null) → failed(fail-closed, 삼순 NO-GO #2)
 * - 측정 에러(권한거부·타임아웃) → failed(에러 노출)
 * - evaluateGeofence(accuracy + 반경, 삼순 NO-GO #1)
 *   - ok → "ok"
 *   - accuracy 불량(누락/비유한/음수/상한초과) → failed(정확도 안내)
 *   - 반경 밖 → out(거리 표시)
 */
export function classifyPrecheck(i: {
  venue: PrecheckVenue | null;
  measurement: PrecheckMeasurement;
  maxAccuracy: number;
}): PrecheckState {
  const { venue, measurement, maxAccuracy } = i;
  if (!venue || venue.lat == null || venue.lng == null) {
    return { status: "failed", error: "구장 정보를 확인하지 못했어요. 다시 시도해주세요" };
  }
  if ("error" in measurement) {
    return { status: "failed", error: measurement.error };
  }
  const coord: StadiumCoord = {
    lat: venue.lat,
    lng: venue.lng,
    radiusM: venue.radiusM,
    name: venue.stadiumName ?? "경기장",
  };
  const geo = evaluateGeofence({
    lat: measurement.lat,
    lng: measurement.lng,
    accuracy: measurement.accuracy,
    coord,
    maxAccuracy,
  });
  if (geo.ok) return { status: "ok" };
  const accuracyBad =
    typeof measurement.accuracy !== "number" ||
    !Number.isFinite(measurement.accuracy) ||
    measurement.accuracy < 0 ||
    measurement.accuracy > maxAccuracy;
  if (accuracyBad) {
    return { status: "failed", error: "위치 정확도가 낮아요. 야외에서 다시 시도해주세요" };
  }
  return {
    status: "out",
    distanceM: haversineMeters(measurement.lat, measurement.lng, venue.lat, venue.lng),
  };
}

/**
 * 선체크 측정값을 submit 에서 재사용 가능한지(TTL). 없거나 만료(또는 미래 타임스탬프)면
 * false → submit 은 반드시 현재 위치를 재측정한다(삼순 NO-GO #3: 구장 안에서 열고 이동한 경우 방지).
 */
export function isPrecheckReusable(cachedAtMs: number | null, now: number, ttlMs: number): boolean {
  if (cachedAtMs == null) return false;
  const age = now - cachedAtMs;
  return age >= 0 && age <= ttlMs;
}

/** submit 을 열어도 되는 선체크 상태인지. 관리자 QA 는 선체크 없이 통과(bypass). */
export function precheckGateReady(i: { isAdmin: boolean; status: PrecheckStatus }): boolean {
  return i.isAdmin || i.status === "ok";
}

/** 선체크 측정값 재사용 TTL — 이 시간 지나면 submit 에서 현재 위치를 재측정한다. */
export const VENUE_PRECHECK_REUSE_TTL_MS = 30_000;
