// 야잘알봇 멀티턴 맥락 선정 (spec: specs/baseball-genius-v2-hybrid-rag.md §4.1 B1~B5)
// 후속 질문("또 다른 경우는?")이 blocked로 떨어지던 버그를 exact 계약으로 해소한다.
// DB 접근은 server.ts가 RPC로 수행하고, 여기서는 그 결과 1행을 순수 판정한다.

/** 소스 turn 자격 = genius_question_jobs.source allowlist (B3, fail-closed) */
export const CONTEXT_SOURCE_ALLOWLIST = ["dictionary", "cache", "llm"] as const;

/** TTL 기준 = 소스 turn의 answer DM created_at (B5). 600.000초 유효 / 600.001초 만료. */
export const CONTEXT_TTL_MS = 600_000;

/**
 * 후속 문법 폐쇄집합 (B4, 단일 SSOT).
 * 정규화 후 full-string 완전일치만 후속으로 통과한다. substring·의미분석은 금지.
 * 집합 변경 시 AC(§4.3)도 함께 갱신한다.
 */
export const FOLLOWUP_PHRASES = [
  "또", "또?", "또요", "또 있어", "또 있어?",
  "또 다른 경우는", "또 다른 경우는?", "다른 경우는", "다른 경우는?",
  "더 있어", "더 있어?", "더",
  "그럼", "그럼?", "그건", "그건?", "그것도", "그것도?",
  "왜", "왜?",
  "예를 들면", "예를 들면?", "예시",
  "자세히", "자세히 설명해줘",
  "위 내용과 똑같은 질문입니다",
] as const;

/** 앞뒤 공백 제거 · 중복 공백 축약 · 문말 구두점(?!.…~) 제거 · NFC (B4) */
export function normalizeFollowup(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.…~]+$/, "")
    .trim();
}

const FOLLOWUP_SET = new Set(FOLLOWUP_PHRASES.map(normalizeFollowup));

/** 폐쇄집합 full-string 완전일치 여부 (B4) */
export function isFollowupPhrase(question: string): boolean {
  return FOLLOWUP_SET.has(normalizeFollowup(question));
}

// ─────────────────────────────────────────────────────────────────────────────
// 비교형 후속 (2026-08-09 하린아빠 제보, Production 재현)
//
//   Q1 유저: `그랜드슬램이 뭐야?`      봇: (그랜드슬램 설명)
//   Q2 유저: `만루홈런이랑 비슷한 거야?`  봇: ❌ 새 질문으로 끊겨 엉뚱한 답
//
// 정상 답은 "네, 주자가 만루일 때 친 홈런을 그랜드슬램이라고 해요" 다. 유저는 한 주제를
// 이어서 묻고 있는데 우리가 대화를 끊었다.
//
// ── 왜 `FOLLOWUP_PHRASES` 로는 안 되는가 ──────────────────────────────────
//   그 집합은 **full-string 완전일치**다(`또`·`왜`·`자세히`). 비교형은 문장 안에 새 용어를
//   데리고 오므로 완전일치가 원리적으로 불가능하다. 문구를 몇 개 더 넣는 방식은
//   `비슷한 거야`·`비슷해`·`비슷한가요`… 로 끝없이 벌어진다 — #1135 에서 규칙을 여섯 번
//   갈아엎고 얻은 교훈이라 같은 실수를 하지 않는다.
//
// ── 그래서 어휘가 아니라 **구조**로 판정한다 (삼순 2026-08-09 판정 확정) ─────
//   ① 비교 관계 표현이 있다        — 문법 부류라 닫힌 집합이다(어휘가 아니다)
//   ② 문장 전체의 **canonical 명시 야구 엔티티가 정확히 하나**다
//        (또는 엔티티 0개 + `그거/그것` 명시 지시어)
//        → 비교는 피연산자가 둘이다. 명시 엔티티가 하나뿐이면 나머지 하나는
//          **직전 턴에서 와야만** 문장이 성립한다. 엔티티가 둘 이상이면 문장 안에서
//          이미 완결된 비교라 직전 턴이 필요 없다(자기완결).
//   ③ 엔티티 판정은 호출자(pipeline)의 canonical SSOT(검수 사전·구단·룰 용어)에 위임한다.
//        여기서 어휘를 새로 나열하지 않는다.
//
//   ⚠️ 왜 "비교 조사 수"가 아닌가 — 1차 구현이 그 축이었고 삼순 반례로 기각됐다:
//     `그랜드슬램은 만루홈런이랑 비슷해?` 는 조사(`이랑`)가 1개지만 엔티티가 2개라
//     자기완결이다. 조사 수는 피연산자 수의 증거가 되지 못한다.
//
//   `그랜드슬램하고 만루홈런 차이는?` 는 ②에서 걸린다(엔티티 2개 = 자기완결).
//   `날씨랑 비슷해?` 는 ②에서 걸린다(엔티티 0 + 지시어 없음). `도루가 뭐야?` 는 ①에서 걸린다.
//   `그거랑 만루홈런 차이?` 는 통과한다(엔티티 1 + 지시어 — 직전 턴이 있어야 완성된다).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 비교 관계 표현 (①). **문법 부류**라 닫혀 있다 — 야구 어휘가 아니므로 발산하지 않는다.
 * 활용형은 어간으로 둔다(`비슷` 이 `비슷한/비슷해/비슷한가요` 를 모두 덮는다).
 */
