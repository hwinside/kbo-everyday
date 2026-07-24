/**
 * Pitch-by-pitch 투구 상세 데이터 어댑터 (소스 격리 레이어).
 *
 * 현재 소스: 네이버 relay `textOptions[].type===1` (신규 fetch 0, 기존 payload 재사용).
 * 미래: 스포츠투아이 직접 계약 시 `Sports2iPitchProvider`로 교체 → PlayEvent.pitches[]
 *       스키마와 UI는 그대로 재사용.
 *
 * 네이버 스키마 변경 리스크는 이 모듈 안에 격리한다. 필드가 없으면 pitch를 생략하되
 * 타석 결과(PlayEvent) 자체는 상위 파서가 유지하도록 null을 돌려주는 fail-safe.
 *
 * 실측(2026-07-25, 종료 9경기 2,726구 / 삼순 QA): 모든 투구에 투구번호·결과 text·
 * 구속·구종·투구 시점 B/S/O가 존재. 예외 = 사구 마지막 공 별도 행 누락 / 자동고의4구
 * 0구 / 대타 교체용 빈 타석 → 셋 다 "pitches 없음"으로 자연 처리(결과행은 별도로 남음).
 */

/** 투구 1개 상세 (소스 무관 공용 스키마). */
export interface PitchDetail {
  /** 타석 내 투구 번호 (1부터). */
  num: number;
  /** 구종 (예: 직구/슬라이더/포크). 미측정 시 빈 문자열. */
  stuff: string;
  /** 구속 km/h. 미측정/누락 시 0. */
  speed: number;
  /** 사람이 읽는 결과 텍스트 (예: "볼", "헛스윙", "타격", "파울"). */
  resultText: string;
  /** 결과 카테고리 (색상/아이콘용). text 기반 파생 — 원문 code 의미가 불안정해 신뢰하지 않음. */
  kind: "ball" | "strike" | "foul" | "inplay" | "other";
  /** 투구 시점 카운트 스냅샷 (Slice 2 볼카운트 배지용, 있으면). */
  count?: { ball: number; strike: number; out: number };
}

/** 네이버 relay textOption 중 pitch 파싱에 필요한 최소 형태. */
export interface NaverPitchOption {
  type: number;
  text?: string;
  pitchNum?: number;
  stuff?: string;
  speed?: string;
  pitchResult?: string;
  currentGameState?: { ball?: string; strike?: string; out?: string };
}

/** "3구 헛스윙" → "헛스윙" (선행 "N구 " 접두 제거). 접두 없으면 원문 유지. */
function stripPitchPrefix(text: string): string {
  return text.replace(/^\s*\d+구\s*/, "").trim();
}

/** 결과 텍스트 → 색상 카테고리. 원문 pitchResult code 의미가 불안정(H=타격 실측)해 text 기준. */
function classifyPitch(resultText: string): PitchDetail["kind"] {
  if (resultText.includes("파울")) return "foul";
  if (resultText.includes("볼")) return "ball"; // "볼", 단 "몸에 맞는 볼"도 ball 취급(진루는 상위 extras)
  if (resultText.includes("타격") || resultText.includes("인플레이")) return "inplay";
  if (resultText.includes("스윙") || resultText.includes("스트라이크") || resultText.includes("루킹"))
    return "strike";
  return "other";
}

/**
 * 네이버 relay textOption 1개를 PitchDetail로 변환.
 * type!==1 이거나 최소 정보(text)조차 없으면 null (상위 파서가 무시).
 */
export function parseNaverPitch(opt: NaverPitchOption): PitchDetail | null {
  if (opt.type !== 1) return null;
  const rawText = (opt.text ?? "").trim();
  if (!rawText) return null;

  const resultText = stripPitchPrefix(rawText) || rawText;
  const speedNum = opt.speed ? parseInt(opt.speed, 10) : 0;
  const cgs = opt.currentGameState;
  const count =
    cgs && cgs.ball != null && cgs.strike != null && cgs.out != null
      ? {
          ball: parseInt(cgs.ball, 10) || 0,
          strike: parseInt(cgs.strike, 10) || 0,
          out: parseInt(cgs.out, 10) || 0,
        }
      : undefined;

  return {
    num: typeof opt.pitchNum === "number" && opt.pitchNum > 0 ? opt.pitchNum : 0,
    stuff: (opt.stuff ?? "").trim(),
    speed: Number.isFinite(speedNum) && speedNum > 0 ? speedNum : 0,
    resultText,
    kind: classifyPitch(resultText),
    count,
  };
}
