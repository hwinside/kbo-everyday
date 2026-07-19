import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";
import { buildBlindNotice, blindTargetLabel } from "@/lib/moderation/report-blind";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET || "";
const MAX_ATTEMPTS = 10; // 발송 실패 재시도 상한(무한 루프 방지)
const BATCH = 50;

// 신고 자동 블라인드 안내 쪽지 outbox 소비 워커.
// 트리거(auto_blind_on_report)가 블라인드 전환 순간 report_blind_notices 에 적재한 건을
// 읽어 작성자에게 운영팀 쪽지를 1회 발송한다. 실패는 attempts++ 후 다음 틱 재시도(durable).
function authorized(req: NextRequest): boolean {
  if (CRON_SECRET && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`) return true;
  // Vercel Cron 은 이 헤더를 붙인다.
  if (req.headers.get("x-vercel-cron")) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // config 누락 시 outbox 는 그대로 보존(다음 배포/틱에서 소비) — 유실 없음
    return NextResponse.json({ ok: false, reason: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();

  const { data: pending, error } = await admin
    .from("report_blind_notices")
    .select("id, target_type, target_id, author_id, attempts")
    .is("notified_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("blinded_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    return NextResponse.json({ ok: false, reason: "query_failed", error: error.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of pending ?? []) {
    const id = row.id as number;
    const authorId = row.author_id as string | null;
    const attempts = (row.attempts as number) ?? 0;

    // 작성자 없음(탈퇴/미상) 또는 시스템 계정 → 발송 불가/불필요. 완료 처리해 재시도 루프에서 제외.
    if (!authorId || authorId === systemUserId) {
      await admin
        .from("report_blind_notices")
        .update({ notified_at: new Date().toISOString(), last_error: authorId ? "author_is_system" : "no_author" })
        .eq("id", id);
      skipped++;
      continue;
    }

    const notice = buildBlindNotice(blindTargetLabel(row.target_type as string));
    let result: { ok: boolean; reason?: string };
    try {
      const r = await sendOpsMessageToUser(admin, systemUserId, authorId, notice);
      result = r.ok ? { ok: true } : { ok: false, reason: r.reason };
    } catch (e) {
      result = { ok: false, reason: e instanceof Error ? e.message : "exception" };
    }

    if (result.ok) {
      await admin
        .from("report_blind_notices")
        .update({ notified_at: new Date().toISOString(), attempts: attempts + 1, last_error: null })
        .eq("id", id);
      sent++;
    } else {
      // 실패 → attempts 증가, notified_at 은 NULL 유지(다음 틱 재시도)
      await admin
        .from("report_blind_notices")
        .update({ attempts: attempts + 1, last_error: result.reason ?? "send_failed" })
        .eq("id", id);
      failed++;
    }
  }

  return NextResponse.json({ ok: true, processed: (pending ?? []).length, sent, skipped, failed });
}
