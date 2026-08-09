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
// ── 그래서 어휘가 아니라 **구조**로 판정한다 (삼순 2026-08-09 합의) ─────────
//   ① 비교 관계 표현이 있다        — 문법 부류라 닫힌 집합이다(어휘가 아니다)
//   ② 비교 조사를 단 토큰이 **정확히 하나**다
//        → 비교는 피연산자가 둘인데 문장에 하나뿐이다. 나머지 하나는 **직전 턴에서 와야만**
//          문장이 성립한다. 이게 "이 질문은 자기완결이 아니다" 의 구조적 증거다.
//   ③ 그 하나가 야구 용어다        — 판정은 호출자(pipeline)의 기존 SSOT 어휘에 위임한다.
//          여기서 어휘를 새로 나열하지 않는다.
//
//   `키움이랑 한화랑 어디가 강해?` 는 ②에서 걸린다(피연산자 2개 = 자기완결).
//   `날씨 비슷해?` 는 ③에서 걸린다. `도루가 뭐야?` 는 ①에서 걸린다.
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
 * 비교 조사 (②). 두 대상을 잇는 조사만 둔다.
 *
 * ⚠️ `보다`(`홈런보다 큰가?`)는 **넣지 않는다.** 그건 비교 조사가 맞지만 한 쪽만 있어도
 *   자기완결인 문장을 만든다(`작년보다 나아?`). 여기서는 "피연산자가 모자란다" 를 근거로
 *   쓰므로, 근거가 약한 조사를 넣으면 판정 자체가 무너진다.
 */
export const COMPARATIVE_PARTICLES = ["이랑", "랑", "하고", "과", "와"] as const;

/**
 * 비교 조사를 단 토큰들의 **어간**을 돌려준다. 조사가 없으면 빈 배열.
 *
 * ⚠️ 어간이 1글자면 버린다. `사과 비슷해?` 의 `사과` 는 `사`+`과` 로 갈라져 조사처럼
 *   보이는데, 1글자 어간을 인정하면 그런 오분해가 전부 통과한다.
 */
export function comparativeParticleStems(question: string): string[] {
  const tokens = question.normalize("NFKC").toLowerCase().match(/[가-힣a-z0-9+]+/g) ?? [];
  const stems: string[] = [];
  for (const token of tokens) {
    for (const particle of COMPARATIVE_PARTICLES) {
      if (!token.endsWith(particle) || token.length <= particle.length) continue;
      const stem = token.slice(0, token.length - particle.length);
      if (stem.length < 2) break;
      stems.push(stem);
      break; // 한 토큰은 조사 하나만 단다 — `이랑`/`랑` 중복 계수 방지
    }
  }
  return stems;
}

/** ① 비교 관계 표현이 있는가 */
export function hasComparativeRelation(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return COMPARATIVE_RELATION_STEMS.some((stem) => compact.includes(stem));
}

/**
 * **비교형 후속**인가 — ①②③ 전부 만족할 때만.
 *
 * @param isBaseballTerm 어간이 야구 용어인지 판정하는 호출자의 SSOT. 여기서 어휘를
 *   새로 나열하지 않기 위해 주입받는다(pipeline 의 기존 신호어 매칭을 그대로 쓴다).
 */
export function isComparativeFollowup(
  question: string,
  isBaseballTerm: (stem: string) => boolean,
): boolean {
  if (!hasComparativeRelation(question)) return false;
  const stems = comparativeParticleStems(question);
  // ② 피연산자가 정확히 하나 — 0이면 비교 대상이 없고, 2 이상이면 자기완결이다.
  if (stems.length !== 1) return false;
  return isBaseballTerm(stems[0]);
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
