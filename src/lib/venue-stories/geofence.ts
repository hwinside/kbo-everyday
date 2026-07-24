// 직관 라이브 — 지오펜스/업로드 시간대 순수 판정(네트워크·DB 의존 없음, 단위 테스트 가능)
//
// venue-resolve(서버 gameId 해석)와 POST /api/venue-stories(업로드 게이트)가 공유한다.
// 좌표 미매핑·시간대 밖·위치 미제출·저정확도·반경 밖은 전부 fail-closed.

import { haversineMeters, type StadiumCoord } from "./stadiums";

export interface UploadWindowInput {
  cancelled: boolean;
  hasCoord: boolean;
  startMs: number | null;
  now: number;
  beforeMin: number;
  afterHours: number;
}

// 업로드 차단 사유 종류. 관리자 QA 우회는 **시간창 사유(before/after)만** 허용이고,
// cancelled/no-coord/no-time은 관리자도 fail-closed(삼순 #832 왕복3).
export type UploadGateKind =
  | "open" // uploadOpen=true
  | "cancelled" // 취소 경기
  | "no-coord" // 미지원 구장
  | "no-time" // 경기 시간 미상
  | "before-window" // 경기 시작 전(시간창)
  | "after-window"; // 경기 종료 후(시간창)

export interface UploadWindowResult {
  uploadOpen: boolean;
  reason: string | null;
  gateKind: UploadGateKind;
}

/** 관리자 QA가 우회 가능한 시간창 사유인가(before/after만). */
export function isWindowGateKind(kind: UploadGateKind): boolean {
  return kind === "before-window" || kind === "after-window";
}

/**
 * 경기 상태/구장 매핑/시간대로 업로드 가능 여부 판정(fail-closed).
 * - 취소 경기, 미매핑 구장, 시간 불명 → uploadOpen=false
 * - 경기 시작 -beforeMin ~ +afterHours 사이만 uploadOpen=true
 */
export function evaluateUploadWindow(i: UploadWindowInput): UploadWindowResult {
  if (i.cancelled) return { uploadOpen: false, reason: "취소된 경기예요", gateKind: "cancelled" };
  if (!i.hasCoord) {
    return { uploadOpen: false, reason: "이 구장은 아직 직관 라이브를 지원하지 않아요", gateKind: "no-coord" };
  }
  if (i.startMs == null) {
    return { uploadOpen: false, reason: "경기 시간을 확인할 수 없어요", gateKind: "no-time" };
  }
  const from = i.startMs - i.beforeMin * 60_000;
  const to = i.startMs + i.afterHours * 3600_000;
  if (i.now < from) return { uploadOpen: false, reason: "경기 시작 전에는 올릴 수 없어요", gateKind: "before-window" };
  if (i.now > to) return { uploadOpen: false, reason: "경기가 끝나 직관 라이브가 마감됐어요", gateKind: "after-window" };
  return { uploadOpen: true, reason: null, gateKind: "open" };
}

/**
 * 업로드 차단 판정(클라·서버 단일 소스, 삼순 #832 왕복2).
 * - uploadOpen 이면 통과.
 * - uploadOpen=false: 일반 유저는 전부 차단. 관리자(privileged)는 **시간창만 우회** —
 *   cancelled·no-coord·no-time 은 관리자도 fail-closed(실제 경기/지원 구장이 아니므로 QA 대상 아님).
 * 클라는 이 판정으로 media prepare 전 차단해 고아 객체/불필요 전송을 막고, 서버는 동일 판정으로 403.
 */
export function isVenueUploadBlocked(i: {
  uploadOpen: boolean;
  gateKind: UploadGateKind;
  privileged: boolean;
}): boolean {
  if (i.uploadOpen) return false;
  if (!i.privileged) return true; // 일반 유저: uploadOpen=false 전부 차단
  // 관리자는 시간창 사유(before/after)만 우회 — cancelled/no-coord/no-time 은 차단 유지
  return !isWindowGateKind(i.gateKind);
}

export interface GeofenceInput {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  coord: StadiumCoord | null;
  maxAccuracy: number;
}

export interface GeofenceResult {
  ok: boolean;
  reason: string | null;
}

/**
 * GPS 좌표가 구장 반경 안(직관 인증)인지 판정(fail-closed).
 * - 구장 미매핑 / 좌표 미제출·비유한·범위밖 / accuracy 누락·비유한·음수·상한초과 / 반경 밖 → ok=false
 * - accuracy 를 필수화해 "accuracy 생략하면 통과" 우회를 차단(삼순 NO-GO #1).
 */
export function evaluateGeofence(i: GeofenceInput): GeofenceResult {
  if (!i.coord) {
    return { ok: false, reason: "이 구장은 아직 직관 라이브를 지원하지 않아요" };
  }
  // 좌표는 finite + 지구 범위 내여야 함(누락·NaN·범위밖 fail-closed)
  if (
    typeof i.lat !== "number" || !Number.isFinite(i.lat) || i.lat < -90 || i.lat > 90 ||
    typeof i.lng !== "number" || !Number.isFinite(i.lng) || i.lng < -180 || i.lng > 180
  ) {
    return { ok: false, reason: "직관 인증(위치)이 필요해요" };
  }
  // accuracy 필수: finite + 0 이상 + 상한 이하. 누락/비유한/음수/과대는 전부 차단.
  if (typeof i.accuracy !== "number" || !Number.isFinite(i.accuracy) || i.accuracy < 0) {
    return { ok: false, reason: "위치 정확도를 확인할 수 없어요. 야외에서 다시 시도해주세요" };
  }
  if (i.accuracy > i.maxAccuracy) {
    return { ok: false, reason: "위치 정확도가 낮아요. 야외에서 다시 시도해주세요" };
  }
  const dist = haversineMeters(i.lat, i.lng, i.coord.lat, i.coord.lng);
  if (dist > i.coord.radiusM) {
    return { ok: false, reason: `직관 인증 실패 — ${i.coord.name} 근처에서만 올릴 수 있어요` };
  }
  return { ok: true, reason: null };
}
