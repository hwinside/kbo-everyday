import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { OPERATOR_USER_ID } from "@/lib/constants/operator";
import { getVerifiedUserIdFromCookies } from "@/lib/auth/verified-user";

const BUCKET = "photos";
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// 유저→운영자 쪽지 이미지 업로드.
// 클라 직접 업로드는 photos/dm/* Storage RLS(403)에 막히므로, 로그인 유저(쿠키 세션)를
// 검증한 뒤 service role로 photos/dm/ 경로에 저장하고 공개 URL을 반환한다.
// 첨부는 운영팀과의 대화에서만 허용(유저↔유저 DM은 범위 외)이다.
// 신규 draft는 targetUserId만 검증해 업로드하며 방은 만들지 않는다.
export async function POST(req: NextRequest) {
  // 쿠키 직접파싱 → dead-token guard 경유(만료/폐기 세션은 /auth/v1/user 미도달).
  const userId = await getVerifiedUserIdFromCookies();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const conversationId = formData.get("conversationId");
  const targetUserId = formData.get("targetUserId");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const ext = EXT_BY_TYPE[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "이미지 파일(jpg/png/webp/gif)만 가능합니다" },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "파일이 너무 큽니다 (최대 5MB)" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  if (typeof conversationId === "string" && conversationId) {
    // 기존 대화 참가자 검증: 요청 유저가 구성원이고 상대가 운영팀인지 확인.
    const { data: conv } = await admin
      .from("dm_conversations")
      .select("user1_id, user2_id")
      .eq("id", conversationId)
      .single();
    if (!conv) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    const members = [conv.user1_id, conv.user2_id];
    if (!members.includes(userId) || !members.includes(OPERATOR_USER_ID)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (targetUserId === OPERATOR_USER_ID && userId !== OPERATOR_USER_ID) {
    // query-guard: bounded -- 양방향 exact user_id 조합의 존재 여부 1건만 확인한다.
    const { data: blocked } = await admin
      .from("user_blocks")
      .select("id")
      .or(`and(blocker_id.eq.${userId},blocked_id.eq.${OPERATOR_USER_ID}),and(blocker_id.eq.${OPERATOR_USER_ID},blocked_id.eq.${userId})`)
      .limit(1);
    if (blocked?.length) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = `dm/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, buffer, {
    cacheControl: "31536000",
    upsert: false,
    contentType: file.type,
  });
  if (uploadError) {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
