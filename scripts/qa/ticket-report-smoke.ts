// QA 스모크 — 티켓 웃돈 신고 핵심 동선 검증 (2026-07-25).
// 서버 라우트/클라이언트 UI가 실제로 호출하는 순수 함수를 그대로 검증한다.
import {
  evaluateTicketReportGuard,
  canReportTicket,
  resolveReportSubmitOutcome,
  REPORT_SUBMIT_FALLBACK_ERROR,
} from "../../src/lib/tickets/report-guard";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const AUTHOR = "author-uuid-1";
const OTHER = "reporter-uuid-2";

// ── 서버 가드: 없는 ticket 거부 ──
check("없는 ticket → not_found", evaluateTicketReportGuard({ ticket: null, reporterId: OTHER }) === "not_found");
check("undefined ticket → not_found", evaluateTicketReportGuard({ ticket: undefined, reporterId: OTHER }) === "not_found");

// ── 서버 가드: 본인 글 자가신고 거부 ──
check("본인 글 → self", evaluateTicketReportGuard({ ticket: { author_id: AUTHOR }, reporterId: AUTHOR }) === "self");

// ── 서버 가드: 정상 신고 허용 ──
check("타인 글 → ok", evaluateTicketReportGuard({ ticket: { author_id: AUTHOR }, reporterId: OTHER }) === "ok");

// ── UI 버튼 노출: 본인/작성자없음 미노출, 타인 노출 ──
check("본인 글 버튼 미노출", canReportTicket({ ticketAuthorId: AUTHOR, currentUserId: AUTHOR }) === false);
check("작성자 없음 버튼 미노출", canReportTicket({ ticketAuthorId: null, currentUserId: OTHER }) === false);
check("타인 글 버튼 노출", canReportTicket({ ticketAuthorId: AUTHOR, currentUserId: OTHER }) === true);
check("비로그인도 타인 글 버튼 노출", canReportTicket({ ticketAuthorId: AUTHOR, currentUserId: null }) === true);

// ── 클라 응답 판정: 정상 1건 done ──
check("200 → done", resolveReportSubmitOutcome({ ok: true, body: { } }).kind === "done");

// ── 클라 응답 판정: 5xx + {} 완료 미표시 (핵심 계약) ──
const r500 = resolveReportSubmitOutcome({ ok: false, body: {} });
check("500 + {} → error(완료 미표시)", r500.kind === "error");
check("500 fallback 메시지", r500.kind === "error" && r500.message === REPORT_SUBMIT_FALLBACK_ERROR);

// ── 클라 응답 판정: 401 미로그인 error ──
check("401 → error", resolveReportSubmitOutcome({ ok: false, body: { error: "인증이 필요합니다" } }).kind === "error");

// ── 클라 응답 판정: 409 중복 error(추가 표시 0) ──
const r409 = resolveReportSubmitOutcome({ ok: false, body: { error: "이미 신고한 게시물입니다" } });
check("409 중복 → error", r409.kind === "error");
check("409 서버 메시지 노출", r409.kind === "error" && r409.message === "이미 신고한 게시물입니다");

// ── 클라 응답 판정: 400 본인/없는 ticket 거부 error ──
check("404 없는 ticket → error", resolveReportSubmitOutcome({ ok: false, body: { error: "대상을 찾을 수 없습니다" } }).kind === "error");
check("400 본인 글 → error", resolveReportSubmitOutcome({ ok: false, body: { error: "본인 글은 신고할 수 없습니다" } }).kind === "error");

// ── body 파싱 실패(null)도 non-2xx면 error ──
check("non-2xx + null body → error", resolveReportSubmitOutcome({ ok: false, body: null }).kind === "error");

console.log(`\n티켓 웃돈 신고 스모크: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
