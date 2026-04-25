/**
 * 한글 초성/자모 검색 유틸리티
 * - 초성 검색: "ㅂㅁㅇ" → 박민우
 * - 자모 조합 중 검색: "ㅂㅏ" → 박, 반, 방...
 * - 완성 글자 검색: "박민" → 박민우
 */

// 초성 19자
const CHOSUNG = [
  "ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ",
  "ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ",
];

// 중성 21자
const JUNGSUNG = [
  "ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ",
  "ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ",
];

// 종성 28자 (첫 번째는 없음)
const JONGSUNG = [
  "","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ",
  "ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ",
  "ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ",
];

const HANGUL_BASE = 0xAC00; // '가'
const CHOSUNG_COUNT = 19;
const JUNGSUNG_COUNT = 21;
const JONGSUNG_COUNT = 28;

/** 한글 완성 글자인지 확인 */
function isHangulChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xAC00 && code <= 0xD7A3;
}

/** 한글 자모(낱자)인지 확인 */
function isJamo(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 0x3131 && code <= 0x3163); // ㄱ~ㅣ
}

/** 초성인지 확인 */
function isChosung(ch: string): boolean {
  return CHOSUNG.includes(ch);
}

/** 중성(모음)인지 확인 */
function isJungsung(ch: string): boolean {
  return JUNGSUNG.includes(ch);
}

/** 완성 글자를 초성/중성/종성으로 분리 */
function decompose(ch: string): [number, number, number] {
  const code = ch.charCodeAt(0) - HANGUL_BASE;
  const cho = Math.floor(code / (JUNGSUNG_COUNT * JONGSUNG_COUNT));
  const jung = Math.floor((code % (JUNGSUNG_COUNT * JONGSUNG_COUNT)) / JONGSUNG_COUNT);
  const jong = code % JONGSUNG_COUNT;
  return [cho, jung, jong];
}

/** 완성 글자의 초성 추출 */
function getChosung(ch: string): string {
  if (!isHangulChar(ch)) return ch;
  const [cho] = decompose(ch);
  return CHOSUNG[cho];
}

/**
 * 한글 초성/자모 검색 매칭
 *
 * query의 각 문자가:
 * - 초성(ㅂ): target 대응 위치의 초성과 비교
 * - 중성(ㅏ): 직전 초성과 결합하여 target 글자의 초성+중성 비교
 * - 완성 글자(박): target 글자와 직접 비교 (종성 없으면 종성 무시)
 */
export function matchHangul(target: string, query: string): boolean {
  if (!query) return true;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 영문/숫자 포함 시 기본 includes로 fallback
  if (!/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(q)) {
    return t.includes(q);
  }

  // 초성만으로 이루어진 쿼리인지 확인
  const allChosung = [...q].every(ch => isChosung(ch));
  if (allChosung) {
    // 초성 시퀀스 매칭: target의 연속 초성과 비교
    const targetChosungs = [...t].map(ch => isHangulChar(ch) ? getChosung(ch) : ch);
    const queryChars = [...q];
    for (let i = 0; i <= targetChosungs.length - queryChars.length; i++) {
      let match = true;
      for (let j = 0; j < queryChars.length; j++) {
        if (targetChosungs[i + j] !== queryChars[j]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  // 자모 혼합 검색 (ㅂㅏ, 박ㅁ, 박민ㅇ 등)
  // 쿼리를 "음절 단위"로 그룹핑
  const queryGroups = groupQueryToSyllables(q);
  if (!queryGroups) return t.includes(q); // 파싱 실패 시 fallback

  // target에서 연속 매칭
  for (let start = 0; start <= t.length - queryGroups.length; start++) {
    let matched = true;
    for (let gi = 0; gi < queryGroups.length; gi++) {
      const ti = start + gi;
      if (ti >= t.length) { matched = false; break; }
      if (!matchSyllable(t[ti], queryGroups[gi])) { matched = false; break; }
    }
    if (matched) return true;
  }
  return false;
}

interface SyllableQuery {
  cho?: string;   // 초성 (ㄱ~ㅎ)
  jung?: string;  // 중성 (ㅏ~ㅣ)
  jong?: string;  // 종성 (ㄱ~ㅎ)
  exact?: string; // 완성 글자 (가~힣) — 종성 유무에 따라 매칭 방식 달라짐
}

/** 쿼리 문자열을 음절 단위 그룹으로 분리 */
function groupQueryToSyllables(query: string): SyllableQuery[] | null {
  const chars = [...query];
  const groups: SyllableQuery[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];

    if (isHangulChar(ch)) {
      // 완성 글자
      groups.push({ exact: ch });
      i++;
    } else if (isChosung(ch)) {
      // 초성 시작
      const group: SyllableQuery = { cho: ch };
      i++;
      // 다음이 중성이면 결합
      if (i < chars.length && isJungsung(chars[i])) {
        group.jung = chars[i];
        i++;
        // 다음이 자음(종성 후보)이고 그 다음이 모음이 아니면 종성
        if (i < chars.length && isChosung(chars[i])) {
          if (i + 1 < chars.length && isJungsung(chars[i + 1])) {
            // 다음 자음+모음 → 새 음절의 초성이므로 종성 아님
          } else {
            group.jong = chars[i];
            i++;
          }
        }
      }
      groups.push(group);
    } else if (isJungsung(ch)) {
      // 독립 모음 (드문 케이스)
      groups.push({ jung: ch });
      i++;
    } else {
      // 비한글 문자
      groups.push({ exact: ch });
      i++;
    }
  }

  return groups;
}

/** 단일 음절 매칭 */
function matchSyllable(targetChar: string, query: SyllableQuery): boolean {
  // 비한글 exact 매칭
  if (query.exact && !isHangulChar(query.exact)) {
    return targetChar.toLowerCase() === query.exact.toLowerCase();
  }

  if (!isHangulChar(targetChar)) {
    // target이 비한글이면 exact만 매칭
    return query.exact === targetChar;
  }

  const [tCho, tJung, tJong] = decompose(targetChar);

  // 완성 글자 쿼리
  if (query.exact) {
    const [qCho, qJung, qJong] = decompose(query.exact);
    if (qJong === 0) {
      // 종성 없는 완성 글자: 초성+중성만 일치하면 OK (종성 무관)
      return tCho === qCho && tJung === qJung;
    }
    // 종성 있는 완성 글자: 정확히 일치
    return tCho === qCho && tJung === qJung && tJong === qJong;
  }

  // 초성만
  if (query.cho && !query.jung) {
    return CHOSUNG[tCho] === query.cho;
  }

  // 초성 + 중성
  if (query.cho && query.jung) {
    if (CHOSUNG[tCho] !== query.cho) return false;
    if (JUNGSUNG[tJung] !== query.jung) return false;
    // 종성 쿼리가 있으면 종성도 비교
    if (query.jong) {
      const jongIdx = JONGSUNG.indexOf(query.jong);
      return tJong === jongIdx;
    }
    return true;
  }

  return false;
}
