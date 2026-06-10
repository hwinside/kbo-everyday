import { getMessaging } from "firebase-admin/messaging";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { DEFAULT_PREFS, type PrefKey } from "@/lib/notifications/prefs";

// FCM 발송 공용 헬퍼 (push-notifications-v1 S3).
// 디스패처(/api/notifications/dispatch)와 어드민 수동 발송(/api/admin/push/send-fcm)이 공용.

export function getFcm() {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getMessaging();
}

export interface PushPayload {
  title: string;
  body: string;
  /** 알림 탭 시 이동할 앱 내 경로 (예: "/community?post=123") */
  url?: string;
}

/**
 * 대상 유저들에게 FCM 발송.
 * - prefKey 지정 시 notification_prefs로 필터 (row 없음 = 디폴트)
 * - 토큰 500개 chunk + 무효 토큰 정리
 */
export async function sendFcmToUsers(
  userIds: string[],
  payload: PushPayload,
  prefKey?: PrefKey,
): Promise<{ sent: number; failed: number; cleaned: number; skipped: number }> {
  const fcm = getFcm();
  if (!fcm || userIds.length === 0) return { sent: 0, failed: 0, cleaned: 0, skipped: 0 };

  // 1. 알림 종류별 설정 필터 (row 없음 = 디폴트)
  // ⚠️ .in()에 id를 한 번에 넣으면 대상이 수백 명일 때 URL 한도 초과(Bad Request)
  // — PR #170 어드민 수신함과 동일 함정. IN_CHUNK 단위로 분할 조회.
  const IN_CHUNK = 200;
  let targets = [...new Set(userIds)];
  let skipped = 0;
  if (prefKey) {
    const explicit = new Map<string, boolean>();
    for (let i = 0; i < targets.length; i += IN_CHUNK) {
      const slice = targets.slice(i, i + IN_CHUNK);
      const { data: prefRows, error: prefErr } = await supabase
        .from("notification_prefs")
        .select(`user_id, ${prefKey}`)
        .in("user_id", slice);
      if (prefErr) {
        console.error("[fcm] prefs query failed:", prefErr.message);
        return { sent: 0, failed: 0, cleaned: 0, skipped: 0 };
      }
      for (const r of prefRows ?? []) {
        const row = r as unknown as Record<string, unknown>;
        explicit.set(row.user_id as string, row[prefKey] as boolean);
      }
    }
    const before = targets.length;
    targets = targets.filter((id) => explicit.get(id) ?? DEFAULT_PREFS[prefKey]);
    skipped = before - targets.length;
  }
  if (targets.length === 0) return { sent: 0, failed: 0, cleaned: 0, skipped };

  // 2. 디바이스 토큰 (동일하게 분할 조회)
  const tokens: string[] = [];
  for (let i = 0; i < targets.length; i += IN_CHUNK) {
    const slice = targets.slice(i, i + IN_CHUNK);
    const { data: rows, error: tokenErr } = await supabase
      .from("device_push_tokens")
      .select("fcm_token")
      .in("user_id", slice);
    if (tokenErr) {
      console.error("[fcm] token query failed:", tokenErr.message);
      return { sent: 0, failed: 0, cleaned: 0, skipped };
    }
    for (const r of rows ?? []) tokens.push((r as { fcm_token: string }).fcm_token);
  }
  if (tokens.length === 0) return { sent: 0, failed: 0, cleaned: 0, skipped };

  // 3. chunk 발송 (FCM multicast 한도 500)
  const CHUNK = 500;
  let sent = 0;
  let failed = 0;
  const invalid: string[] = [];
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const res = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: { title: payload.title, body: payload.body },
      data: payload.url ? { url: payload.url } : undefined,
    });
    sent += res.successCount;
    failed += res.failureCount;
    res.responses.forEach((r, j) => {
      const code = r.error?.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
        invalid.push(chunk[j]);
      }
    });
  }

  // 4. 무효 토큰 정리
  if (invalid.length > 0) {
    const { error: cleanupError } = await supabase.from("device_push_tokens").delete().in("fcm_token", invalid);
    if (cleanupError) console.error("[fcm] invalid token cleanup failed:", cleanupError.message);
  }

  return { sent, failed, cleaned: invalid.length, skipped };
}