export const COMPARATIVE_RELATION_STEMS = [
  "비슷", "같은", "같아", "같나", "같습니까", "동일",
  "차이", "다른", "달라", "다르",
  "구분", "구별",
] as const;

/**
 * 명시 지시어 (②의 보조축). `그거랑 비슷해?` 처럼 지시어가 직전 턴을 **명시적으로**
 * 가리킬 때만 엔티티 0개를 허용한다. 지시어 없는 엔티티 0개(`뭐가 비슷해?`)는 무엇을
 * 비교하자는 것인지조차 없으므로 후속으로 잡지 않는다.
 */
export const COMPARATIVE_DEMONSTRATIVES = ["그거", "그것", "그게", "그건", "이거", "이것"] as const;

/** ②의 보조축 — 명시 지시어가 있는가 */
export function hasComparativeDemonstrative(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return COMPARATIVE_DEMONSTRATIVES.some((word) => compact.includes(word));
}

/** ① 비교 관계 표현이 있는가 */
export function hasComparativeRelation(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return COMPARATIVE_RELATION_STEMS.some((stem) => compact.includes(stem));
}

/**
 * 비교 조사 — 피연산자 stem 을 뽑는 용도다(판정 근거가 아니라 **operand 열거** 근거).
 * `보다` 는 한 쪽만으로 자기완결 문장을 만들므로 넣지 않는다.
 */
export const COMPARATIVE_PARTICLES = ["이랑", "하고", "랑", "과", "와"] as const;

/**
 * 질문형 target — 비교의 상대가 **의문사로 명시**된 형태(`한화랑 뭐가 비슷해?`).
 * 상대를 물었으니 직전 턴에서 받아올 자리가 없다 = 자기완결이다(삼순 2026-08-09 4차).
 * `차이가 뭐야` 의 `뭐야` 는 target 이 아니라 술어이므로 집합에 넣지 않는다.
 */
export const INTERROGATIVE_OPERANDS = [
  "누가", "누구", "어디가", "어디랑", "뭐가", "무엇이", "어느게", "어느팀",
] as const;

export interface ComparativeOperandStem {
  start: number;
  end: number;
  text: string;
}

/**
 * 비교 조사가 붙은 피연산자 stem 들 — **어휘 유형과 무관하게** 전부 연다.
 * `한화랑 애플이랑` 에서 `애플` 은 야구 엔티티가 아니지만 명시 피연산자다.
 * 위치(start/end)는 `NFKC·lowercase·공백 유지` 정규화 기준이다(엔티티 span 과 동일 좌표계).
 */
export function comparativeOperandStems(question: string): ComparativeOperandStem[] {
  const normalized = question.normalize("NFKC").toLowerCase();
  const stems: ComparativeOperandStem[] = [];
  for (const match of normalized.matchAll(/[가-힣a-z0-9]+/g)) {
    const token = match[0];
    for (const particle of COMPARATIVE_PARTICLES) {
      if (!token.endsWith(particle) || token.length <= particle.length) continue;
      const stem = token.slice(0, token.length - particle.length);
      // 1글자 stem 은 오분해다(`사과` → `사`+`과`).
      if (stem.length < 2) break;
      stems.push({ start: match.index, end: match.index + stem.length, text: stem });
      break;
    }
  }
  return stems;
}

/**
 * **비교형 후속**인가 — ①관계 표현 + ②typed 비교 operand 판정(삼순 2026-08-09 4차 확정).
 *
 * ⚠️ `canonical 야구 엔티티 1개 = 피연산자 1개` 전제는 틀렸다(삼순 정정). 피연산자는
 *   야구 어휘가 아니어도 명시될 수 있다(`한화랑 애플이랑 비슷해?` 의 `애플`,
 *   `LG화학이랑 한화랑 차이?` 의 `LG화학`). 그래서 **operand 를 typed 로 센다**:
 *
 *     • 비교 조사 stem — 어휘 유형 무관 전부 명시 피연산자 (지시어 stem 만 anaphoric)
 *     • canonical 야구 엔티티 span — 조사 없이 놓인 대상(`그랜드슬램은 …`)도 피연산자
 *     • 질문형 target(`뭐가`·`누가`) — 상대를 물었으면 받아올 자리가 없다
 *
 *   후속은 **명시 피연산자가 1개뿐이고 그것이 야구 엔티티이며**, 나머지 자리가
 *   지시어이거나 생략됐을 때만 연다. 그 외는 전부 자기완결 = 맥락 0.
 *
 * @param getCanonicalEntitySpans 문장의 canonical 야구 엔티티 span(위치 포함)을 주는
 *   호출자의 SSOT(pipeline — 검수 사전·구단·로스터·룰 용어). 좌표계는
 *   `NFKC·lowercase·공백 유지` 로 operand stem 과 동일하다.
 */
