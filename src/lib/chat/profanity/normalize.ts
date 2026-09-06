// 크관 채팅 비속어 필터 — 정규화 유틸 (순수 함수)
// 오탐 최소화 원칙: 어절 경계 기반 판정을 위해 원문 span을 보존한다.

const ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;

/**
 * 어절 단위 정규화.
 * - NFKC + 소문자
 * - 제로폭/공백 제거
 * - 문자·숫자·한글 자모(ㄱ-ㅎ, ㅏ-ㅣ)만 남김 (특수문자 삽입 우회 흡수)
 * - 고신뢰 '씨이발/시이발' 장음만 원형으로 축약
 * - 3연속 이상 동일 문자 반복은 2개로 축약
 * 신규 규칙은 이 정규화/어절 경계를 사용한다.
 * 기존 12어의 raw flexible/공백 삽입 탐지는 classify에서 별도로 보존한다.
 */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFKC")
    .toLowerCase()
    .replace(ZERO_WIDTH, "")
    .replace(/[^\p{L}\p{N}\u3131-\u3163]/gu, "")
    .replace(/([씨시])이+(?=발)/gu, "$1")
    .replace(/(.)\1{2,}/gu, "$1$1");
}

export interface Word {
  raw: string;
  norm: string;
  /** 원문 내 시작 인덱스 (span 추적용) */
  start: number;
  /** 원문 내 끝 인덱스(exclusive) */
  end: number;
  /** 어절 순번 */
  index: number;
}

/**
 * 공백 기준 어절 분리 + 각 어절 정규화. 원문 span 보존.
 * allowlist는 어절 span 단위로만 면책하므로 어절 경계가 판정의 기본 단위다.
 */
export function splitWords(text: string): Word[] {
  const words: Word[] = [];
  const re = /\S+/gu;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    words.push({
      raw,
      norm: normalizeToken(raw),
      start: m.index,
      end: m.index + raw.length,
      index: idx++,
    });
  }
  return words;
}
