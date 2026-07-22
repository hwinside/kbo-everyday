import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sendOpsMessageToUser } from "@/lib/cs/send-ops-message";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET || "";
const BATCH_SIZE = 200;
const CONCURRENCY = 10;
const MAX_ATTEMPTS = 10;

function authorized(req: NextRequest): boolean {
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

interface ClaimedRecipient {
  job_id: string;
  user_id: string;
  sender_id: string;
  content: string;
  attempts: number;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, reason: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc("claim_admin_broadcast_recipients", {
    p_limit: BATCH_SIZE,
    p_lease_seconds: 300,
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (error) {
    return NextResponse.json(
      { ok: false, reason: "claim_failed", error: error.message },
      { status: 500 },
    );
  }

  let sent = 0;
  let retrying = 0;
  let failed = 0;
  let updateErrors = 0;

  const claimed = (data ?? []) as ClaimedRecipient[];
  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const results = await Promise.all(
      claimed.slice(i, i + CONCURRENCY).map(async (row) => {
        const dedupKey = `admin-broadcast:${row.job_id}:${row.user_id}`;
        let result: { ok: boolean; reason?: string };
        try {
          result = await sendOpsMessageToUser(
            admin,
            row.sender_id,
            row.user_id,
            row.content,
            dedupKey,
          );
        } catch (e) {
          result = { ok: false, reason: e instanceof Error ? e.message : "exception" };
        }

        const { error: finishError } = await admin.rpc("finish_admin_broadcast_recipient", {
          p_job_id: row.job_id,
          p_user_id: row.user_id,
          p_ok: result.ok,
          p_error: result.ok ? null : result.reason ?? "send_failed",
          p_max_attempts: MAX_ATTEMPTS,
        });
        if (finishError) return "update_error" as const;
        if (result.ok) return "sent" as const;
        return row.attempts >= MAX_ATTEMPTS ? "failed" as const : "retrying" as const;
      }),
    );
    for (const result of results) {
      if (result === "sent") sent++;
      else if (result === "failed") failed++;
      else if (result === "retrying") retrying++;
      else updateErrors++;
    }
  }

  const ok = retrying === 0 && failed === 0 && updateErrors === 0;
  return NextResponse.json(
    { ok, claimed: (data ?? []).length, sent, retrying, failed, updateErrors },
    { status: ok ? 200 : 500 },
  );
}
