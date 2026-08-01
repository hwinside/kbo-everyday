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
import {
  AUTO_WORKFLOWS,
  evaluateAutoPrHealth,
  formatAutoPrAlert,
  type OpenPrInfo,
  type WorkflowRunInfo,
} from "@/lib/admin/auto-pr-health";

const CRON_SECRET = process.env.CRON_SECRET || "";
const GH_OWNER = "hwinside";
const GH_REPO = "kbo-everyday";
/** 하린아빠 텔레그램 chat_id — daily-fallback-report와 동일 대상. */
const ADMIN_TELEGRAM_CHAT_ID = "6796048731";

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

    let outcome: { sent: number; failed: number; queryError?: boolean } = { sent: 0, failed: 0 };
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
    if (outcome.queryError) writeErrors.push(`push-query:${alert.jobName}`);

    if (decideAlertPersistence(outcome) === "revert") {
      // 전송 전패 또는 구독 조회 오류 → claim 되돌려 다음 틱 재시도. revert 실패는 5xx로 노출.
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

  // ── 자동 PR 파이프라인 감시(2026-08-01 하린아빠 지시)
  // job-health는 roster-update를 tracked=false + 데이터 신선도로만 보기 때문에
  // 자동 PR이 죽어도 스탯이 48h 이내면 green이었다(7/26·7/27 실패 + #893·#699 방치가
  // 며칠간 무알림으로 넘어간 이유). GitHub 상태를 직접 조회해 별도 판정한다.
  // best-effort — 이 블록 실패가 기존 job 알림 결과를 무효화하지 않는다.
  let autoPr: { checked: number; issues: number; sent: number; error?: string } = {
    checked: 0,
    issues: 0,
    sent: 0,
  };
  try {
    autoPr = await runAutoPrWatch(nowIso);
  } catch (e) {
    autoPr = { checked: 0, issues: 0, sent: 0, error: (e as Error).message };
  }

  const body = {
    checked: current.length,
    problems: current.filter((c) => isProblem(c.level)).length,
    alerts: alerts.length,
    claimed,
    sent: sentTotal,
    reverted,
    autoPr,
    writeErrors,
  };
  if (writeErrors.length > 0) {
    return NextResponse.json(body, { status: 500 });
  }
  return NextResponse.json(body);
}

/**
 * 자동 PR 파이프라인 이상 감지 → 상태 전이 시 1회 알림.
 *
 * 기존 job 알림과 동일하게 `admin_alert_state`를 써 전이에서만 보낸다
 * (30분마다 같은 알림이 반복되면 결국 무시하게 된다).
 * 알림은 어드민 푸시 + 텔레그램 양쪽으로 보낸다 — 푸시 구독이 없거나 기기가
 * 꺼져 있으면 그것만으로는 "바로 알 수 있게"라는 요구를 못 맞춘다.
 */
async function runAutoPrWatch(nowIso: string) {
  const token = process.env.GITHUB_PAT;
  if (!token) return { checked: 0, issues: 0, sent: 0, error: "GITHUB_PAT not configured" };

  const nowMs = Date.parse(nowIso);
  const gh = async (path: string) => {
    const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub ${path} HTTP ${res.status}`);
    return res.json();
  };

  // 워크플로별 최근 run + 열린 PR 목록
  const runsByKey = new Map<string, WorkflowRunInfo[]>();
  for (const def of AUTO_WORKFLOWS) {
    const data = await gh(`/actions/workflows/${def.workflowFile}/runs?per_page=10`) as {
      workflow_runs?: { status: string | null; conclusion: string | null; created_at: string | null; html_url?: string }[];
    };
    runsByKey.set(
      def.key,
      (data.workflow_runs ?? []).map((r) => ({
        status: r.status,
        conclusion: r.conclusion,
        createdAt: r.created_at,
        htmlUrl: r.html_url ?? null,
      })),
    );
  }
  const prData = await gh("/pulls?state=open&per_page=100") as {
    number: number;
    head?: { ref?: string };
    created_at: string | null;
  }[];
  const openPrs: OpenPrInfo[] = prData.map((pr) => ({
    number: pr.number,
    headRefName: pr.head?.ref ?? "",
    createdAt: pr.created_at,
    // 체크 상태는 PR당 추가 요청이 필요해 여기선 조회하지 않는다.
    // 적체 판정은 "열린 시간" 기준이라 체크 여부와 무관하게 성립한다(#699 사례).
    checksPassing: null,
  }));

  const issues = evaluateAutoPrHealth(AUTO_WORKFLOWS, runsByKey, openPrs, nowMs);
  const issueByKey = new Map(issues.map((i) => [i.key, i]));

  // 전이 판정용 직전 상태(job 알림과 같은 테이블, key 네임스페이스만 다름)
  const { data: prevRows, error: prevErr } = await supabase
    .from("admin_alert_state")
    .select("job_name,level")
    .in("job_name", AUTO_WORKFLOWS.map((d) => d.key));
  if (prevErr) throw new Error(`admin_alert_state read: ${prevErr.message}`);
  const prev = new Map<string, string>(
    (prevRows ?? []).map((r) => [r.job_name as string, r.level as string]),
  );

  let sent = 0;
  for (const def of AUTO_WORKFLOWS) {
    const issue = issueByKey.get(def.key);
    const nextLevel = issue ? issue.kind : "healthy";
    const prevLevel = prev.get(def.key) ?? null;
    if (prevLevel === nextLevel) continue; // 같은 상태 유지 = 무알림

    const { error: writeErr } = await supabase
      .from("admin_alert_state")
      .upsert(
        {
          job_name: def.key,
          level: nextLevel,
          reason: issue?.reason ?? "정상",
          updated_at: nowIso,
        },
        { onConflict: "job_name" },
      );
    if (writeErr) throw new Error(`admin_alert_state write: ${writeErr.message}`);

    const title = issue ? "⚠️ 자동 PR 파이프라인 이상" : "✅ 자동 PR 파이프라인 복구";
    const text = issue ? formatAutoPrAlert(issue) : `${def.label} 정상 복귀`;
    await Promise.allSettled([
      sendAdminPush({ title, body: text, url: "/admin/jobs", tag: `auto-pr-${def.key}` }),
      sendTelegramAlert(`${title}\n${text}`),
    ]);
    sent++;
  }

  return { checked: AUTO_WORKFLOWS.length, issues: issues.length, sent };
}

/** 텔레그램 best-effort 발송 — 토큰 미설정/실패여도 throw 하지 않는다. */
async function sendTelegramAlert(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // 알림 실패가 cron 자체를 죽이지 않는다(푸시 경로가 남아 있다).
  }
}
