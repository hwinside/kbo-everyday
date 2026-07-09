import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import { verifyDraftTarget } from "@/lib/cs/verify-draft-target";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

export const runtime = "nodejs";

// CS 회신 초안을 저장하고, 하린아빠가 확인/발송할 1회용 링크를 발급한다.
// 호출 주체: cs-relay cron(삼식이). x-admin-pin 필요.
export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const csId = typeof body?.csId === "string" ? body.csId.trim() : "";
  const kind = body?.kind === "feedback" || body?.kind === "dm" ? body.kind : "";
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const content = typeof body?.body === "string" ? body.body.trimEnd() : "";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : null;
  // feedback.id 는 uuid(text). 숫자 아님.
  const feedbackId =
    typeof body?.feedbackId === "string" && body.feedbackId.trim()
      ? body.feedbackId.trim()
      : null;

  if (!csId || !kind || !userId || !content.trim()) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // 원본 CS 건(feedback 소유자 / dm 대화 참여자)과 userId가 실제로 일치하는지 검증.
  // 이게 없으면 잘못된 payload 하나로 "A 유저에게 발송 + B feedback resolved" 상태가 생길 수 있다.
  const isValidTarget = await verifyDraftTarget(admin, kind, userId, conversationId, feedbackId, systemUserId);
  if (!isValidTarget) {
    return NextResponse.json({ error: "target_mismatch" }, { status: 400 });
  }

  const token = randomBytes(24).toString("base64url");

  const { data, error } = await admin
    .from("cs_reply_drafts")
    .insert({
      token,
      cs_id: csId,
      kind,
      user_id: userId,
      conversation_id: conversationId,
      feedback_id: feedbackId,
      body: content,
    })
    .select("id, token")
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "insert_failed", detail: error?.message }, { status: 500 });
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan").replace(/\/$/, "");
  return NextResponse.json({
    ok: true,
    draftId: data.id,
    token: data.token,
    url: `${base}/api/cs/approve/${data.token}`,
  });
}
