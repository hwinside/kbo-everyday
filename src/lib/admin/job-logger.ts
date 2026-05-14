import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

export async function startJob(jobName: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("admin_job_logs")
    .insert({ job_name: jobName, status: "running", started_at: new Date().toISOString() })
    .select("id")
    .single();

  if (error) {
    console.error(`[job-logger] startJob(${jobName}) failed:`, error.message);
    return null;
  }
  return data.id;
}

export async function finishJob(
  logId: number | null,
  status: "success" | "warning" | "error",
  resultSummary?: string,
  errorMessage?: string,
): Promise<void> {
  if (!logId) return;

  const now = new Date();
  const { data: row } = await supabase
    .from("admin_job_logs")
    .select("started_at")
    .eq("id", logId)
    .single();

  const durationMs = row?.started_at
    ? now.getTime() - new Date(row.started_at).getTime()
    : null;

  const { error } = await supabase
    .from("admin_job_logs")
    .update({
      status,
      finished_at: now.toISOString(),
      duration_ms: durationMs,
      result_summary: resultSummary ?? null,
      error_message: errorMessage ?? null,
    })
    .eq("id", logId);

  if (error) {
    console.error(`[job-logger] finishJob(${logId}) failed:`, error.message);
  }
}
