import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import type { PushSubscriptionRow, WebPushError } from "@/types/api";
import { isAdminRequest } from "@/lib/admin/pin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function getWebPush() {
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      "mailto:harinclaw@gmail.com",
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  }
  return webpush;
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const wp = getWebPush();
  const { title, body, url, tag, userIds } = await req.json();

  let query = supabase.from("push_subscriptions").select("subscription");
  if (userIds?.length) query = query.in("user_id", userIds);

  const { data: subs } = await query;
  if (!subs || subs.length === 0) return NextResponse.json({ sent: 0 });

  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subs.map(async (s: PushSubscriptionRow) => {
      try {
        await wp.sendNotification(s.subscription, payload);
        sent++;
      } catch (e: unknown) {
        failed++;
        if ((e as WebPushError).statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", s.subscription.endpoint);
        }
      }
    }),
  );

  return NextResponse.json({ sent, failed });
}
