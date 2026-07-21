import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import {
  physicalBackupRef,
  selectFreshPhysicalBackup,
  type SupabaseBackup,
} from "@/lib/admin/telemetry-retention";

const CRON_SECRET = process.env.CRON_SECRET || "";
const MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN || "";
const PROJECT_REF = "lbmbdjgsnenqjwjotoei";

export const maxDuration = 60;

async function fetchFreshBackup(): Promise<ReturnType<typeof selectFreshPhysicalBackup>> {
  if (!MANAGEMENT_TOKEN) return null;
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/backups`,
    {
      headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  const body = await response.json() as { backups?: SupabaseBackup[] };
  return selectFreshPhysicalBackup(body.backups ?? []);
}

export async function GET(req: NextRequest) {
  if (!CRON_SECRET || req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const logId = await startJob("admin-telemetry-retention");

  try {
    let backupRef: string | null = null;
    if (!dryRun) {
      const backup = await fetchFreshBackup();
      if (!backup) throw new Error("fresh completed physical backup unavailable");
      backupRef = physicalBackupRef(backup);
    }

    const { data, error } = await supabase.rpc("admin_telemetry_retention_run", {
      p_execute: !dryRun,
      p_backup_ref: backupRef,
    });
    if (error) throw error;

    const mode = dryRun ? "dry-run" : "executed";
    const deleted = (data as { deleted?: Record<string, number> } | null)?.deleted ?? {};
    await finishJob(logId, "success", `${mode} deleted=${JSON.stringify(deleted)}`);
    return NextResponse.json({ ok: true, mode, result: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(logId, "error", undefined, message);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
