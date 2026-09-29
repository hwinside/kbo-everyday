import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/http/client-ip";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { allowViewRequest } from "@/lib/community/view-rate-limit";
import { parseImpressionBatch } from "@/lib/community/impression-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same per-post RPC/cap as the legacy route; only HTTP transport is grouped. */
export async function POST(request: NextRequest) {
  let postIds: number[] | null = null;
  try {
    const body = await request.text();
    if (body.length > 2048) return NextResponse.json({ error: "batch too large" }, { status: 413 });
    postIds = parseImpressionBatch(JSON.parse(body));
  } catch { /* Invalid JSON is rejected before any writes. */ }
  if (!postIds) return NextResponse.json({ error: "invalid postIds" }, { status: 400 });

  const viewer = getClientIp(request, { allowRealIp: true });
  const allowed = postIds.filter((id) => allowViewRequest(viewer, id, "impression"));
  if (!allowed.length) return NextResponse.json({ ok: false, throttled: true });
  const supabase = getSupabaseAdmin();
  let ok = true;
  // Bound DB fanout; retain the existing atomic +1 RPC and service-role boundary.
  for (let offset = 0; offset < allowed.length; offset += 4) {
    await Promise.all(allowed.slice(offset, offset + 4).map(async (id) => {
      try {
        const { error } = await supabase.rpc("increment_post_view", { p_post_id: id, p_kind: "impression" });
        if (error) throw error;
      } catch (error) {
        ok = false;
        console.error("[post-view-batch] increment_post_view failed", { postId: id,
          error: error && typeof error === "object" && "message" in error && typeof error.message === "string"
            ? error.message : "RPC failed" });
      }
    }));
  }
  // No retries: partial success must not double count successful writes.
  return NextResponse.json({ ok });
}
