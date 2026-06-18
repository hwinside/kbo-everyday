/* ===== KBO 중계방송사(TV) 약어 매핑 ===== */
// 출처: KBO 공식 PopBroadCast 범례. TV(지상파/케이블) + IPTV만 표시 대상.
// 라디오(-R 접미사)는 표시하지 않는다(중계방송사 = TV 표시가 목적).
// 사전에 없는 미지의 약어는 원본 약어 그대로 표시(fallback).

/** 약어 → 방송사 표시명 (TV/IPTV만) */
const BROADCAST_CHANNEL_MAP: Record<string, string> = {
  // TV (지상파/케이블)
  "K-T": "KBS",
  "M-T": "MBC",
  "S-T": "SBS",
  "KN-T": "KBSN SPORTS",
  "MS-T": "MBC SPORTS+",
  "SS-T": "SBS Sports",
  "T-T": "TBC",
  "DM-T": "대구MBC",
  "KNN-T": "KNN",
  "PM-T": "부산MBC",
  "TJ-T": "TJB",
  "TM-T": "대전MBC",
  "KM-T": "광주MBC",
  "GM-T": "MBC경남",
  "UM-T": "MBC울산",
  "SPOTV+": "SPOTV+",
  // IPTV
  "SPO-T": "SPOTV",
  "SPO-2T": "SPOTV2",
  "IB-T": "IB SPORTS",
};

/**
 * KBO GetKboGameList 응답의 TV_IF 필드를 표시용 방송사명 배열로 디코드한다.
 * - 콤마로 분리
 * - 라디오 약어(-R로 끝남) 제외
 * - 매핑에 있으면 표시명, 없으면 원본 약어(fallback)
 * - 중복 제거(표시명 기준)
 */
export function decodeBroadcast(tvIf: string | undefined | null): string[] {
  if (!tvIf) return [];
  const result: string[] = [];
  for (const part of tvIf.split(",")) {
    const code = part.trim();
    if (!code) continue;
    if (code.endsWith("R")) continue; // 라디오 제외 (라디오 코드는 -R/-2R 등 R로 끝남, TV/IPTV는 T/+로 끝남)
    const name = BROADCAST_CHANNEL_MAP[code] ?? code; // 미지 약어는 raw fallback
    if (!result.includes(name)) result.push(name);
  }
  return result;
}
