// AI 경기 요약 내부 논리 검증 헬퍼.
// 박스스코어/라인스코어만 받은 요약에서 주자·아웃·타석 순서 같은
// 플레이 바이 플레이 세부 장면을 만들거나 야구 산술과 맞지 않는 문장을 reject한다.

const SENTENCE_SPLIT_RE = /(?<=[.!?。！？…])\s+|\n+/;

const BASE_OUT_DETAIL_RE =
  /(?:무사|노아웃|1사|일사|2사|이사|원아웃|투아웃|만루|[123]루|[1-3]\s*[,·-]\s*[1-3]루|득점권)/;

const PLAY_SEQUENCE_RE =
  /(?:연속\s*(?:안타|출루|볼넷|홈런)|진루타|희생(?:번트|플라이)|땅볼|뜬공|병살|폭투|포일)/;

const THREE_RUN_HOMER_RE =
  /(?:3\s*점\s*(?:홈런|포)|스리런|쓰리런|three[-\s]?run)/i;

const GRAND_SLAM_RE = /(?:만루\s*(?:홈런|포)|그랜드슬램)/;

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectText(item, out);
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map(s => s.trim())
    .filter(Boolean);
}

export function findSummaryLogicIssues(summary: Record<string, unknown>): string[] {
  const issues = new Set<string>();
  const sentences = collectText(summary).flatMap(splitSentences);

  for (const sentence of sentences) {
    const compact = sentence.replace(/\s+/g, "");

    if (compact.includes("만루") && THREE_RUN_HOMER_RE.test(compact)) {
      issues.add("bases-loaded three-run homer contradiction");
    }

    if (BASE_OUT_DETAIL_RE.test(sentence)) {
      issues.add("unsupported base/out play detail");
    }

    if (PLAY_SEQUENCE_RE.test(sentence)) {
      issues.add("unsupported play sequence detail");
    }

    if (GRAND_SLAM_RE.test(sentence) && THREE_RUN_HOMER_RE.test(sentence)) {
      issues.add("grand slam run value contradiction");
    }
  }

  return [...issues];
}
