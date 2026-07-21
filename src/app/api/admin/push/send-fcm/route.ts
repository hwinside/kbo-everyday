import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { sendFcmToTokens, getFcm } from "@/lib/notifications/fcm";
import { fetchAllByKeyset } from "@/lib/db/paginate";
import { normalizeManualPushTargets, reconcileDeliveryLedger } from "@/lib/admin/delivery-ledger";

// 어드민 수동 FCM 푸시 발송 — 공용 헬퍼(src/lib/notifications/fcm.ts) 사용.
// prefs 필터 없음 (어드민 수동 발송은 전체/지정 대상에 그대로)

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!getFcm()) {
    return NextResponse.json({ error: "FIREBASE_SERVICE_ACCOUNT not configured" }, { status: 500 });
  }

  const requestBody = await req.json();
  const { title, body, url, userIds } = requestBody;
  if (!title || !body) {
    return NextResponse.json({ error: "title and body required" }, { status: 400 });
  }

  let explicitTargets: string[] | null;
  try {
    explicitTargets = normalizeManualPushTargets(
      userIds,
      Object.prototype.hasOwnProperty.call(requestBody, "userIds"),
    );
  } catch (error) {
    return NextResponse.json(
      { error: "invalid_user_ids", detail: error instanceof Error ? error.message : "invalid" },
      { status: 400 },
    );
  }
  let targetIds = explicitTargets ?? [];
  const hasExplicitTargets = explicitTargets !== null;
  let tokenRows: Array<{ id: number; user_id: string; fcm_token: string }> = [];
  if (!hasExplicitTargets) {
    const { count: expectedTokenRows, error: countError } = await supabase
      .from("device_push_tokens")
      .select("*", { count: "exact", head: true });
    if (countError) return supabaseErrorResponse(countError);

    try {
      tokenRows = await fetchAllByKeyset(
        async (cursor, limit) => {
          let query = supabase
            .from("device_push_tokens")
            .select("id, user_id, fcm_token")
            .order("id", { ascending: true })
            .limit(limit);
          if (cursor !== null) query = query.gt("id", cursor);
          return query;
        },
        (row) => row.id,
        { label: "admin manual push token targets" },
      );
    } catch (e) {
      return NextResponse.json(
        { error: "fetch_push_targets_failed", detail: e instanceof Error ? e.message : "unknown" },
        { status: 500 },
      );
    }
    if (tokenRows.length !== (expectedTokenRows ?? 0)) {
      return NextResponse.json(
        { error: "push_target_count_mismatch", expected: expectedTokenRows, selected: tokenRows.length },
        { status: 500 },
      );
    }
    targetIds = [...new Set(tokenRows.map((row) => row.user_id))];
  } else {
    const IN_CHUNK = 150;
    try {
      for (let i = 0; i < targetIds.length; i += IN_CHUNK) {
        const slice = targetIds.slice(i, i + IN_CHUNK);
        const rows = await fetchAllByKeyset(
          async (cursor, limit) => {
            let query = supabase
              .from("device_push_tokens")
              .select("id, user_id, fcm_token")
              .in("user_id", slice)
              .order("id", { ascending: true })
              .limit(limit);
            if (cursor !== null) query = query.gt("id", cursor);
            return query;
          },
          (row) => row.id,
          { label: "admin manual push explicit token targets" },
        );
        tokenRows.push(...rows);
      }
    } catch (error) {
      return NextResponse.json(
        { error: "fetch_push_targets_failed", detail: error instanceof Error ? error.message : "unknown" },
        { status: 500 },
      );
    }
  }

  const expected = targetIds.length;
  const { data: ledger, error: ledgerError } = await supabase
    .from("admin_delivery_jobs")
    .insert({
      kind: "manual_push",
      status: "processing",
      title,
      body,
      url: url || null,
      target_label: hasExplicitTargets ? "지정 유저" : "전체 토큰 보유 유저",
      expected_count: expected,
      selected_count: targetIds.length,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (ledgerError || !ledger) {
    return NextResponse.json({ error: "create_push_ledger_failed" }, { status: 500 });
  }

  const tokens = [...new Set(tokenRows.map((row) => row.fcm_token))];
  const res = await sendFcmToTokens(tokens, { title, body, url });
  let reconciliation;
  try {
    reconciliation = reconcileDeliveryLedger({
      expected,
      selected: targetIds.length,
      tokens: res.tokens,
      sent: res.sent,
      failed: res.failed,
      infrastructureOk: res.ok,
    });
  } catch (e) {
    await supabase
      .from("admin_delivery_jobs")
      .update({
        status: "completed_with_failures",
        token_count: res.tokens,
        sent_count: res.sent,
        failed_count: res.failed,
        last_error: e instanceof Error ? e.message : "ledger_reconciliation_failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", ledger.id);
    return NextResponse.json({ error: "push_ledger_reconciliation_failed", jobId: ledger.id }, { status: 500 });
  }
  const { error: updateError } = await supabase
    .from("admin_delivery_jobs")
    .update({
      status: reconciliation.status,
      token_count: res.tokens,
      sent_count: res.sent,
      failed_count: res.failed,
      last_error: res.lastError ?? reconciliation.lastError,
      completed_at: new Date().toISOString(),
    })
    .eq("id", ledger.id);
  if (updateError) {
    return NextResponse.json(
      { error: "update_push_ledger_failed", jobId: ledger.id, ...res },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ...res,
    jobId: ledger.id,
    expected,
    selected: targetIds.length,
  });
}
