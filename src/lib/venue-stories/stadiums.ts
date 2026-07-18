// 직관 라이브 지오펜스 — KBO 구장 좌표 + gameId→구장 파싱 + 거리 계산
// (server-safe: 브라우저 API 의존 없음, API route 에서 재검증용으로 import)

export interface StadiumCoord {
  lat: number;
  lng: number;
  name: string;
}

/** 홈팀 id → 홈 구장 좌표. (게임은 홈팀 구장에서 열림; 올스타/중립경기는 매핑 없음) */
export const STADIUM_COORDS: Record<number, StadiumCoord> = {
  1: { lat: 37.5122, lng: 127.0719, name: "잠실야구장" }, // LG
  2: { lat: 37.5122, lng: 127.0719, name: "잠실야구장" }, // 두산
  3: { lat: 37.29985, lng: 127.00968, name: "수원KT위즈파크" }, // KT
  4: { lat: 37.437, lng: 126.6932, name: "인천SSG랜더스필드" }, // SSG
  5: { lat: 35.22252, lng: 128.58229, name: "창원NC파크" }, // NC
  6: { lat: 35.16815, lng: 126.88899, name: "광주기아챔피언스필드" }, // KIA
  7: { lat: 35.19402, lng: 129.06153, name: "사직야구장" }, // 롯데
  8: { lat: 35.841, lng: 128.68172, name: "대구삼성라이온즈파크" }, // 삼성
  9: { lat: 36.31718, lng: 127.42975, name: "대전한화생명볼파크" }, // 한화
  10: { lat: 37.49821, lng: 126.86723, name: "고척스카이돔" }, // 키움
};

/** KBO 2자 팀코드 → 팀 id (native-live-activity ID_TO_KBO_CODE 역맵) */
export const KBO_CODE_TO_ID: Record<string, number> = {
  LG: 1,
  OB: 2,
  KT: 3,
  SK: 4,
  NC: 5,
  HT: 6,
  LT: 7,
  SS: 8,
  HH: 9,
  WO: 10,
};

/** 홈팀 id 로 구장 좌표 조회 (없으면 null) */
export function stadiumByTeamId(teamId: number | null | undefined): StadiumCoord | null {
  if (teamId == null) return null;
  return STADIUM_COORDS[teamId] ?? null;
}

/**
 * gameId("YYYYMMDD"+away2+home2+digit)의 홈팀 코드로 구장 좌표를 독립 파싱.
 * 올스타(WE/EA)·프리시즌·비정형 gameId 는 null(지오펜스 미적용 → 서버 fail-open).
 */
export function stadiumForGame(gameId: string): StadiumCoord | null {
  const m = /^\d{8}[A-Z]{2}([A-Z]{2})\d$/.exec(gameId);
  if (!m) return null;
  const teamId = KBO_CODE_TO_ID[m[1]];
  if (!teamId) return null;
  return STADIUM_COORDS[teamId] ?? null;
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
