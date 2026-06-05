/**
 * admin_job_logs 기록 헬퍼 (GH Action용, 의존성 0).
 *
 * run-batch 가 service_role 로 Supabase PostgREST 에 직접 startJob/finishJob 기록 →
 * 어드민 `/admin/jobs` 카드·히스토리에 hero-shot-batch 실행이 그대로 노출된다.
 * (Vercel cron 이 아니라 GH Action 이라 src/lib/admin/job-logger.ts 를 못 쓰므로 같은 스키마로 포팅.)
 *
 * env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * 둘 중 하나라도 없으면 조용히 no-op (로컬 dry-run 에서 배치 자체는 막지 않음).
 */

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

function enabled() {
  return Boolean(URL_BASE && SERVICE_KEY);
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** running 행 insert → 로그 id 반환 (실패/비활성 시 null). */
export async function startJob(jobName) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/admin_job_logs`, {
      method: "POST",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        job_name: jobName,
        status: "running",
        started_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error(`[admin-job-log] startJob(${jobName}) ${res.status}: ${await res.text()}`);
      return null;
    }
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch (e) {
    console.error(`[admin-job-log] startJob(${jobName}) failed:`, e.message);
    return null;
  }
}

/** 로그 행 마감 (status + 한 줄 요약 + duration). */
export async function finishJob(logId, status, resultSummary, errorMessage) {
  if (!logId || !enabled()) return;
  try {
    const sel = await fetch(`${URL_BASE}/rest/v1/admin_job_logs?id=eq.${logId}&select=started_at`, {
      headers: headers(),
    });
    const startedAt = sel.ok ? (await sel.json())?.[0]?.started_at : null;
    const durationMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;

    const res = await fetch(`${URL_BASE}/rest/v1/admin_job_logs?id=eq.${logId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        status,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        result_summary: resultSummary ?? null,
        error_message: errorMessage ?? null,
      }),
    });
    if (!res.ok) {
      console.error(`[admin-job-log] finishJob(${logId}) ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.error(`[admin-job-log] finishJob(${logId}) failed:`, e.message);
  }
}
