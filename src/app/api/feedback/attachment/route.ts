import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

const ALLOWED_MIME = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DURATION = 30; // seconds
const VIDEO_TYPES = ["bug", "feature"];

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const { feedbackId, storagePath, mimeType, fileSize, durationSec } = await req.json();

  if (!feedbackId || !storagePath || !mimeType) {
    return NextResponse.json({ error: "필수 값 누락" }, { status: 400 });
  }

  if (!ALLOWED_MIME.includes(mimeType)) {
    return NextResponse.json({ error: "허용되지 않는 파일 형식입니다" }, { status: 400 });
  }

  if (fileSize > MAX_SIZE) {
    return NextResponse.json({ error: "50MB 이하만 가능합니다" }, { status: 400 });
  }

  if (durationSec > MAX_DURATION) {
    return NextResponse.json({ error: "30초 이하만 가능합니다" }, { status: 400 });
  }

  // Verify storagePath prefix matches user/feedback ownership
  // Prevents registering arbitrary files to get admin signed URL access
  const verified_id = verified.user.id;
  const expectedPrefix = `${verified_id}/${feedbackId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "잘못된 파일 경로입니다" }, { status: 400 });
  }

  // Verify feedback belongs to user and type allows video
  const { data: feedback, error: fbError } = await supabase
    .from("feedback")
    .select("id, user_id, type")
    .eq("id", feedbackId)
    .single();

  if (fbError || !feedback) {
    return NextResponse.json({ error: "피드백을 찾을 수 없습니다" }, { status: 404 });
  }

  if (feedback.user_id !== verified.user.id) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  if (!VIDEO_TYPES.includes(feedback.type)) {
    return NextResponse.json({ error: "이 피드백 유형은 영상 첨부를 지원하지 않습니다" }, { status: 400 });
  }

  // Check no existing attachment (1개 제한)
  const { count } = await supabase
    .from("feedback_attachments")
    .select("*", { count: "exact", head: true })
    .eq("feedback_id", feedbackId);

  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: "이미 첨부 파일이 있습니다" }, { status: 409 });
  }

  const { data: attachment, error } = await supabase
    .from("feedback_attachments")
    .insert({
      feedback_id: feedbackId,
      user_id: verified.user.id,
      file_type: "video",
      mime_type: mimeType,
      storage_path: storagePath,
      file_size: fileSize,
      duration_sec: durationSec,
    })
    .select("id")
    .single();

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ success: true, attachmentId: attachment.id });
}
