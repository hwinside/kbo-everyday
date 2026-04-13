import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";

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
  const { reporterId, targetType, targetId, reason, detail } = await req.json();

  if (!reporterId || !targetType || !targetId || !reason) {
    return NextResponse.json({ error: "필수 값 누락" }, { status: 400 });
  }

  const { error } = await supabase.from("reports").insert({
    reporter_id: reporterId,
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

  return NextResponse.json({ success: true });
}
