import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyAccessToken } from "@/lib/auth/verified-user";

const BUCKET = "photos";
const MAX_SIZE = 500 * 1024; // 500KB

/** 서버사이드 아바타 업로드 — service role로 RLS 우회 */
export async function POST(req: NextRequest) {
  // 1. 인증 확인 (dead-token 가드 경유 — 무효 토큰의 Supabase 호출 차단)
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = await verifyAccessToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. 파일 읽기
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File too large" }, { status: 400 });
  }

  // 3. service role로 업로드 (RLS 우회)
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const path = `avatars/${user.id}.jpg`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await adminClient.storage
    .from(BUCKET)
    .upload(path, buffer, {
      cacheControl: "0",
      upsert: true,
      contentType: "image/jpeg",
    });

  if (uploadError) {
    console.error("Avatar upload failed:", uploadError);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  // 4. public URL 반환
  const { data } = adminClient.storage.from(BUCKET).getPublicUrl(path);

  // 5. profiles 업데이트
  const avatarUrl = `custom:${data.publicUrl}`;
  await adminClient
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("id", user.id);

  return NextResponse.json({ url: data.publicUrl, avatarUrl });
}
