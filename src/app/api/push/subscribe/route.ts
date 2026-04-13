import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  const { subscription } = await req.json();

  if (!subscription) {
    return NextResponse.json({ error: "subscription required" }, { status: 400 });
  }

  const { error } = await supabase.from("push_subscriptions").upsert({
    endpoint: subscription.endpoint,
    subscription,
    user_id: verified?.user.id || null,
    created_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });

  if (error) return supabaseErrorResponse(error);
  return NextResponse.json({ success: true });
}
