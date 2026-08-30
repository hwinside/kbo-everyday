import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";

interface DwellEvent {
  path?: string;
  dwellMs?: number;
}

interface DwellPayload {
  visitorId?: string;
  path?: string;
  platform?: string;
  dwellMs?: number;
  /** Batched intervals (new client). When present, takes precedence over the
   * legacy single path/dwellMs pair — old clients keep working during rollout. */
  events?: DwellEvent[];
  /** Caller's Supabase access token. user_id is derived from the verified JWT,
   * never from a client-claimed id. */
  accessToken?: string;
}

// Sub-second hits are noise; cap a single interval to guard against an
// idle-but-visible tab inflating the mean (the client already pauses on hide).
const MIN_DWELL_MS = 1000;
const MAX_DWELL_MS = 30 * 60 * 1000;
// Batch bound: the client caps its queue at 20; anything larger is abuse or a
// bug — excess entries are dropped, never inserted.
const MAX_EVENTS = 20;

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
  const accessToken =
    typeof payload.accessToken === "string" && payload.accessToken
      ? payload.accessToken
      : null;

  // Normalize to a batch: new clients send `events[]`, legacy clients a single
  // path/dwellMs pair. Per-event validation mirrors the old single-event rules.
  const rawEvents: DwellEvent[] = Array.isArray(payload.events)
    ? payload.events.slice(0, MAX_EVENTS)
    : [{ path: payload.path, dwellMs: payload.dwellMs }];
  const events = rawEvents
    .map((e) => ({
      path:
        typeof e?.path === "string" && e.path ? e.path.slice(0, 512) : null,
      dwellMs:
        typeof e?.dwellMs === "number" && Number.isFinite(e.dwellMs)
          ? Math.round(e.dwellMs)
          : NaN,
    }))
    .filter(
      (e): e is { path: string; dwellMs: number } =>
        e.path != null && Number.isFinite(e.dwellMs) && e.dwellMs >= MIN_DWELL_MS,
    );

  // Quietly drop noise/garbage so beacons never surface as client errors.
  if (!visitorId || !accessToken || events.length === 0) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Pin the population to logged-in users: verify the JWT and derive user_id
  // server-side. An invalid/expired token is silently dropped (telemetry).
  // verifyAccessToken은 로컬 exp 프리체크 + dead-token 캐시로 무효 토큰의
  // Supabase 호출 자체를 차단한다 (sendBeacon은 응답을 못 보는 fire-and-forget이라
  // 클라가 죽은 세션을 알 수 없이 계속 보내는 경로 — 서버가 막아야 한다).
  const user = await verifyAccessToken(accessToken);
  if (!user) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const platform =
    typeof payload.platform === "string" && payload.platform
      ? payload.platform.slice(0, 32)
      : null;

  const { error } = await supabase.from("admin_page_dwell").insert(
    events.map((e) => ({
      visitor_id: visitorId,
      user_id: user.id,
      path: e.path,
      platform,
      dwell_ms: Math.min(e.dwellMs, MAX_DWELL_MS),
    })),
  );

  if (error) {
    console.warn("[page-dwell] insert failed", error.message);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
