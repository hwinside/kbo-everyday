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

/** 약어 → 로고 파일 경로 (public/broadcast-logos/). 로고를 확보한 채널만 등록. */
// 다크모드(배경 #0A0A0B) 대응: 컴포넌트에서 흰색 둥근 칩 안에 원본 컬러 로고를 넣어 표시.
// 위키미디어 Commons 출처(중계사 안내 목적 nominative use). 흰색/불투명 배경 로고는 칩에서
// 묻히므로 제외했고, 로고 미확보 채널은 기존 텍스트 배지로 fallback.
const BROADCAST_LOGO_MAP: Record<string, string> = {
  "K-T": "/broadcast-logos/K-T.svg",       // KBS
  "M-T": "/broadcast-logos/M-T.svg",       // MBC
  "S-T": "/broadcast-logos/S-T.svg",       // SBS
  "KN-T": "/broadcast-logos/KN-T.svg",     // KBSN SPORTS
  "MS-T": "/broadcast-logos/MS-T.svg",     // MBC SPORTS+
  "SS-T": "/broadcast-logos/SS-T.svg",     // SBS Sports
  "SPO-T": "/broadcast-logos/SPO-T.svg",   // SPOTV
  "SPO-2T": "/broadcast-logos/SPO-2T.svg", // SPOTV2
};

/** 디코드된 단일 중계방송사. 로고가 있으면 logoSrc, 없으면 텍스트(name) fallback. */
export interface BroadcastChannel {
  /** 표시명(예: "SPOTV") */
  name: string;
  /** 원본 약어(예: "SPO-T") */
  code: string;
  /** 로고 파일 경로. 미확보 시 undefined → 텍스트 배지 fallback */
  logoSrc?: string;
}

/**
 * KBO GetKboGameList 응답의 TV_IF 필드를 중계방송사 배열로 디코드한다.
 * - 콤마로 분리
 * - 라디오 약어(-R로 끝남) 제외
 * - 매핑에 있으면 표시명, 없으면 원본 약어(fallback)
 * - 로고 확보 채널은 logoSrc 포함
 * - 중복 제거(표시명 기준)
 */
export function decodeBroadcast(tvIf: string | undefined | null): BroadcastChannel[] {
  if (!tvIf) return [];
  const result: BroadcastChannel[] = [];
  const seen = new Set<string>();
  for (const part of tvIf.split(",")) {
    const code = part.trim();
    if (!code) continue;
    if (code.endsWith("R")) continue; // 라디오 제외 (라디오 코드는 -R/-2R 등 R로 끝남, TV/IPTV는 T/+로 끝남)
    const name = BROADCAST_CHANNEL_MAP[code] ?? code; // 미지 약어는 raw fallback
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ name, code, logoSrc: BROADCAST_LOGO_MAP[code] });
  }
  return result;
}
