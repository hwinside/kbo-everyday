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
/**
 * 텔레그램 수신 chat id — Production env(`TELEGRAM_CHAT_ID`)를 쓴다.
 * 개인 chat id 하드코딩 금지(삼순 R1). 미설정이면 텔레그램 경로는 "미전송"으로 집계한다.
 */
const ADMIN_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

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
  // ⚠️ 감시기 자체가 죽어도 HTTP 200 이면 또 다른 silent-success 다 (삼순 R1 P0).
  // 기존 job 알림 결과는 지키되(부분 실패 격리), 감시기 실패는 writeErrors 를 통해
  // 5xx 로 외부에서 관측 가능하게 만든다.
  let autoPr: {
    checked: number; issues: number; sent: number;
    claimed?: number; reverted?: number; writeErrors?: string[]; error?: string;
  } = { checked: 0, issues: 0, sent: 0 };
  const autoPrErrors: string[] = [];
  try {
    autoPr = await runAutoPrWatch(nowIso);
    if (autoPr.error) autoPrErrors.push(`autopr-watch:${autoPr.error}`);
    if (autoPr.writeErrors && autoPr.writeErrors.length > 0) autoPrErrors.push(...autoPr.writeErrors);
  } catch (e) {
    autoPr = { checked: 0, issues: 0, sent: 0, error: (e as Error).message };
    autoPrErrors.push(`autopr-watch:${(e as Error).message}`);
  }

  const body = {
    checked: current.length,
    problems: current.filter((c) => isProblem(c.level)).length,
    alerts: alerts.length,
    claimed,
    sent: sentTotal,
    reverted,
    autoPr,
    writeErrors: [...writeErrors, ...autoPrErrors],
  };
  if (writeErrors.length > 0 || autoPrErrors.length > 0) {
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
/**
 * 회귀가 실제 route 로직을 태울 수 있도록 외부 의존을 주입 가능하게 둔다 (삼순 R1 P1).
 * 예전 스모크는 순수 evaluator 만 호출해서, 이 함수의 상태·발송 코드를 통째로 지워도
 * prebuild 가 PASS 하는 false-green 이었다.
 */
export interface AutoPrWatchDeps {
  db?: typeof supabase;
  fetchGitHub?: (path: string) => Promise<unknown>;
  push?: typeof sendAdminPush;
  telegram?: (text: string) => Promise<{ sent: number; failed: number }>;
  token?: string | null;
}

export async function runAutoPrWatch(nowIso: string, deps: AutoPrWatchDeps = {}) {
  const db = deps.db ?? supabase;
  const pushFn = deps.push ?? sendAdminPush;
  const telegramFn = deps.telegram ?? sendTelegramAlert;
  const token = deps.token !== undefined ? deps.token : process.env.GITHUB_PAT;
  if (!token) throw new Error("GITHUB_PAT not configured");

  const nowMs = Date.parse(nowIso);
  const gh = deps.fetchGitHub ?? (async (path: string) => {
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
  });

  // 워크플로별 최근 run + 열린 PR 목록
  const runsByKey = new Map<string, WorkflowRunInfo[]>();
  for (const def of AUTO_WORKFLOWS) {
    const data = await gh(`/actions/workflows/${def.workflowFile}/runs?per_page=10`) as {
      workflow_runs?: { id?: number; status: string | null; conclusion: string | null; created_at: string | null; html_url?: string }[];
    };
    runsByKey.set(
      def.key,
      (data.workflow_runs ?? []).map((r) => ({
        id: r.id ?? null, // event fingerprint 축 — 다음 실패 run 을 새 사건으로 구분한다
        status: r.status,
        conclusion: r.conclusion,
        createdAt: r.created_at,
        htmlUrl: r.html_url ?? null,
      })),
    );
  }
  const prData = await gh("/pulls?state=open&per_page=100") as {
    number: number;
    head?: { ref?: string; sha?: string };
    html_url?: string;
    created_at: string | null;
  }[];

  // 감시 대상 브랜치의 PR 만 골라 **check 상태를 실제로 조회**한다 (삼순 R1 P0).
  // 예전에는 조회하지 않고 checksPassing=null 로 두어 "check FAIL 즉시" 계약을 못 지켰다.
  // 대상 접두사로 먼저 좁히므로 추가 요청은 자동 PR 몇 건뿐이다(전체 PR 수와 무관).
  const watched = prData.filter((pr) =>
    AUTO_WORKFLOWS.some((def) => (pr.head?.ref ?? "").startsWith(def.branchPrefix)),
  );
  const checksByNumber = new Map<number, boolean | null>();
  for (const pr of watched) {
    const sha = pr.head?.sha;
    if (!sha) { checksByNumber.set(pr.number, null); continue; }
    const status = await gh(`/commits/${sha}/check-runs?per_page=100`) as {
      check_runs?: { status: string | null; conclusion: string | null }[];
    };
    const runs = status.check_runs ?? [];
    const completed = runs.filter((r) => r.status === "completed");
    if (completed.length === 0) {
      checksByNumber.set(pr.number, null); // 아직 판정 불가
    } else {
      const bad = completed.some(
        (r) => r.conclusion !== null && !["success", "neutral", "skipped"].includes(r.conclusion),
      );
      checksByNumber.set(pr.number, !bad);
    }
  }

  const openPrs: OpenPrInfo[] = prData.map((pr) => ({
    number: pr.number,
    headRefName: pr.head?.ref ?? "",
    createdAt: pr.created_at,
    checksPassing: checksByNumber.has(pr.number) ? (checksByNumber.get(pr.number) ?? null) : null,
    htmlUrl: pr.html_url ?? null,
  }));

  const issues = evaluateAutoPrHealth(AUTO_WORKFLOWS, runsByKey, openPrs, nowMs);
  const issueByKey = new Map(issues.map((i) => [i.key, i]));

  // 전이 판정용 직전 상태(job 알림과 같은 테이블, key 네임스페이스만 다름)
  // query-guard: bounded -- job_name은 PK이고 IN 목록이 컴파일 상수 AUTO_WORKFLOWS로 고정되어
  // 반환 행 수가 감시 대상 워크플로 개수(현재 2)를 절대 넘지 않는다(런타임 입력 없음).
  const { data: prevRows, error: prevErr } = await db
    .from("admin_alert_state")
    .select("job_name,level")
    .in("job_name", AUTO_WORKFLOWS.map((d) => d.key));
  if (prevErr) throw new Error(`admin_alert_state read: ${prevErr.message}`);
  const prev = new Map<string, string>(
    (prevRows ?? []).map((r) => [r.job_name as string, r.level as string]),
  );

  let sent = 0;
  let claimedCount = 0;
  let revertedCount = 0;
  const writeErrors: string[] = [];

  for (const def of AUTO_WORKFLOWS) {
    const issue = issueByKey.get(def.key);
    // dedupe 단위는 "종류"가 아니라 **동일 event**다 (삼순 R1 P0).
    // kind 만 저장하면 다음 날 다른 run 이 또 실패해도, 새 stale PR 이 추가돼도 무알림이었다.
    const nextLevel = issue ? `${issue.kind}|${issue.fingerprint}` : "healthy";
    const prevLevel = prev.get(def.key) ?? null;
    if (prevLevel === nextLevel) continue; // 같은 event 유지 = 무알림

    // 최초 healthy 는 상태만 초기화하고 "복구" 알림을 보내지 않는다 (삼순 R1).
    // 신규 key 가 healthy 로 처음 기록될 때 가짜 복구 알림이 나가던 문제.
    const firstSeenHealthy = prevLevel === null && !issue;

    // ── CAS claim — 기존 job 알림과 동일 계약. 동시 실행이 겹쳐도 승자 1회만 발송.
    let won = false;
    if (prevLevel === null) {
      const { data, error } = await db
        .from("admin_alert_state")
        .upsert(
          { job_name: def.key, level: nextLevel, reason: issue?.reason ?? "정상", updated_at: nowIso },
          { onConflict: "job_name", ignoreDuplicates: true },
        )
        .select("job_name");
      if (error) { writeErrors.push(`autopr-claim-insert:${def.key}`); continue; }
      won = (data?.length ?? 0) > 0;
    } else {
      const { data, error } = await db
        .from("admin_alert_state")
        .update({ level: nextLevel, reason: issue?.reason ?? "정상", updated_at: nowIso })
        .eq("job_name", def.key)
        .eq("level", prevLevel)
        .select("job_name");
      if (error) { writeErrors.push(`autopr-claim-update:${def.key}`); continue; }
      won = (data?.length ?? 0) > 0;
    }
    if (!won) continue;
    claimedCount++;
    if (firstSeenHealthy) continue; // 상태만 기록하고 발송하지 않는다

    const title = issue ? "⚠️ 자동 PR 파이프라인 이상" : "✅ 자동 PR 파이프라인 복구";
    const text = issue ? formatAutoPrAlert(issue) : `${def.label} 정상 복귀`;

    // ── 전달 결과를 **집계**한다. 예전에는 allSettled 결과를 버리고 무조건 sent++ 했다.
    let push: { sent: number; failed: number; queryError?: boolean } = { sent: 0, failed: 0 };
    try {
      push = await pushFn({ title, body: text, url: "/admin/jobs", tag: `auto-pr-${def.key}` });
    } catch {
      push = { sent: 0, failed: 1 };
    }
    let telegram: { sent: number; failed: number } = { sent: 0, failed: 1 };
    try {
      telegram = await telegramFn(`${title}\n${text}`);
    } catch {
      telegram = { sent: 0, failed: 1 };
    }
    const outcome = {
      sent: push.sent + telegram.sent,
      failed: push.failed + telegram.failed,
      queryError: push.queryError,
    };
    sent += outcome.sent;
    if (push.queryError) writeErrors.push(`autopr-push-query:${def.key}`);

    // 전패(또는 구독 조회 오류)면 claim 을 되돌려 다음 tick 에 재시도한다.
    if (decideAlertPersistence(outcome) === "revert") {
      revertedCount++;
      if (prevLevel === null) {
        const { error } = await db
          .from("admin_alert_state").delete()
          .eq("job_name", def.key).eq("level", nextLevel);
        if (error) writeErrors.push(`autopr-revert-delete:${def.key}`);
      } else {
        const { error } = await db
          .from("admin_alert_state")
          .update({ level: prevLevel, updated_at: nowIso })
          .eq("job_name", def.key).eq("level", nextLevel);
        if (error) writeErrors.push(`autopr-revert-update:${def.key}`);
      }
    }
  }

  return {
    checked: AUTO_WORKFLOWS.length,
    issues: issues.length,
    sent,
    claimed: claimedCount,
    reverted: revertedCount,
    writeErrors,
  };

}

/**
 * 텔레그램 발송 — **실제 결과**를 돌려준다 (삼순 R1 P0).
 *
 * 예전에는 토큰 없음·network error·HTTP 4xx/5xx 를 전부 성공처럼 삼켜서,
 * 전달이 한 건도 안 됐는데 상태만 "알림 완료"로 굳고 다음 tick 은 같은 레벨이라 skip 했다.
 * throw 하지 않는 계약은 유지하되(푸시 경로가 남아 있다), 결과는 숨기지 않는다.
 */
async function sendTelegramAlert(text: string): Promise<{ sent: number; failed: number }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !ADMIN_TELEGRAM_CHAT_ID) return { sent: 0, failed: 1 };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10_000),
    });
    // HTTP 200 이 아니면 전달 안 된 것이다 — res.ok 를 반드시 본다.
    return res.ok ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
  } catch {
    return { sent: 0, failed: 1 };
  }
}
