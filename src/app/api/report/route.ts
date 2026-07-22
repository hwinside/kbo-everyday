import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

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
