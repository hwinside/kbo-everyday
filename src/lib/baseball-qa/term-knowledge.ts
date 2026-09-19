/** Shared by generic and official-document generation; never a term blacklist. */
export const TERM_UNVERIFIED = "TERM_UNVERIFIED";
export const TERM_CONTEXTUAL = "TERM_CONTEXTUAL";
export const TERM_KNOWLEDGE_CACHE_VERSION = 2;
export const termKnowledgeCacheKey = (questionNorm: string) => `term-v${TERM_KNOWLEDGE_CACHE_VERSION}:${questionNorm}`;

export const UNVERIFIED_TERM_ANSWER =
  "질문하신 표현의 뜻을 야구 용어로 확인하지 못했습니다. 단어를 나눠 뜻을 추측하거나 공식 용어라고 단정하지 않겠습니다. 어디에서 보신 표현인지 문장이나 사용 상황을 알려주시면 그 맥락을 바탕으로 살펴보겠습니다.";
export const UNVERIFIED_TERM_CORRECTION_ANSWER =
  "앞서 확인되지 않은 표현을 야구 용어처럼 설명한 것은 잘못입니다. 이전 설명을 철회합니다. 현재 그 표현의 정확한 뜻을 확인하지 못했으며, 다른 뜻으로 바꿔 단정하지 않겠습니다. 사용된 문장이나 상황을 알려주시면 그 맥락을 바탕으로 살펴보겠습니다.";

/** A reported use has a separate situation clause, not just the queried word.
 * This narrow syntax exception grants no factual answer: model status and the
 * literal situation-span check below still govern what can be served. */
