import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

function getDevice(userAgent: string): string {
  if (/Tablet|iPad/i.test(userAgent)) return "tablet";
  if (/Mobile|Android|iPhone/i.test(userAgent)) return "mobile";
  return "desktop";
}

interface CelebrationTriggerPayload {
  visitorId?: string;
  type?: string;
  gameId?: string;
  teamId?: number;
  playerName?: string;
  eventId?: string;
  inning?: number;
  isTop?: boolean;
  /** Telemetry-only: which generator produced the GameEvent. */
  source?: string;
  /** Telemetry-only: GameEvent.timestamp (ms) at fire time. Used to compute
   *  server→client gap P50/P90 in admin panel. */
  eventTimeMs?: number;
  firedAtMs?: number;
}

export async function POST(req: NextRequest) {
  let payload: CelebrationTriggerPayload;

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type = typeof payload.type === "string" ? payload.type : "unknown";
  const gameId = typeof payload.gameId === "string" ? payload.gameId : "unknown";
  const visitorId = typeof payload.visitorId === "string" && payload.visitorId.trim()
    ? payload.visitorId
    : `anonymous-${crypto.randomUUID()}`;
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  // Pipe-encoded so we can grep `admin_page_views.referrer` for mis-attribution
  // patterns: teamId|playerName|inning(T|B)|eventId|source|gapMs
  // `gapMs` = firedAtMs - eventTimeMs (client-side gap from GameEvent timestamp
  // to celebration fire). Negative or absent values are dropped.
  const inningStr = typeof payload.inning === "number"
    ? `${payload.inning}${payload.isTop ? "T" : "B"}`
    : "";
  const sourceStr = typeof payload.source === "string" && payload.source.trim()
    ? payload.source
    : "";
  let gapStr = "";
  if (typeof payload.firedAtMs === "number" && typeof payload.eventTimeMs === "number") {
    const gap = payload.firedAtMs - payload.eventTimeMs;
    if (Number.isFinite(gap) && gap >= 0) gapStr = String(gap);
  }
  const referrer = [
    payload.teamId,
    payload.playerName,
    inningStr,
    payload.eventId,
    sourceStr,
    gapStr,
  ].filter(Boolean).join("|") || null;

  const { error } = await supabase.from("admin_page_views").insert({
    visitor_id: visitorId,
    path: `/_celeb/${type}/${gameId}`,
    referrer,
    user_agent: userAgent,
    device: getDevice(userAgent),
    user_id: null,
  });

  if (error) {
    console.warn("[celebration-trigger] insert failed", error.message);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
