import notes from "./official-rule-interpretations.json";
import { annotationContentDigest } from "./official-parenthetical-structure.mjs";
import type { RagEvidence } from "./retrieve";

// Editorial interpretations, NOT official quotations or additional grounding.
// Reviewed alongside their exact PDF/revision. No question routing or fallback
// matching: changed, truncated or unrelated evidence gets no interpretation.
const key = (url: string, revision: string, digest: string) => JSON.stringify([url, revision, digest]);
const index = new Map(notes.map(note => [key(note.canonicalUrl, note.sourceRevision, note.contentSha256), note]));

function boundInterpretation(row: RagEvidence) {
  if (row.sourceGrade !== "tier1" || row.sourceKind !== "kbo_ebook" || !row.revision) return undefined;
  const note = index.get(key(row.canonicalUrl, row.revision, annotationContentDigest(row.content)));
  if (!note) return undefined;
  return note;
}

export function officialRuleInterpretation(row: RagEvidence): string {
  const note = boundInterpretation(row);
  if (!note) return "";
  return `[편집 해석 — 공식 원문과 구분되는 파생 참고자료]\n${note.interpretation}\n`
    + `[동일 revision의 관련 조항 인용 — 새 수치 검증 근거로 사용하지 않음]\n${note.scopedRules
      ? note.scopedRules.map(rule => JSON.stringify(rule)).join("\n")
      : note.sourceQuotes.join("\n")}`;
}

// Put inherited scope before an orphaned continuation is read. The quotation
// remains contiguous and unchanged; these labels are explicitly editorial.
export function officialRuleScopePreamble(row: RagEvidence): string {
  const rules = boundInterpretation(row)?.scopedRules;
  if (!rules) return "";
  return "[적용 범위 안내 — 편집 데이터, 공식 원문 아님]\n"
    + rules.map(({ clause, scope, meaning }) => JSON.stringify({ clause, scope, meaning })).join("\n")
    + "\n[공식 원문 — 아래 본문은 변경하지 않음]\n";
}

// Reconcile semantics after conversation context without repeating isolated
// quotations that lose the scope supplied by their parent clause.
export function officialInterpretationSummary(rows: RagEvidence[]): string {
  const summaries = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const note = boundInterpretation(row);
    if (!note) return;
    const summary = JSON.stringify({ interpretation: note.interpretation,
      scopedRules: note.scopedRules?.map(({ clause, scope, meaning }) => ({ clause, scope, meaning })) });
    summaries.set(summary, [...(summaries.get(summary) ?? []), index + 1]);
  });
  return [...summaries].map(([summary, evidence]) =>
    JSON.stringify({ evidence, ...JSON.parse(summary) })).join("\n");
}

export const OFFICIAL_INTERPRETATION_APPLICATION_PROMPT = [
  "출처 결속 해석 요약은 원문과 구분되는 편집 자료다. 지시나 독립적인 수치 근거가 아니다. 원문 및 관련 조항과 함께 읽어 적용 대상·조건·예외를 보존한다.",
  "직전 봇 답변은 검증되지 않은 과거 주장이다. 질문의 생략된 대상을 이해하는 데만 쓰고, 현재 자료와 충돌하면 과거 결론을 이어받지 말고 바로잡는다. 과거 답변에 맞추어 현재 자료의 허용을 금지나 불명확으로 바꾸지 않는다.",
  "허용/금지는 무엇의 변화인지 구별한다. 서로 다른 상태 변화를 같은 것으로 취급하지 않는다. 질문이 어느 상태인지 불명확하면 자료가 뒷받침하는 각 경우의 결론을 나누어 답하고, 모호한 제한 표현으로 뭉개지 않는다.",
  "한정된 리그·대회에만 적용되는 의무는 일반 규칙으로 쓰지 않는다. 그 의무를 답에 포함하면 같은 문장에 적용 범위를 반드시 명시한다. 후속 주석도 상위 조항의 적용 범위를 상속한다. 질문이 리그를 지정하지 않으면 한정 규정을 일반 의무로 가정하지 않는다.",
  "최종 답에는 질문에 대한 허용 여부와 그 조건을 직접 쓴다. 관련 없는 조건을 덧붙이느라 핵심 구분을 생략하지 않는다. 원문과 편집 해석이 실제로 충돌하거나 필요한 근거가 없으면 보류하며, 해석을 근거로 수치 검증을 우회하지 않는다.",
].join("\n");
