import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// TEMP 진단 (2026-06-28): 가입 시 네이티브 Meta App Event 브릿지 호출이 런타임에
// 실제로 FB SDK까지 닿는지 확인하기 위한 비콘 수신 엔드포인트.
// 클라이언트(앱 웹뷰)가 각 단계(attempt/skip_non_native/bridge_resolved/bridge_rejected)를
// POST하면 service_role로 native_meta_beacon 테이블에 적재. 원인 확정 후 라우트+테이블 제거 예정.
//
// 보안: 무인증(앱 웹뷰에서 호출). 개인정보 미수집 — 단계/이벤트명/플랫폼/UA만.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const stage = typeof body?.stage === "string" ? body.stage.slice(0, 40) : "unknown";
    const eventName = typeof body?.eventName === "string" ? body.eventName.slice(0, 80) : null;
    const traceId = typeof body?.traceId === "string" ? body.traceId.slice(0, 60) : null;
    const platform = typeof body?.platform === "string" ? body.platform.slice(0, 40) : null;
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 500) : null;
    const ua = (req.headers.get("user-agent") || "").slice(0, 300);

    await getSupabaseAdmin().from("native_meta_beacon").insert({
      trace_id: traceId,
      event_name: eventName,
      stage,
      platform,
      detail,
      ua,
    });

    return NextResponse.json({ ok: true });
  } catch {
    // 진단용 — 실패해도 본 플로우에 영향 주지 않도록 200 유지
    return NextResponse.json({ ok: false });
  }
}
