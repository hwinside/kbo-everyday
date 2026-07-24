import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { sendAdminPush } from "@/lib/admin/push";
import { evaluateTicketReportGuard } from "@/lib/tickets/report-guard";

// AI 필터 — 간단한 금칙어 체크 (추후 LLM 연동)
const BLOCKED_WORDS = [
  "시발", "씨발", "좆", "병신", "미친놈", "꺼져",
  "ㅅㅂ", "ㅂㅅ", "ㅈㄹ", "ㅆㅂ",
];

export function checkContent(text: string): { blocked: boolean; reason?: string } {
  const lower = text.toLowerCase();
  for (const word of BLOCKED_WORDS) {
    if (lower.includes(word)) {
      return { blocked: true, reason: `금칙어 포함: ${word}` };
    }
  }
  return { blocked: false };
}

// POST: 신고
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { targetType, targetId, reason, detail } = await req.json();

  if (!targetType || !targetId || !reason) {
    return NextResponse.json({ error: "필수 값 누락" }, { status: 400 });
  }

  // 티켓 웃돈 신고: 대상 존재 + 본인 글 신고 차단(UI 우회 호출까지 방어, 2026-07-25)
  if (targetType === "ticket") {
    const { data: ticket, error: ticketErr } = await supabase
      .from("ticket_transfers")
      .select("author_id")
      .eq("id", targetId)
      .maybeSingle();
    if (ticketErr) return supabaseErrorResponse(ticketErr);
    const guard = evaluateTicketReportGuard({ ticket, reporterId: verified.user.id });
    if (guard === "not_found") {
      return NextResponse.json({ error: "대상을 찾을 수 없습니다" }, { status: 404 });
    }
    if (guard === "self") {
      return NextResponse.json({ error: "본인 글은 신고할 수 없습니다" }, { status: 400 });
    }
  }

  const { error } = await supabase.from("reports").insert({
    reporter_id: verified.user.id,
    target_type: targetType,
    target_id: targetId,
    reason,
    detail,
  });

  if (error) {
    return supabaseErrorResponse(error, {
      "23505": { status: 409, message: "이미 신고한 게시물입니다" },
    });
  }

  // 티켓 신고는 auto_blind 트리거(post/comment/chat 전용) 대상이 아니라 조용히 누적되므로
  // 운영자에게 즉시 알림(best-effort — 실패해도 신고 접수엔 영향 없음). 조회는 /admin/reports.
  if (targetType === "ticket") {
    try {
      await sendAdminPush({
        title: "티켓 웃돈 신고 접수",
        body: `양도글 #${targetId} 신고 (사유: ${String(reason).slice(0, 40)})`,
        url: "/admin/reports",
        tag: "admin-report",
      });
    } catch {
      /* ignore */
    }
  }

  // 신고 3회 누적 시 자동 블라인드 + outbox 적재는 DB 트리거(auto_blind_on_report)가
  // 이 insert 와 같은 트랜잭션에서 수행한다. 댓글은 결과를 반환해 열린 시트/카드 수를 즉시 맞춘다.
  let hidden = false;
  if (targetType === "comment") {
    const { data: comment } = await supabase
      .from("comments")
      .select("is_hidden")
      .eq("id", targetId)
      .maybeSingle();
    hidden = comment?.is_hidden === true;
  }
  return NextResponse.json({ success: true, hidden });
}
