import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface AnomalyCheckResult {
  triggered: boolean;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
}

export async function checkAnomalies(): Promise<AnomalyCheckResult[]> {
  const results: AnomalyCheckResult[] = [];

  // 1. Traffic drop/spike check
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const { data: todayStats } = await supabase
    .from("admin_daily_stats")
    .select("uv")
    .eq("date", today)
    .single();

  const { data: yesterdayStats } = await supabase
    .from("admin_daily_stats")
    .select("uv")
    .eq("date", yesterday)
    .single();

  if (todayStats && yesterdayStats && yesterdayStats.uv > 0) {
    const change = ((todayStats.uv - yesterdayStats.uv) / yesterdayStats.uv) * 100;
    if (Math.abs(change) >= 50) {
      results.push({
        triggered: true,
        type: "traffic",
        severity: "warning",
        message: `UV가 전일 대비 ${change > 0 ? "+" : ""}${change.toFixed(0)}% ${change > 0 ? "증가" : "감소"}했습니다`,
        details: { today: todayStats.uv, yesterday: yesterdayStats.uv },
      });
    }
  }

  // 2. Crawler consecutive failure check
  const { data: recentJobs } = await supabase
    .from("admin_job_logs")
    .select("job_name, status")
    .order("started_at", { ascending: false })
    .limit(30);

  if (recentJobs) {
    const jobGroups = new Map<string, string[]>();
    for (const job of recentJobs) {
      const list = jobGroups.get(job.job_name) ?? [];
      list.push(job.status);
      jobGroups.set(job.job_name, list);
    }
    for (const [jobName, statuses] of jobGroups) {
      if (statuses.length >= 3 && statuses.slice(0, 3).every((s) => s === "error")) {
        results.push({
          triggered: true,
          type: "crawler",
          severity: "critical",
          message: `${jobName} 크롤러가 3회 연속 실패했습니다`,
          details: { jobName, consecutiveFailures: 3 },
        });
      }
    }
  }

  // 3. Performance P95 check
  const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
  const { data: perfData } = await supabase
    .from("admin_perf_metrics")
    .select("metric_name, value")
    .gte("created_at", oneHourAgo);

  if (perfData && perfData.length > 0) {
    const lcpValues = perfData.filter((p) => p.metric_name === "LCP").map((p) => p.value).sort((a, b) => a - b);
    if (lcpValues.length > 0) {
      const p95Index = Math.floor(lcpValues.length * 0.95);
      const p95 = lcpValues[p95Index] ?? lcpValues[lcpValues.length - 1];
      if (p95 > 3) {
        results.push({
          triggered: true,
          type: "performance",
          severity: "warning",
          message: `LCP P95가 ${p95.toFixed(1)}초로 임계값(3초)을 초과했습니다`,
          details: { p95 },
        });
      }
    }
  }

  // Log anomalies
  for (const r of results) {
    if (r.triggered) {
      await supabase.from("admin_anomaly_logs").insert({
        type: r.type,
        severity: r.severity,
        message: r.message,
        details: r.details ?? null,
      });
    }
  }

  return results;
}
