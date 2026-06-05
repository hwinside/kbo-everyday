/**
 * admin_job_logs 기록 헬퍼 (GH Action용, 의존성 0).
 *
 * run-batch 가 service_role 로 Supabase PostgREST 에 직접 startJob/finishJob 기록 →
 * 어드민 `/admin/jobs` 카드·히스토리에 hero-shot-batch 실행이 그대로 노출된다.
 * (Vercel cron 이 아니라 GH Action 이라 src/lib/admin/job-logger.ts 를 못 쓰므로 같은 스키마로 포팅.)
 *
 * env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * CI(GITHUB_ACTIONS) 에서는 어드민 모니터링이 *필수 요구사항*이라 startJob/finishJob
 * 실패(env 누락·REST·RLS·schema 등)를 **fatal** 로 던진다 — silent 하게 기록 없이
 * "성공"하는 구멍 차단(삼순 조건부 NO-GO). 로컬(비 CI)에서만 no-op 허용(dry-run 등).
 */

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const IN_CI = Boolean(process.env.GITHUB_ACTIONS);

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

/** running 행 insert → 로그 id 반환. (CI: 실패 시 throw / 로컬: null) */
export async function startJob(jobName) {
  if (!enabled()) {
    if (IN_CI) {
      throw new Error(
        "[admin-job-log] CI 필수 — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락으로 admin 모니터링 불가"
      );
    }
    return null;
  }
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
    if (!res.ok) throw new Error(`startJob(${jobName}) ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    const id = rows?.[0]?.id ?? null;
    if (id == null) throw new Error(`startJob(${jobName}) 응답에 로그 id 없음`);
    return id;
  } catch (e) {
    if (IN_CI) throw new Error(`[admin-job-log] ${e.message}`);
    console.error(`[admin-job-log] startJob(${jobName}) failed:`, e.message);
    return null;
  }
}

/** 로그 행 마감 (status + 한 줄 요약 + duration). (CI: 실패 시 throw / 로컬: no-op) */
export async function finishJob(logId, status, resultSummary, errorMessage) {
  if (!logId) {
    if (IN_CI) throw new Error("[admin-job-log] finishJob: 로그 id 없음 — admin 마감 불가");
    return;
  }
  if (!enabled()) {
    if (IN_CI) throw new Error("[admin-job-log] finishJob: Supabase env 누락 — admin 마감 불가");
    return;
  }
  try {
    // duration 계산은 best-effort (select 실패해도 마감 자체는 진행).
    let startedAt = null;
    try {
      const sel = await fetch(`${URL_BASE}/rest/v1/admin_job_logs?id=eq.${logId}&select=started_at`, {
        headers: headers(),
      });
      startedAt = sel.ok ? (await sel.json())?.[0]?.started_at : null;
    } catch {
      /* duration 계산용 — 무시 */
    }
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
    if (!res.ok) throw new Error(`finishJob(${logId}) ${res.status}: ${await res.text()}`);
  } catch (e) {
    if (IN_CI) throw new Error(`[admin-job-log] ${e.message}`);
    console.error(`[admin-job-log] finishJob(${logId}) failed:`, e.message);
  }
}
