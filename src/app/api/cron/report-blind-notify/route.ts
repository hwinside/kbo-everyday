import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  sendOpsMessageToUser,
  verifyOpsMessageByDedupKey,
} from "@/lib/cs/send-ops-message";
import { buildBlindNotice, blindTargetLabel } from "@/lib/moderation/report-blind";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env["CRON_SECRET"] || "";
const MAX_ATTEMPTS = 10; // 발송 실패 재시도 상한(초과 시 dead-letter)
const BATCH = 50;

// 신고 자동 블라인드 안내 쪽지 outbox 소비 워커.
// 트리거(auto_blind_on_report)가 블라인드 전환 순간 report_blind_notices 에 적재한 건을
// 읽어 작성자에게 운영팀 쪽지를 발송한다.
//  · 겹친 크론 실행 → claim_report_blind_notices RPC 가 행을 원자적으로 lease(중복 처리 방지)
//  · 발송 성공 후 crash → dm_messages.dedup_key 로 재발송이 멱등(중복 쪽지 방지)
//  · 마지막 claim 후 crash → lease 만료 뒤 reconcile claim. DM 존재=완료, 미존재=dead-letter.
//  · 실패 → claim 해제(다음 틱 재시도). attempts 상한 도달 시 dead-letter 확정(관제 노출).
//  · 실패/오류가 하나라도 있으면 HTTP 5xx 로 반환 → Vercel Cron 실패로 기록되어 관제됨.

// 인증: CRON_SECRET Bearer 만 허용한다. 위조 가능한 x-vercel-cron 헤더 폴백은 쓰지 않는다.
// (Vercel Cron 은 Authorization: Bearer $CRON_SECRET 헤더를 붙이도록 구성한다.)
function authorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return false; // fail-closed: 시크릿 미설정 시 전부 차단
  return req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
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

  // 원자적 claim(lease). 겹친 크론이 동시에 돌아도 같은 행을 두 번 집지 않는다.
  const { data: claimed, error } = await admin.rpc("claim_report_blind_notices", {
    p_limit: BATCH,
    p_max_attempts: MAX_ATTEMPTS,
  });

  if (error) {
    return NextResponse.json({ ok: false, reason: "claim_failed", error: error.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let deadLettered = 0;
  let reconciled = 0;
  let updateErrors = 0;

  for (const row of (claimed ?? []) as Array<Record<string, unknown>>) {
    const id = row.id as number;
    const authorId = row.author_id as string | null;
    const targetType = row.target_type as string;
    const targetId = row.target_id as number;
    const attempts = (row.attempts as number) ?? 0; // claim RPC 가 이미 +1 한 값
    const reconcileOnly = row.reconcile_only === true;

    // 작성자 없음(탈퇴/미상) 또는 시스템 계정 → 발송 불가/불필요. 완료 처리해 재시도 루프에서 제외.
    if (!authorId || authorId === systemUserId) {
      const { error: uErr } = await admin
        .from("report_blind_notices")
        .update({
          notified_at: new Date().toISOString(),
          claimed_at: null,
          last_error: authorId ? "author_is_system" : "no_author",
        })
        .eq("id", id);
      if (uErr) updateErrors++;
      skipped++;
      continue;
    }

    const notice = buildBlindNotice(blindTargetLabel(targetType));
    // 멱등키: 대상당 1건 → 발송 성공 후 crash 로 재진입해도 dm_messages UNIQUE 로 중복 차단
    const dedupKey = `report-blind:${targetType}:${targetId}`;

    if (reconcileOnly) {
      // attempts 상한에 도달한 claim 이 lease 만료될 때까지 완료되지 않았다.
      // DM 이 이미 있으면 "발송 성공→outbox 완료 전 crash"이므로 완료로 수렴하고,
      // DM 이 없으면 "발송 전 crash/지속 실패"이므로 명시적 dead-letter 로 수렴한다.
      const verified = await verifyOpsMessageByDedupKey(
        admin,
        systemUserId,
        authorId,
        dedupKey,
        notice,
        null,
      );
      if (!verified.ok) {
        updateErrors++;
        failed++;
        continue;
      }
      if (verified.found) {
        const { error: uErr } = await admin
          .from("report_blind_notices")
          .update({ notified_at: new Date().toISOString(), claimed_at: null, last_error: null })
          .eq("id", id);
        if (uErr) updateErrors++;
        else reconciled++;
        continue;
      }

      const { error: dErr } = await admin.rpc("dead_letter_report_blind_notice", {
        p_id: id,
        p_error: "attempts_exhausted_without_delivery",
      });
      if (dErr) updateErrors++;
      else deadLettered++;
      failed++;
      continue;
    }

    let result: { ok: boolean; reason?: string };
    try {
      const r = await sendOpsMessageToUser(admin, systemUserId, authorId, notice, dedupKey);
      result = r.ok ? { ok: true } : { ok: false, reason: r.reason };
    } catch (e) {
      result = { ok: false, reason: e instanceof Error ? e.message : "exception" };
    }

    if (result.ok) {
      const { error: uErr } = await admin
        .from("report_blind_notices")
        .update({ notified_at: new Date().toISOString(), claimed_at: null, last_error: null })
        .eq("id", id);
      if (uErr) updateErrors++;
      sent++;
    } else if (attempts >= MAX_ATTEMPTS) {
      // 재시도 상한 도달 → dead-letter 확정(다음 claim 에서 영구 제외되므로 여기서 명시 마킹).
      // 관제: dead_lettered_at + last_error 로 조회 가능, requeue = dead_lettered_at/attempts 리셋.
      const { error: dErr } = await admin.rpc("dead_letter_report_blind_notice", {
        p_id: id,
        p_error: result.reason ?? "send_failed",
      });
      if (dErr) updateErrors++;
      deadLettered++;
      failed++;
    } else {
      // 실패 → claim 해제(다음 틱 재시도). attempts 는 claim RPC 가 이미 증가시킴.
      const { error: uErr } = await admin
        .from("report_blind_notices")
        .update({ claimed_at: null, last_error: result.reason ?? "send_failed" })
        .eq("id", id);
      if (uErr) updateErrors++;
      failed++;
    }
  }

  const body = {
    ok: failed === 0 && updateErrors === 0,
    processed: (claimed ?? []).length,
    sent,
    skipped,
    failed,
    deadLettered,
    reconciled,
    updateErrors,
  };
  // 실패/오류/데드레터가 있으면 5xx 로 노출 → Vercel Cron 실패 기록(관제). 정상 처리만 200.
  const status = failed > 0 || updateErrors > 0 ? 500 : 200;
  return NextResponse.json(body, { status });
}