export function isComparativeFollowup(
  question: string,
  getCanonicalEntitySpans: (question: string) => Array<{ start: number; end: number }>,
): boolean {
  if (!hasComparativeRelation(question)) return false;
  const spans = getCanonicalEntitySpans(question);
  // 야구 엔티티 2개 이상 = 문장 안에서 완결된 비교.
  if (spans.length >= 2) return false;
  const stems = comparativeOperandStems(question);
  const demonstratives = COMPARATIVE_DEMONSTRATIVES as readonly string[];
  const explicitStems = stems.filter((stem) => !demonstratives.includes(stem.text));
  // ⚠️ "명시 stem 2개면 차단" 가드는 두지 않는다 — mutation 실측으로 동등변이였다.
  //   stem 2개가 전부 야구면 spans>=2 가, 야구+비야구 조합은 아래 규칙이, 비야구 2개는
  //   최종 분기(spans==1 아님·지시어 없음)가 이미 닫는다. #1110 원칙대로 죽은 가드는 삭제.
  // 비야구 명시 stem + 야구 엔티티 = 피연산자 둘 다 명시 — `한화랑 애플이랑 비슷해?`·`애플이랑 한화 차이?`.
  const overlapsEntity = (stem: ComparativeOperandStem) =>
    spans.some((span) => stem.start < span.end && span.start < stem.end);
  const explicitNonBaseball = explicitStems.filter((stem) => !overlapsEntity(stem));
  if (explicitNonBaseball.length >= 1 && spans.length >= 1) return false;
  // 질문형 target 이 명시돼 있고 상대 피연산자도 명시돼 있으면 자기완결 — `한화랑 뭐가 비슷해?`.
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const hasInterrogativeTarget = INTERROGATIVE_OPERANDS.some((word) => compact.includes(word));
  if (hasInterrogativeTarget && (spans.length >= 1 || explicitStems.length >= 1)) return false;
  // 야구 엔티티 1개 + 나머지 자리 생략/지시어 → 직전 턴에서 와야 성립.
  if (spans.length === 1) return true;
  // 엔티티 0개는 명시 지시어(`그거랑 비슷해?`)가 직전 턴을 가리킬 때만 후속이다.
  return hasComparativeDemonstrative(question);
}

/** RPC baseball_genius_previous_turn 이 돌려주는 직전 user turn 1행 (B2). */
export interface PreviousTurnRow {
  /** 직전 user turn 질문 본문 */
  question: string | null;
  /** 그 turn의 답변 DM 본문 (dedup_key='baseball-genius:'||q.id) */
  answer: string | null;
  /** genius_question_jobs.source (job 미존재 시 null) */
  jobSource: string | null;
  /** answer DM created_at — 답변 DM이 실존할 때만 채워진다 */
  answeredAt: string | null;
  /** 현재 질문 created_at */
  currentCreatedAt: string | null;
}

/** LLM 컨텍스트로 주입할 소스 turn 1개 */
export interface ContextTurn {
  question: string;
  answer: string;
}

/**
 * 직전 user turn 1행을 §4.1 B1~B3·B5 자격으로 판정한다.
 * 부적격이면 과거로 폴백하지 않고 맥락 없음(null)으로 종료한다 — 중간 turn은 barrier(B1).
 */
export function selectContextTurn(row: PreviousTurnRow | null | undefined): ContextTurn | null {
  // B1: 직전 user turn 자체가 없으면 맥락 없음 (새 대화 첫 질문 포함).
  if (!row) return null;
  const question = row.question?.trim() ?? "";
  const answer = row.answer?.trim() ?? "";
  if (question.length === 0 || answer.length === 0) return null;
  // B3: 자격은 job.source 축. allowlist 밖 값(blocked·error·unsure·limited·history_hold·신규값)은 제외.
  if (!row.jobSource || !(CONTEXT_SOURCE_ALLOWLIST as readonly string[]).includes(row.jobSource)) {
    return null;
  }
  // B2: 답변 DM이 실제 존재할 때만 소스 자격 (job이 completed여도 미발송이면 제외).
  if (!row.answeredAt || !row.currentCreatedAt) return null;
  const answeredAtMs = Date.parse(row.answeredAt);
  const currentMs = Date.parse(row.currentCreatedAt);
  if (!Number.isFinite(answeredAtMs) || !Number.isFinite(currentMs)) return null;
  // B2: 역순/in-flight 방어 — 답변이 현재 질문보다 늦으면 소스 아님.
  if (answeredAtMs >= currentMs) return null;
  // B5: TTL 초과면 맥락 없음 (600.000초 유효 / 600.001초 만료).
  if (currentMs - answeredAtMs > CONTEXT_TTL_MS) return null;
  return { question, answer };
}
