import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import { getMessaging } from "firebase-admin/messaging";
import { initializeApp, getApps, cert } from "firebase-admin/app";

// 어드민 수동 FCM 푸시 발송 (S1 테스트용 — iOS/Android 네이티브 디바이스).
// 웹 Web Push는 기존 /api/push/send(VAPID) 유지.
// 자격증명: FIREBASE_SERVICE_ACCOUNT env (Firebase 콘솔 → 서비스 계정 → 비공개 키 JSON)

function getFcm() {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getMessaging();
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fcm = getFcm();
  if (!fcm) {
    return NextResponse.json({ error: "FIREBASE_SERVICE_ACCOUNT not configured" }, { status: 500 });
  }

  const { title, body, url, userIds } = await req.json();
  if (!title || !body) {
    return NextResponse.json({ error: "title and body required" }, { status: 400 });
  }

  let query = supabase.from("device_push_tokens").select("fcm_token");
  if (userIds?.length) query = query.in("user_id", userIds);

  const { data: rows } = await query;
  const tokens = (rows ?? []).map((r: { fcm_token: string }) => r.fcm_token);
  if (tokens.length === 0) return NextResponse.json({ sent: 0, failed: 0 });

  const res = await fcm.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: url ? { url } : undefined,
  });

  // 무효 토큰 정리 (앱 삭제/토큰 만료)
  const invalid: string[] = [];
  res.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
      invalid.push(tokens[i]);
    }
  });
  if (invalid.length > 0) {
    await supabase.from("device_push_tokens").delete().in("fcm_token", invalid);
  }

  return NextResponse.json({ sent: res.successCount, failed: res.failureCount, cleaned: invalid.length });
}
