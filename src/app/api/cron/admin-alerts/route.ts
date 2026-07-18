import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import statsMeta from "@/lib/constants/stats-2026-meta.json";
import {
  JOB_DEFS,
  computeJobHealth,
  decideAdminAlerts,
  decideAlertPersistence,
  isProblem,
  type JobLevelSnapshot,
} from "@/lib/admin/job-health";
import { sendAdminPush } from "@/lib/admin/push";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

/**
 * 크롤러/배치 이상 감지 → 어드민 PWA 푸시 (2026-07-18, 30분 주기).
 *
 * 판정은 /api/admin/jobs/health와 동일한 job-health 순수 함수를 재사용하고,
 * admin_alert_state에 job별 직전 레벨을 저장해 "상태 전이 시에만" 알림을 보낸다.
 *
 * 신뢰성 계약 (PR #681 삼순 P1 반영):
 * - 모든 상태/로그 DB 조회 오류 = fail closed → 5xx (prev=empty로 오판해 전체 재알림 금지)
 * - 전이는 CAS로 claim: 직전 레벨 일치 시에만 상태 전진 → 동시 실행이 겹쳐도 승자 1회만 발송
 * - 전달 실패(sent=0 && failed>0) 시 claim revert → 다음 틱 재시도 (영구 누락 방지)
 * - 상태 쓰기 실패도 5xx로 노출 (Vercel cron 실패 집계에 잡히도록)
 *
 * 알려진 edge(비차단): problem→unknown→healthy 순 전이 시 unknown 시점에 상태가 덮여
 * 복구 알림이 생략된다. unknown은 "판정 불가(회색)"라 경고도 복구도 만들지 않는 보수
 * 정책의 트레이드오프.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const meta = statsMeta as Record<string, string>;
  const generatedAt = meta.battersGeneratedAt ?? meta.pitchersGeneratedAt ?? null;

  // job별 최신 로그 1건 병렬 조회 — 조회 실패는 fail closed (stale 오판 방지)
  const latestResults = await Promise.all(
    JOB_DEFS.map(async (def) => {
      const { data, error } = await supabase
        .from("admin_job_logs")
        .select("status,started_at")
        .eq("job_name", def.name)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) return { error: true as const };
      const row = data?.[0] as { status: string | null; started_at: string | null } | undefined;
      return { error: false as const, status: row?.status ?? null, startedAt: row?.started_at ?? null };
    }),
  );
  if (latestResults.some((r) => r.error)) {
    return NextResponse.json({ error: "admin_job_logs query failed" }, { status: 500 });
  }

  const current: JobLevelSnapshot[] = JOB_DEFS.map((def, i) => {
    const latest = latestResults[i] as { status: string | null; startedAt: string | null };
    const health = computeJobHealth(
      def,
      {
        latestStatus: latest.status,
        latestAt: latest.startedAt,
        dataGeneratedAt: def.dataFreshness ? generatedAt : null,
      },
      now,
    );
    return { jobName: def.name, label: def.label, level: health.level, reason: health.reason };
  });

  // 직전 상태 조회 — 실패 시 fail closed (prev=empty 오판이 전체 재알림을 만들 수 있음)
  const { data: prevRows, error: prevError } = await supabase
    .from("admin_alert_state")
    .select("job_name,level");
  if (prevError) {
    return NextResponse.json({ error: "admin_alert_state query failed" }, { status: 500 });
  }
  const prev = new Map<string, string>(
    (prevRows ?? []).map((r) => [r.job_name as string, r.level as string]),
  );

  const alerts = decideAdminAlerts(prev, current);
  const alertJobNames = new Set(alerts.map((a) => a.jobName));

  const writeErrors: string[] = [];
  let sentTotal = 0;
  let claimed = 0;
  let reverted = 0;

  // 전이 job: CAS claim → 승자만 발송 → 전달 실패 시 revert
  for (const alert of alerts) {
    let won = false;
    if (alert.prevLevel === null) {
      // 직전 행 없음 → insert가 성공한 쪽이 승자 (동시 실행은 PK 충돌로 탈락)
      const { data, error } = await supabase
        .from("admin_alert_state")
        .upsert(
          { job_name: alert.jobName, level: alert.newLevel, reason: alert.reason, updated_at: nowIso },
          { onConflict: "job_name", ignoreDuplicates: true },
        )
        .select("job_name");
      if (error) {
        writeErrors.push(`claim-insert:${alert.jobName}`);
        continue;
      }
      won = (data?.length ?? 0) > 0;
    } else {
      // 직전 레벨 일치 시에만 전진 — affected 0이면 다른 실행이 이미 claim한 것
      const { data, error } = await supabase
        .from("admin_alert_state")
        .update({ level: alert.newLevel, reason: alert.reason, updated_at: nowIso })
        .eq("job_name", alert.jobName)
        .eq("level", alert.prevLevel)
        .select("job_name");
      if (error) {
        writeErrors.push(`claim-update:${alert.jobName}`);
        continue;
      }
      won = (data?.length ?? 0) > 0;
    }
    if (!won) continue;
    claimed++;

    let outcome = { sent: 0, failed: 0 };
    try {
      outcome = await sendAdminPush({
        title: alert.kind === "problem" ? "⚠️ 크롤러/배치 이상" : "✅ 크롤러/배치 복구",
        body:
          alert.kind === "problem"
            ? `${alert.label}: ${alert.reason}`
            : `${alert.label} 정상 복귀`,
        url: "/admin/jobs",
        tag: `admin-job-${alert.jobName}`,
      });
    } catch {
      outcome = { sent: 0, failed: 1 };
    }
    sentTotal += outcome.sent;

    if (decideAlertPersistence(outcome) === "revert") {
      // 전송 전패 → claim 되돌려 다음 틱 재시도. revert 실패는 5xx로 노출.
      reverted++;
      if (alert.prevLevel === null) {
        const { error } = await supabase
          .from("admin_alert_state")
          .delete()
          .eq("job_name", alert.jobName)
          .eq("level", alert.newLevel);
        if (error) writeErrors.push(`revert-delete:${alert.jobName}`);
      } else {
        const { error } = await supabase
          .from("admin_alert_state")
          .update({ level: alert.prevLevel, updated_at: nowIso })
          .eq("job_name", alert.jobName)
          .eq("level", alert.newLevel);
        if (error) writeErrors.push(`revert-update:${alert.jobName}`);
      }
    }
  }

  // 비전이 job: 레벨 동일할 때만 reason/updated_at 갱신 (CAS — 동시 실행의 새 claim을 덮지 않음).
  // 직전 행 없는 정상(healthy 등) job은 insert-if-absent로 초기 상태만 기록.
  for (const job of current) {
    if (alertJobNames.has(job.jobName)) continue;
    const prevLevel = prev.get(job.jobName) ?? null;
    if (prevLevel === null) {
      // 문제 없는 신규 job 초기 기록 (problem인데 알림이 안 만들어진 케이스는 없음 — 전이로 잡힘)
      const { error } = await supabase
        .from("admin_alert_state")
        .upsert(
          { job_name: job.jobName, level: job.level, reason: job.reason, updated_at: nowIso },
          { onConflict: "job_name", ignoreDuplicates: true },
        );
      if (error) writeErrors.push(`init:${job.jobName}`);
    } else if (prevLevel === job.level) {
      const { error } = await supabase
        .from("admin_alert_state")
        .update({ reason: job.reason, updated_at: nowIso })
        .eq("job_name", job.jobName)
        .eq("level", job.level);
      if (error) writeErrors.push(`touch:${job.jobName}`);
    }
    // prevLevel !== job.level 인데 alerts에 없음 = unknown 관련 무시 전이 → 상태 유지(덮지 않음)
  }

  const body = {
    checked: current.length,
    problems: current.filter((c) => isProblem(c.level)).length,
    alerts: alerts.length,
    claimed,
    sent: sentTotal,
    reverted,
    writeErrors,
  };
  if (writeErrors.length > 0) {
    return NextResponse.json(body, { status: 500 });
  }
  return NextResponse.json(body);
}
