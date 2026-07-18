import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import { JOB_DEFS, computeJobHealth, isProblem, type JobHealth } from "@/lib/admin/job-health";

async function verifyPin(req: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(req);
}

// 크롤 산출 데이터(정적 스탯)의 반영 시각 — dataFreshness job(스탯/로스터 크롤)의 신선도 판정용.
// 빌드타임 번들이라 배포된 데이터의 실제 생성 시각을 반영한다.
function dataGeneratedAt(): string | null {
  const m = statsMeta as Record<string, string>;
  return m.battersGeneratedAt ?? m.pitchersGeneratedAt ?? null;
}

interface LatestLog {
  status: string | null;
  started_at: string | null;
}

// job별 최신 로그 1건을 병렬 조회 (주간 잡도 정확히 잡히도록 전역 윈도우 대신 per-job).
async function fetchLatest(jobName: string): Promise<LatestLog> {
  const { data } = await supabase
    .from("admin_job_logs")
    .select("status,started_at")
    .eq("job_name", jobName)
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0] as LatestLog | undefined;
  return { status: row?.status ?? null, started_at: row?.started_at ?? null };
}

export async function GET(req: NextRequest) {
  if (!(await verifyPin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const generatedAt = dataGeneratedAt();

  const latestByJob = await Promise.all(JOB_DEFS.map((def) => fetchLatest(def.name)));

  const jobs = JOB_DEFS.map((def, i) => {
    const latest = latestByJob[i];
    const health: JobHealth = computeJobHealth(
      def,
      {
        latestStatus: latest.status,
        latestAt: latest.started_at,
        dataGeneratedAt: def.dataFreshness ? generatedAt : null,
      },
      now,
    );
    return {
      name: def.name,
      label: def.label,
      level: health.level,
      reason: health.reason,
      latestStatus: latest.status,
      latestAt: latest.started_at,
      dataGeneratedAt: def.dataFreshness ? generatedAt : null,
      dataAgeHours: health.dataAgeHours,
    };
  });

  const problemCount = jobs.filter((j) => isProblem(j.level)).length;

  return NextResponse.json({ jobs, problemCount, checkedAt: new Date(now).toISOString() });
}
