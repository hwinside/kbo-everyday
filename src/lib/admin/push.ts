import webpush from "web-push";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

/**
 * 어드민 PWA 웹푸시 발송 (2026-07-18).
 *
 * 대상 = admin_push_subscriptions — 어드민 PIN 인증 기기에서만 등록되는 별도 테이블.
 * 유저용 push_subscriptions와 분리해 어드민 알림이 일반 유저에게 갈 여지를 차단한다.
 * VAPID env 미설정이면 no-op (기능 게이트, 기존 /api/push/send와 동일 키 사용).
 */

export interface AdminPushPayload {
  title: string;
  body: string;
  /** 알림 탭 시 이동할 어드민 경로 (예: /admin/messages) */
  url: string;
  /** 같은 tag 알림은 최신 것으로 교체됨 (알림센터 도배 방지) */
  tag?: string;
}

interface SubscriptionRow {
  endpoint: string;
  subscription: webpush.PushSubscription;
}

export interface AdminPushResult {
  sent: number;
  failed: number;
  /** 구독 조회 DB 오류 — "실제 구독 0개"와 구분(2차 리뷰 P1). true면 전달 결과 미지 = 호출측 fail-closed 처리 */
  queryError?: boolean;
}

export async function sendAdminPush(payload: AdminPushPayload): Promise<AdminPushResult> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return { sent: 0, failed: 0 };

  webpush.setVapidDetails("mailto:harinclaw@gmail.com", publicKey, privateKey);

  const { data: subs, error: queryError } = await supabase
    .from("admin_push_subscriptions")
    .select("endpoint,subscription");
  // 조회 오류를 "구독 0개"와 구분 — 호출측(크론)이 revert+5xx 할 수 있게 surface
  if (queryError) return { sent: 0, failed: 0, queryError: true };
  if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    (subs as SubscriptionRow[]).map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, body);
        sent++;
      } catch (e: unknown) {
        failed++;
        const status = (e as { statusCode?: number }).statusCode;
        // 410 Gone / 404 = 구독 만료 → 정리
        if (status === 410 || status === 404) {
          await supabase.from("admin_push_subscriptions").delete().eq("endpoint", row.endpoint);
        }
      }
    }),
  );

  return { sent, failed };
}
