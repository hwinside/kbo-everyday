// AI 경기 요약 내부 정합성(산술) 검증 헬퍼.
//
// 박스스코어는 선수별 '총 스탯'과 이닝별 '팀 득점'만 제공한다. 주자 상황(만루,
// 주자 N명)이나 출루 과정(연속 안타/볼넷/진루타)은 데이터에 없다. 그런데 LLM이
// 승부처를 극적으로 쓰려고 주자 상황을 환각하면, 산술적으로 모순된 서술이 나온다.
//
// 사고(2026-06-20, 두산 2:4 LG): "8회말 2사 *만루*에서 문보경 역전 *3점* 홈런"
//  → 만루(주자 3명)에서 홈런이면 타자 포함 4명이 득점 = 만루홈런(4점)이어야 한다.
//    3점 홈런이면 주자는 2명(만루 아님). 실제 점수(2-1→4-2)도 3점 홈런이 맞고
//    "만루"가 환각이었다. 같은 요약이 첫 문단은 "연속 안타로 만루", 승부처는
//    "안타+진루타+볼넷"으로 출루 과정까지 서로 다르게 서술했다.
//
// 이 헬퍼는 박스스코어로 검증 가능한 *산술 모순*만 잡는다(주자 상황 환각의
// 부산물). 출루 과정 묘사 자체를 막는 것은 프롬프트(주자 상황 창작 금지)가 담당.

// 만루홈런(=4점) 허용 표현. 이게 있으면 "만루+홈런"은 정상.
const GRAND_SLAM_RE = /만루\s*(?:홈런|포|아치)|그랜드\s*슬램|4점\s*(?:홈런|포|아치)/;

// 문장(절) 단위 분리 — 만루와 무관한 다른 장면의 홈런을 같은 문장으로 오인하지 않도록.
const SENTENCE_SPLIT_RE = /[.!?…\n]+/;

// '만루'가 공격 득점 장면이 아니라 *수비 위기 탈출* 맥락이면 홈런 득점과 무관.
// (예: "만루 위기를 무실점으로 넘겼다" 다음 이닝의 솔로 홈런을 모순으로 오인 방지.)
const NON_SCORING_MANRU_RE = /위기|넘기|넘겼|막아|막았|무실점|실점\s*없|병살|잡아내|틀어막|살리지\s*못|무산|잔루|터지지\s*않/;

// 한 문장에서 홈런의 득점 수(1~4)를 추출. 없으면 null.
// - "솔로" → 1
// - "N점 홈런/포/아치" → N
// - "홈런/포/아치 … N점(을) 추가/득점/뽑/터뜨" → N (예: "홈런으로 단숨에 3점을 추가")
function homerRunCount(sentence: string): number | null {
  if (/솔로\s*(?:홈런|포|아치)/.test(sentence)) return 1;

  const before = sentence.match(/([1-4])\s*점\s*(?:짜리\s*)?(?:홈런|포|아치)/);
  if (before) return parseInt(before[1], 10);

  const after = sentence.match(/(?:홈런|포|아치)[^.!?…]{0,14}?([1-4])\s*점/);
  if (after) return parseInt(after[1], 10);

  return null;
}

// 한 문장에 홈런 언급이 있는지.
function mentionsHomer(sentence: string): boolean {
  return /홈런|아치/.test(sentence) || /[1-4]\s*점\s*포/.test(sentence) || /솔로\s*포/.test(sentence);
}

/**
 * "만루 + 비(非)만루홈런" 산술 모순이 있으면 true.
 *
 * 판정: 한 문장에 '만루'가 등장하고, 그 문장이 만루홈런(그랜드슬램)이 *아닌*
 * 홈런을 명시적 득점 수(솔로/1~3점)와 함께 서술하면 모순.
 * - 만루홈런/그랜드슬램/4점 홈런 → 정상(통과).
 * - 득점 수를 알 수 없는 단순 "홈런" 언급은 추측을 피해 통과시킨다(오탐 방지).
 */
export function hasBaseRunnerContradiction(text: string): boolean {
  if (!text || !text.includes("만루")) return false;

  const sentences = text.split(SENTENCE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < sentences.length; i++) {
    if (!sentences[i].includes("만루")) continue;
    if (NON_SCORING_MANRU_RE.test(sentences[i])) continue; // 수비 위기·무산 → 득점 홈런과 무관

    // 만루가 등장한 문장 + 다음 문장까지 본다. 실제 요약은 만루 찬스를 한 문장으로
    // 깔고 다음 문장에서 홈런 득점을 서술하는 일이 잦다 (이번 사고의 turningPoint).
    const window = sentences.slice(i, i + 2).join(" ");
    if (GRAND_SLAM_RE.test(window)) continue; // 만루홈런 = 정상
    if (!mentionsHomer(window)) continue;

    const runs = homerRunCount(window);
    if (runs !== null && runs !== 4) return true; // 만루인데 4점이 아닌 홈런 → 모순
  }
  return false;
}
