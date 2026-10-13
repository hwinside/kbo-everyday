import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { verifyAccessToken } from "@/lib/auth/verified-user";

import { normalizeDwellEvents } from "./normalize";

interface DwellPayload {
  visitorId?: string;
  path?: string;
  platform?: string;
  dwellMs?: number;
  /** Batched intervals (new client). When present, takes precedence over the
   * legacy single path/dwellMs pair — old clients keep working during rollout. */
  events?: unknown;
  /** Caller's Supabase access token. user_id is derived from the verified JWT,
   * never from a client-claimed id. */
  accessToken?: string;
}

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
  // path/dwellMs pair. Validation lives in ./normalize (순수 모듈) so the QA
  // gate exercises the exact production seam.
  const events = normalizeDwellEvents(payload);

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
      dwell_ms: e.dwellMs, // normalize에서 MAX cap 적용 완료
    })),
  );

  if (error) {
    console.warn("[page-dwell] insert failed", error.message);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
