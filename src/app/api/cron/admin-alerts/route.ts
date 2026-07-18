import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import {
  JOB_DEFS,
  computeJobHealth,
  decideAdminAlerts,
  type JobLevelSnapshot,
} from "@/lib/admin/job-health";
import { sendAdminPush } from "@/lib/admin/push";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

/**
 * 크롤러/배치 이상 감지 → 어드민 PWA 푸시 (2026-07-18, 30분 주기).
 *
 * 판정은 /api/admin/jobs/health와 동일한 job-health 순수 함수를 재사용하고,
 * admin_alert_state에 job별 직전 레벨을 저장해 "상태 전이 시에만" 알림을 보낸다
 * (problem 진입 시 경고 1회, problem→정상 복귀 시 복구 1회 — 30분마다 반복 알림 방지).
 *
 * 알려진 edge(비차단): problem→unknown→healthy 순서로 전이하면 unknown 시점에
 * 상태가 덮여 복구 알림이 생략된다. unknown은 "판정 불가(회색)"라 경고도 복구도
 * 만들지 않는 보수 정책의 트레이드오프.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const meta = statsMeta as Record<string, string>;
  const generatedAt = meta.battersGeneratedAt ?? meta.pitchersGeneratedAt ?? null;

  // job별 최신 로그 1건 병렬 조회 (admin/jobs/health와 동일 패턴)
  const latestByJob = await Promise.all(
    JOB_DEFS.map(async (def) => {
      const { data } = await supabase
        .from("admin_job_logs")
        .select("status,started_at")
        .eq("job_name", def.name)
        .order("started_at", { ascending: false })
        .limit(1);
      const row = data?.[0] as { status: string | null; started_at: string | null } | undefined;
      return { status: row?.status ?? null, startedAt: row?.started_at ?? null };
    }),
  );

  const current: JobLevelSnapshot[] = JOB_DEFS.map((def, i) => {
    const health = computeJobHealth(
      def,
      {
        latestStatus: latestByJob[i].status,
        latestAt: latestByJob[i].startedAt,
        dataGeneratedAt: def.dataFreshness ? generatedAt : null,
      },
      now,
    );
    return { jobName: def.name, label: def.label, level: health.level, reason: health.reason };
  });

  const { data: prevRows } = await supabase.from("admin_alert_state").select("job_name,level");
  const prev = new Map<string, string>(
    (prevRows ?? []).map((r) => [r.job_name as string, r.level as string]),
  );

  const alerts = decideAdminAlerts(prev, current);

  let sent = 0;
  for (const alert of alerts) {
    const result = await sendAdminPush({
      title: alert.kind === "problem" ? "⚠️ 크롤러/배치 이상" : "✅ 크롤러/배치 복구",
      body:
        alert.kind === "problem"
          ? `${alert.label}: ${alert.reason}`
          : `${alert.label} 정상 복귀`,
      url: "/admin/jobs",
      tag: `admin-job-${alert.jobName}`,
    });
    sent += result.sent;
  }

  // 상태 스냅샷 upsert (다음 틱의 전이 판정 기준)
  const upserts = current.map((c) => ({
    job_name: c.jobName,
    level: c.level,
    reason: c.reason,
    updated_at: new Date(now).toISOString(),
  }));
  const { error: upsertError } = await supabase
    .from("admin_alert_state")
    .upsert(upserts, { onConflict: "job_name" });

  return NextResponse.json({
    checked: current.length,
    alerts: alerts.length,
    sent,
    stateSaved: !upsertError,
  });
}
