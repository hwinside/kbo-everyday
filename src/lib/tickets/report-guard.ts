// 티켓 웃돈 신고 핵심 결정 로직 (2026-07-25) — 서버 라우트/클라이언트 UI가 공유하는 순수 함수.
// 신고 동선 회귀(취소/401/정상/중복/본인·없는 ticket/5xx)를 프로덕션 경로 그대로 검증하기 위해 분리한다.

export type TicketReportGuard = "ok" | "not_found" | "self";

/** 서버측 신고 허용 판정: 대상 존재 + 본인 글 자가신고 차단. */
export function evaluateTicketReportGuard(params: {
  ticket: { author_id: string } | null | undefined;
  reporterId: string;
}): TicketReportGuard {
  if (!params.ticket) return "not_found";
  if (params.ticket.author_id === params.reporterId) return "self";
  return "ok";
}

/** UI 신고 버튼 노출 여부: 작성자 없음/본인 글이면 미노출. */
export function canReportTicket(params: {
  ticketAuthorId: string | null | undefined;
  currentUserId: string | null | undefined;
}): boolean {
  if (!params.ticketAuthorId) return false;
  return params.currentUserId !== params.ticketAuthorId;
}

export type ReportSubmitOutcome =
  | { kind: "done" }
  | { kind: "error"; message: string };

export const REPORT_SUBMIT_FALLBACK_ERROR = "신고 접수에 실패했어요. 잠시 후 다시 시도해주세요";

/**
 * 클라이언트 신고 응답 판정: non-2xx 는 body 형태와 무관하게 실패 처리.
 * (HTTP 500 + `{}` 응답이 완료로 전환돼 "✅ 신고 접수됨" 오표시되는 것을 차단)
 */
export function resolveReportSubmitOutcome(params: {
  ok: boolean;
  body: { error?: string } | null | undefined;
}): ReportSubmitOutcome {
  if (!params.ok) {
    return { kind: "error", message: params.body?.error || REPORT_SUBMIT_FALLBACK_ERROR };
  }
  return { kind: "done" };
}
