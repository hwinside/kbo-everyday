import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

export const runtime = "nodejs";

// CS 회신 초안을 저장하고, 하린아빠가 확인/발송할 1회용 링크를 발급한다.
// 호출 주체: cs-relay cron(삼식이). x-admin-pin 필요.
export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const csId = typeof body?.csId === "string" ? body.csId.trim() : "";
  const kind = body?.kind === "feedback" || body?.kind === "dm" ? body.kind : "";
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  const content = typeof body?.body === "string" ? body.body.trimEnd() : "";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId : null;
  const feedbackId =
    typeof body?.feedbackId === "number" && Number.isFinite(body.feedbackId)
      ? Math.trunc(body.feedbackId)
      : null;

  if (!csId || !kind || !userId || !content.trim()) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
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
