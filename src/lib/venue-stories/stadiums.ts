// 직관 라이브 지오펜스 — KBO 구장 좌표(실제 개최 구장명 S_NM 기준) + 거리 계산
// (server-safe: 브라우저 API 의존 없음)
//
// 홈팀=홈구장 가정 대신, 실제 경기 스케줄의 S_NM(개최 구장명)으로 좌표를 해석한다.
// 울산/포항/청주 등 제2구장 경기도 정확히 매핑된다. 미매핑 구장은 null → 서버 fail-closed.

import {
  VENUE_GEOFENCE_DEFAULT_RADIUS_M,
  VENUE_GEOFENCE_MAX_RADIUS_M,
} from "./types";

export interface StadiumCoord {
  lat: number;
  lng: number;
  name: string;
  radiusM: number;
}

interface StadiumEntry {
  tokens: string[]; // S_NM 에 포함되면 매칭
  lat: number;
  lng: number;
  name: string;
  radiusM: number;
}

// 대형 종합운동장 단지는 반경을 최대(1km)로, 나머지는 기본(700m).
const STADIUMS: StadiumEntry[] = [
  { tokens: ["잠실"], lat: 37.5122, lng: 127.0719, name: "잠실야구장", radiusM: VENUE_GEOFENCE_MAX_RADIUS_M },
  { tokens: ["수원"], lat: 37.29985, lng: 127.00968, name: "수원KT위즈파크", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["문학", "인천"], lat: 37.437, lng: 126.6932, name: "인천SSG랜더스필드", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["창원"], lat: 35.22252, lng: 128.58229, name: "창원NC파크", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["광주"], lat: 35.16815, lng: 126.88899, name: "광주기아챔피언스필드", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["사직", "부산"], lat: 35.19402, lng: 129.06153, name: "사직야구장", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["대구"], lat: 35.841, lng: 128.68172, name: "대구삼성라이온즈파크", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["대전"], lat: 36.31718, lng: 127.42975, name: "대전한화생명볼파크", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["고척"], lat: 37.49821, lng: 126.86723, name: "고척스카이돔", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  // 제2구장
  { tokens: ["울산"], lat: 35.5348, lng: 129.2656, name: "울산문수야구장", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["포항"], lat: 36.0079, lng: 129.3597, name: "포항야구장", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
  { tokens: ["청주"], lat: 36.6392, lng: 127.4699, name: "청주야구장", radiusM: VENUE_GEOFENCE_DEFAULT_RADIUS_M },
];

/** 실제 구장명(S_NM)으로 좌표+반경 해석. 매핑 없으면 null(→ fail-closed). */
export function resolveStadiumByName(sNm: string | null | undefined): StadiumCoord | null {
  if (!sNm) return null;
  const name = sNm.trim();
  for (const s of STADIUMS) {
    if (s.tokens.some((t) => name.includes(t))) {
      return { lat: s.lat, lng: s.lng, name: s.name, radiusM: s.radiusM };
    }
  }
  return null;
}

/** 하버사인 거리(m) */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