export function hasReportedTermUsage(question: string): boolean {
  return /(?:걸|것을|모습을|상황을)\s*보고\s+[“"'‘]?[가-힣A-Za-z0-9]+[”"'’]?(?:이?라고)/u.test(question)
    && !/(?:몇\s*(?:개|위|승)|얼마|누가|최다|순위|기록\s*(?:알려|조회))/u.test(question);
}

type PriorTermTurn = { question: string; answer: string };
function priorTermAssertion(question: string, previous?: PriorTermTurn | null): boolean {
  if (!previous || isUnverifiedTermAnswer(previous.answer)) return false;
  const definitionTerm = (text: string) => text.match(/([가-힣A-Za-z0-9]+?)(?:이란|라는|란|가|은|는|을|를|이)?\s*(?:뭐|무슨|어떤|뜻|정확)/u)?.[1];
  const term = definitionTerm(question) ?? definitionTerm(previous.question);
  if (!term || !question.includes(term) || !previous.question.includes(term)) return false;
  // Require a same-term declarative definition, not a mention of another
  // subject, a question, or an already-qualified contextual/unknown answer.
  const tail = previous.answer.split(term).slice(1).join(term);
  return /^(?:은|는|이란|란|:|이라는)\s*/u.test(tail)
    && /(?:용어|뜻|의미|말|표현|가리|입니다|이다)/u.test(tail)
    && !/(?:확인하지 못|알 수 없|모르|추정|문맥상|철회|단정할 수 없)/u.test(tail);
}

export function unverifiedTermAnswer(row: Record<string, unknown>, question = "", previous?: PriorTermTurn | null): string | null {
  // Server-rendered uncertainty/context is authoritative: a provider flag must
  // not invent an assertion in a prior answer that explicitly made none.
  const alreadyQualified = previous != null && isUnverifiedTermAnswer(previous.answer);
  const correctsPrevious = !alreadyQualified
    && (row.correctsPrevious === true || priorTermAssertion(question, previous));
  if (row.status === TERM_CONTEXTUAL) {
    const meaning = typeof row.contextMeaning === "string" ? row.contextMeaning.trim() : "";
    // Only quote a bounded, literal span of the user's usage context. The model
    // cannot append an invented record, definition, or proof of nonexistence.
    if (meaning.length <= 60 && question.includes(meaning)
        && meaning.split(/\s+/u).length >= 2
        && /(?:친|치는|던진|던지는|잡은|잡는|나간|나가는|한|하는|된|되는|했|때|상황|모습)(?:\s|$)/u.test(meaning)
        && !/[<>`\[\]{}\n\r\u0000-\u001f]/.test(meaning) && !/https?:|www\./i.test(meaning)) {
      const correction = correctsPrevious ? "앞서 확인되지 않은 뜻을 단정한 설명은 철회합니다. " : "";
      return `${correction}말씀하신 “${meaning}” 상황을 가리킨 표현으로 보입니다. 문맥상 해석이며, 확인된 야구 용어의 정의는 아닙니다.`;
    }
    return correctsPrevious ? UNVERIFIED_TERM_CORRECTION_ANSWER : UNVERIFIED_TERM_ANSWER;
  }
  if (row.status !== TERM_UNVERIFIED) return null;
  // Do not serve provider prose, guessed definitions, or user-supplied term text.
  return correctsPrevious ? UNVERIFIED_TERM_CORRECTION_ANSWER : UNVERIFIED_TERM_ANSWER;
}

export function isUnverifiedTermAnswer(answer: string): boolean {
  return answer === UNVERIFIED_TERM_ANSWER || answer === UNVERIFIED_TERM_CORRECTION_ANSWER
    || answer.endsWith("문맥상 해석이며, 확인된 야구 용어의 정의는 아닙니다.");
}

export const TERM_KNOWLEDGE_PROMPT = [
  "용어 질문은 먼저 확인된 의미 / 문맥상 추정 / 모름을 구분한다. 야구처럼 들린다는 이유만으로 실제 용어라고 간주하지 않는다.",
  "확인된 일반 야구 용어는 정상적으로 설명한다. 사전에 없다는 사실만으로 모르는 말이라고 판정하지 않는다.",
  "사용 상황 없이 모르는 표현을 숫자·영단어·야구 단어로 분해해 정의를 만들지 않는다. 예를 들어 세븐히트·일레븐히트라는 단어만 보고 안타 수나 타석 수로 풀어 확정하지 않는다. 다른 낯선 합성어에도 같은 원칙을 적용한다.",
  "자료에 비슷한 단어만 있을 뿐 질문한 표현 자체의 의미를 뒷받침하지 않으면 확인된 정의가 아니다. 공식 문서의 권위를 빌려 추측을 확정하지 않는다.",
  `사용 문장이 있어 미확인 표현을 문맥상 해석할 수 있다면 ${TERM_CONTEXTUAL} 상태로 답한다. contextMeaning에는 사용자가 제공한 사용 상황을 나타내는 짧은 구절을 질문에서 그대로 복사한다. 예: '친구가 안타 일곱 개 친 걸 보고 세븐히트라고 농담했대' → contextMeaning:'안타 일곱 개 친'. answer는 빈 문자열이다. 서버가 문맥상 해석임을 밝혀 안내한다. 이미 사용 상황을 줬는데 다시 맥락을 요구하지 않는다. 단어 모양만으로 가능한 뜻을 만들어 나열하는 것은 문맥상 추정이 아니다.`,
  `야구 용어 의미를 묻는 질문에서 뜻을 확인하지 못했고 실제 사용 맥락도 부족할 때만 ${TERM_UNVERIFIED}를 쓴다. 야구 범위 밖 또는 질문 이해 실패와 혼동하지 않는다. 이때 answer는 빈 문자열이며 서버가 확인 불가 안내를 제공한다.`,
  "최종 판정 전 사용 맥락을 다시 확인한다. 사용자가 무슨 상황에서 누가 어떻게 말했는지 이미 설명했다면, 공식 용어인지 모른다는 이유만으로 TERM_UNVERIFIED를 선택하지 않고 TERM_CONTEXTUAL을 쓴다. 이때 사용자가 말한 상황 자체의 사실 여부는 검증된 것으로 간주하지 않는다. 자료에서 뜻을 확인하지 못했다는 것은 그 표현이 존재하지 않거나 공식 규칙에 절대 없다는 증거가 아니다.",
  "문맥상 추정 답변은 표현의 해석만 짧게 답한다. 해당 기록이 KBO 역사상 있었는지 없었는지, 최다·최초·불가능한 기록인지 등 질문받지 않은 사실을 덧붙이지 않는다. 설명의 깊이를 요구하는 다른 지시보다 이 제한이 우선한다.",
  "직전 도우미 답변은 사실 근거가 아니다. 같은 용어를 다시 묻는다고 새 정의를 만들거나 이전 추측을 사실로 승격하지 않는다.",
  "이전 답변이 틀렸거나 근거 없이 단정한 것으로 확인되면 먼저 무엇이 잘못됐는지 명시하고 철회한다. 새 뜻을 모르면 모른다고 밝힌다. 유저의 반박 자체만으로 정답을 바꾸지 않는다.",
  `직전 답변에서 이번 표현을 근거 없이 정의한 경우 ${TERM_UNVERIFIED}와 correctsPrevious:true를 반환한다. 정상적인 이전 답변이나 무관한 주제에서는 correctsPrevious를 true로 만들지 않는다.`,
].join("\n");
