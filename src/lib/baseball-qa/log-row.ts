import type { QaDeps } from "@/lib/baseball-qa/pipeline";

/**
 * Production 로그 INSERT 행을 만드는 SSOT.
 *
 * 🔴 직전 회차 결손(삼순 2026-08-13 ①): 게이트가 DB 에 **직접** INSERT 해서 "칸은 있고 CHECK 도
 *    통과"만 보았고, 정작 **서버가 그 칸을 채우는지**는 보지 않았다. 그래서 pipeline 이
 *    `correctionCandidate` 를 만들어도 Production INSERT 에 칸이 없어 실 DB 는 계속 null 인
 *    단절을 못 잡았다.
 *
 * 그래서 행 조립을 `server.ts`(Supabase 클라이언트를 모듈 로드 시점에 만든다) 밖으로 뺐다.
 * 게이트가 자격증명 없이 이 함수를 그대로 태워 실제 테이블에 넣고 대조할 수 있어야 한다.
 */
export function buildQuestionLogRow(
  entry: Parameters<NonNullable<QaDeps["log"]>>[0],
  messageId: number,
): Record<string, unknown> {
  return {
    user_id: entry.userId,
    question: entry.question,
    question_norm: entry.questionNorm,
    // LLM 정규화 관측 (migration 20260811210000): 교정문은 수용 행에만, status 는
    // 정규화가 호출된 모든 행에 채워진다 — null 만으로는 미호출·거절·오류를 구분할 수
    // 없어 발동률·오교정 감사의 분모를 못 만든다(삼순 2026-08-11 1차 ④).
    question_normalized: entry.questionNormalized ?? null,
    question_normalize_status: entry.normalizeStatus ?? null,
    // 제안만 한 후보는 **별도 칸**에 남긴다 (삼순 2026-08-13 ③). `question_normalized` 에
    // 섞으면 "이 문장으로 답했다"와 "제안만 했다"가 구분되지 않아 오교정 감사의 분모가
    // 무너진다.
    question_correction_candidate: entry.correctionCandidate ?? null,
    // 생성 RAG 톤은 **관측값**이다. false 여도 답변은 서빙된다 — 이 칸으로 프롬프트
    // 준수율을 감사한다. null = 서빙된 생성 RAG 답변 없음/판정불가(비생성 경로 + 안전검증 탈락 폐기).
    tone_compliant: entry.toneCompliant ?? null,
    // 생성 RAG 답변이 **폐기된 사유** (migration 20260816140000). null = 폐기 없음.
    // 관측 전용이다 — 이 칸으로 "숫자 전면 HOLD 가 정답을 얼마나 함께 버리는가"의 분모를 만든다.
    // 종전에는 폐기가 전부 match_path='unsure' 로만 남아 JSON 깨짐·길이초과·숫자가드가
    // 구분되지 않았고, 그래서 정책 손익을 수치로 말할 수 없었다(2026-08-16 하린아빠 지시).
    rag_discard_reason: entry.ragDiscardReason ?? null,
    // 생성 RAG 를 **시도한 경로** (삼순 2026-08-16 ①). 성공·폐기 모두 채운다 — 폐기에만
    // 채우면 분자만 있고 분모가 없어 경로별 폐기율을 몇 낼 수 없다. `match_path` 로는 복원
    // 불가하다(선수·공식·뉴스 폐기가 전부 'unsure' 로 접힌다).
    rag_attempt_path: entry.ragAttemptPath ?? null,
    // **질문**의 숫자 토큰 개수 (삼순 2026-08-16 2차 ①). 성공·폐기 모두 채운다(분모).
    // ⚠️ 개수에는 값 동일성이 없다 — `질문=0·답변>0` 은 "질문 비기원 숫자" 까지만 확정되고
    //    (근거에서 복사했을 수 있어 출처·정확성 미판정), `질문>0·답변>0` 은 **미확정**이다
    //    (삼순 3·4차). `창작/지어냄/근거에 없음` 은 전부 표본 감사 영역.
    rag_question_numeric_count: entry.ragQuestionNumericCount ?? null,
    // 폐기된 답변의 숫자 토큰 **개수**만 (삼순 익명집계 조건). 본문·값은 저장하지 않는다.
    rag_discard_numeric_count: entry.ragDiscardNumericCount ?? null,
    match_path: entry.matchPath,
    answer: entry.answer,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    // 질문 쪽지 id 로 로그를 exact 결속한다. 종전에는 (user, question_norm, created_at) 뿐이라
    // 같은 질문을 두 번 하면 두 로그가 구분되지 않았고, 피드백을 붙이려면 시간창 추정을
    // 해야 했다. 추정 결속은 오적재를 만든다.
    question_message_id: messageId,
  };
}
