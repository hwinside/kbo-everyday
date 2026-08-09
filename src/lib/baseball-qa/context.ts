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
/**
 * 입단(드래프트) 후속 전용 source allowlist.
 *
 * ⚠️ **global allowlist(`CONTEXT_SOURCE_ALLOWLIST`)를 열지 않는다**(삼순 2026-08-09 P0-2).
 *   일반 후속은 직전 "답변"을 LLM 맥락으로 주입하므로 rag 를 열면 근거 없는 후속 생성
 *   통로가 된다. 반면 입단 후속은 직전 턴의 **질문에서 선수 이름만** 재결속하고 답은
 *   공식 필드 코드 렌더로 낸다 — 직전 답변 본문을 생성에 쓰지 않으므로, 선수 질문이
 *   실제로 도달하는 source(`rag` 선수 서술형, `kbo_structured` 기록·입단 직접답)까지
 *   자격을 넓혀도 그 통로가 생기지 않는다.
 *   `team_rag`·`news_rag` 는 넣지 않는다 — 선수 entity 재결속 대상이 아니다(삼순 지시).
 */
export const DRAFT_CONTEXT_SOURCE_ALLOWLIST = [
  ...CONTEXT_SOURCE_ALLOWLIST, "rag", "kbo_structured",
] as const;

export function selectContextTurn(row: PreviousTurnRow | null | undefined): ContextTurn | null {
  return qualifyContextTurn(row, CONTEXT_SOURCE_ALLOWLIST);
}

/** 입단 후속 전용 — B1·B2·B5 barrier/TTL 은 동일, B3 allowlist 만 위 전용 집합이다. */
export function selectDraftContextTurn(row: PreviousTurnRow | null | undefined): ContextTurn | null {
  return qualifyContextTurn(row, DRAFT_CONTEXT_SOURCE_ALLOWLIST);
}

function qualifyContextTurn(
  row: PreviousTurnRow | null | undefined,
  allowlist: readonly string[],
): ContextTurn | null {
  // B1: 직전 user turn 자체가 없으면 맥락 없음 (새 대화 첫 질문 포함).
  if (!row) return null;
  const question = row.question?.trim() ?? "";
  const answer = row.answer?.trim() ?? "";
  if (question.length === 0 || answer.length === 0) return null;
  // B3: 자격은 job.source 축. allowlist 밖 값(blocked·error·unsure·limited·history_hold·신규값)은 제외.
  if (!row.jobSource || !allowlist.includes(row.jobSource)) {
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
