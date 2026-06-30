import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

interface DwellPayload {
  visitorId?: string;
  path?: string;
  platform?: string;
  dwellMs?: number;
  userId?: string | null;
}

// Sub-second hits are noise; cap a single interval to guard against an
// idle-but-visible tab inflating the mean (the client already pauses on hide).
const MIN_DWELL_MS = 1000;
const MAX_DWELL_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest) {
  let payload: DwellPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const visitorId =
    typeof payload.visitorId === "string" && payload.visitorId.trim()
      ? payload.visitorId.trim()
      : null;
  const dwellMs =
    typeof payload.dwellMs === "number" && Number.isFinite(payload.dwellMs)
      ? Math.round(payload.dwellMs)
      : NaN;

  // Quietly drop noise/garbage so beacons never surface as client errors.
  if (!visitorId || !Number.isFinite(dwellMs) || dwellMs < MIN_DWELL_MS) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const userId =
    typeof payload.userId === "string" && payload.userId ? payload.userId : null;
  const platform =
    typeof payload.platform === "string" && payload.platform
      ? payload.platform.slice(0, 32)
      : null;
  const path =
    typeof payload.path === "string" && payload.path
      ? payload.path.slice(0, 512)
      : null;

  const { error } = await supabase.from("admin_page_dwell").insert({
    visitor_id: visitorId,
    user_id: userId,
    path,
    platform,
    dwell_ms: Math.min(dwellMs, MAX_DWELL_MS),
  });

  if (error) {
    console.warn("[page-dwell] insert failed", error.message);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
