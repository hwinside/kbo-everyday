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

export interface UploadWindowResult {
  uploadOpen: boolean;
  reason: string | null;
}

/**
 * 경기 상태/구장 매핑/시간대로 업로드 가능 여부 판정(fail-closed).
 * - 취소 경기, 미매핑 구장, 시간 불명 → uploadOpen=false
 * - 경기 시작 -beforeMin ~ +afterHours 사이만 uploadOpen=true
 */
export function evaluateUploadWindow(i: UploadWindowInput): UploadWindowResult {
  if (i.cancelled) return { uploadOpen: false, reason: "취소된 경기예요" };
  if (!i.hasCoord) {
    return { uploadOpen: false, reason: "이 구장은 아직 직관 라이브를 지원하지 않아요" };
  }
  if (i.startMs == null) {
    return { uploadOpen: false, reason: "경기 시간을 확인할 수 없어요" };
  }
  const from = i.startMs - i.beforeMin * 60_000;
  const to = i.startMs + i.afterHours * 3600_000;
  if (i.now < from) return { uploadOpen: false, reason: "경기 시작 전에는 올릴 수 없어요" };
  if (i.now > to) return { uploadOpen: false, reason: "경기가 끝나 직관 라이브가 마감됐어요" };
  return { uploadOpen: true, reason: null };
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
 * - 좌표 미제출 / 구장 미매핑 / accuracy 상한 초과 / 반경 밖 → ok=false
 */
export function evaluateGeofence(i: GeofenceInput): GeofenceResult {
  if (!i.coord) {
    return { ok: false, reason: "이 구장은 아직 직관 라이브를 지원하지 않아요" };
  }
  if (i.lat == null || i.lng == null) {
    return { ok: false, reason: "직관 인증(위치)이 필요해요" };
  }
  if (i.accuracy != null && i.accuracy > i.maxAccuracy) {
    return { ok: false, reason: "위치 정확도가 낮아요. 야외에서 다시 시도해주세요" };
  }
  const dist = haversineMeters(i.lat, i.lng, i.coord.lat, i.coord.lng);
  if (dist > i.coord.radiusM) {
    return { ok: false, reason: `직관 인증 실패 — ${i.coord.name} 근처에서만 올릴 수 있어요` };
  }
  return { ok: true, reason: null };
}
