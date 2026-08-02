/**
 * 자동 PR 파이프라인 건강도 판정 (2026-08-01 하린아빠 지시, #cs 1785572202.838849).
 *
 * 배경: "저번에도 실패 PR이 쌓이는 걸 감지하지 못한 채 며칠이 지났다."
 * 실측(2026-08-01):
 *   - 자동 크롤 run 실패 7/26·7/27, 그런데 아무 알림도 없었다.
 *   - 미머지 auto PR #893(6일째)·#699(2주째)가 방치돼 있었다. #699는 checks가 전부
 *     SUCCESS인데도 그냥 안 머지된 채였다.
 *   - GHA 워크플로에 `if: failure()` 알림 스텝이 0건이었고,
 *   - job-health의 roster-update는 tracked=false + 데이터 신선도만 봐서, 자동 PR이 죽어도
 *     스탯이 48h 이내면 green이었다.
 * 즉 "조용히 실패한" 게 아니라 **실패를 볼 수 있는 장치 자체가 없었다.**
 *
 * 이 모듈은 세 가지 실패 양상을 각각 잡는다(하나만으로는 구멍이 남는다):
 *   ① run 실패        — 워크플로가 돌았는데 conclusion=failure
 *   ② PR 적체         — auto/* PR이 열린 채 임계 시간을 넘김(checks 성공이어도 방치면 문제)
 *   ③ 미실행(silent)  — 예정 주기를 한참 넘도록 run 자체가 없음(스케줄러가 죽은 경우.
 *                      ①은 워크플로가 실행돼야만 잡히므로 이게 없으면 가장 조용한 실패를 놓친다)
 *
 * 순수 함수라 HTTP/DB 없이 테스트한다.
 */

/** 감시 대상 자동 워크플로. */
export interface AutoWorkflowDef {
  /** admin_alert_state 키 겸 알림 식별자. */
  key: string;
  /** 사람이 읽는 이름. */
  label: string;
  /** GitHub Actions 워크플로 파일명. */
  workflowFile: string;
  /** 이 워크플로가 만드는 PR 브랜치 접두사(적체 판정용). */
  branchPrefix: string;
  /** 정상 실행 주기(시간). 이 값의 2배를 넘도록 run이 없으면 미실행으로 본다. */
  intervalHours: number;
}

export const AUTO_WORKFLOWS: AutoWorkflowDef[] = [
  {
    key: "roster-stats-auto-pr",
    label: "로스터/스탯 자동 PR",
    workflowFile: "update-roster-stats.yml",
    branchPrefix: "auto/update-roster-stats",
    intervalHours: 24,
  },
  {
    key: "hero-shot-auto-pr",
    label: "히어로샷 자동 PR",
    workflowFile: "hero-shot-batch.yml",
    branchPrefix: "auto/hero-shot",
    intervalHours: 24,
  },
];

/**
 * auto PR이 이 시간을 넘도록 열려 있으면 적체로 본다.
 * 정상 크롤~머지 소요가 15분 내외라 **30분**을 임계로 둔다(삼순 합의값).
 * check FAIL은 시간과 무관하게 즉시(다음 poll) 잡는다 — 아래 evaluateAutoWorkflow 참조.
 */
export const PR_STALE_HOURS = 0.5;

export interface WorkflowRunInfo {
  /** run 고유 id — event fingerprint 의 축. 없으면 createdAt 으로 대체한다. */
  id?: number | string | null;
  /** queued | in_progress | completed ... */
  status: string | null;
  /** success | failure | cancelled | null(미완료) */
  conclusion: string | null;
  createdAt: string | null;
  htmlUrl?: string | null;
}

export interface OpenPrInfo {
  number: number;
  headRefName: string;
  createdAt: string | null;
  /** 모든 체크가 성공인지. null = 판정 불가. */
  checksPassing: boolean | null;
  /** 알림 본문에 넣을 PR 링크. */
  htmlUrl?: string | null;
}

export type AutoPrIssueKind = "run-failed" | "pr-stale" | "never-ran";

export interface AutoPrIssue {
  key: string;
  label: string;
  kind: AutoPrIssueKind;
  /**
   * **동일 event 1회** dedupe 키 (삼순 R1 P0).
   * kind 만으로 dedupe 하면 `run-failed` 가 한 번 기록된 뒤 다음 날 다른 run 이 또 실패해도
   * 같은 레벨이라 무알림이 된다. 새 stale PR 이 추가돼도 마찬가지다.
   * run id·PR 번호·check 상태를 지문에 넣어 **새 사건이면 다시 알린다**.
   */
  fingerprint: string;
  /** 사람이 읽는 사유 — 알림 본문에 그대로 쓴다. */
  reason: string;
}

function ageHours(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 3_600_000;
}

function fmtAge(hours: number): string {
  if (hours < 1) return "방금";
  if (hours < 24) return `${Math.floor(hours)}시간째`;
  return `${Math.floor(hours / 24)}일째`;
}

/**
 * 한 워크플로의 이상 여부를 판정한다.
 *
 * run 실패(①)·PR 적체(②)·미실행(③)을 모두 판정한다. 여러 이상이 겹치면 알림은 잡당
 * 1건으로 묶되 지문과 본문에는 모두 넣어, 같은 run 실패 아래 새 PR 문제가 생겨도 놓치지 않는다.
 *
 * @param runs 최신순일 필요 없음 — 내부에서 createdAt으로 정렬한다.
 * @param openPrs 열려 있는 PR 전체(브랜치 접두사로 이 워크플로 것만 골라 쓴다)
 */
export function evaluateAutoWorkflow(
  def: AutoWorkflowDef,
  runs: WorkflowRunInfo[],
  openPrs: OpenPrInfo[],
  nowMs: number,
): AutoPrIssue | null {
  const sorted = [...runs]
    .filter((r) => r.createdAt)
    .sort((a, b) => Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string));

  const latest = sorted[0];
  const events: { kind: AutoPrIssueKind; fingerprint: string; reason: string }[] = [];

  // ① 최신 완료 run이 실패 — **나이와 무관하게** 먼저 보고한다.
  //    오래된 실패를 "미실행"으로 바꿔 알리면 진짜 원인(빌드 깨짐)을 가린다.
  //    실패 후 재시도가 안 도는 상황도 결국 "마지막 실행이 실패(N일째)"로 둘 다 전달된다.
  const latestCompleted = sorted.find((r) => r.status === "completed");
  if (latestCompleted && latestCompleted.conclusion && latestCompleted.conclusion !== "success") {
    const age = ageHours(latestCompleted.createdAt, nowMs);
    events.push({
      kind: "run-failed",
      // run 고유 id 를 지문에 넣는다 — 다음 날 **다른 run** 이 또 실패하면 새 event 로 다시 알린다.
      fingerprint: `run:${latestCompleted.id ?? latestCompleted.createdAt ?? "unknown"}:${latestCompleted.conclusion}`,
      reason:
        `마지막 실행이 ${latestCompleted.conclusion}` +
        (age !== null ? ` (${fmtAge(age)})` : "") +
        (latestCompleted.htmlUrl ? `\n${latestCompleted.htmlUrl}` : ""),
    });
  }

  // ③ 미실행 — 주기의 2배를 넘도록 최신 run이 없다(스케줄러가 죽은 경우).
  //    가장 조용한 실패라 별도 판정이 필요하다 — ①은 워크플로가 돌아야만 잡힌다.
  const latestAge = ageHours(latest?.createdAt, nowMs);
  if (!latest) {
    events.push({
      kind: "never-ran",
      fingerprint: "never-ran:no-runs",
      reason: `실행 기록이 없습니다 (${def.workflowFile})`,
    });
  } else if (latestAge !== null && latestAge > def.intervalHours * 2) {
    events.push({
      kind: "never-ran",
      // 방치가 길어질수록 "며칠째"가 바뀐다 — 하루 단위로 새 event 로 본다(계속 조용해지지 않게).
      fingerprint: `never-ran:${Math.floor(latestAge / 24)}d`,
      reason: `${fmtAge(latestAge)} 실행되지 않았습니다 (예정 주기 ${def.intervalHours}시간)`,
    });
  }

  // ② auto PR 문제 — 두 축을 본다(삼순 R1 요구).
  //    (a) check FAIL 은 **시간과 무관하게 즉시**(다음 poll) — 고장난 PR 을 30분 기다릴 이유가 없다.
  //    (b) 열린 지 임계(30분)를 넘김 — checks 가 성공인데도 방치된 케이스(#699)가 실제로 있었다.
  const mine = openPrs
    .filter((pr) => pr.headRefName.startsWith(def.branchPrefix))
    .map((pr) => ({ pr, age: ageHours(pr.createdAt, nowMs) }));

  const problemPrs = mine
    .filter(({ pr, age }) => pr.checksPassing === false || (age !== null && age > PR_STALE_HOURS))
    .sort((a, b) => (b.age ?? 0) - (a.age ?? 0));

  if (problemPrs.length > 0) {
    const detail = problemPrs
      .map(({ pr, age }) => {
        const checks = pr.checksPassing === null
          ? "체크 미상"
          : pr.checksPassing
            ? "체크 통과(머지만 안 됨)"
            : "체크 실패";
        const url = pr.htmlUrl ? ` ${pr.htmlUrl}` : "";
        return `#${pr.number} ${age === null ? "" : fmtAge(age) + " · "}${checks}${url}`;
      })
      .join("\n");
    events.push({
      kind: "pr-stale",
      // PR 번호 + check 상태를 지문에 넣는다 — 새 PR 이 추가되거나 check 상태가 바뀌면 다시 알린다.
      fingerprint: `pr:${problemPrs
        .map(({ pr }) => `${pr.number}/${pr.checksPassing === null ? "?" : pr.checksPassing ? "ok" : "fail"}`)
        .sort()
        .join(",")}`,
      reason: `자동 PR 문제 ${problemPrs.length}건\n${detail}`,
    });
  }

  if (events.length === 0) return null;

  // run 실패가 오래 유지되는 동안 새 check-fail/적체 PR이 생겨도 별도 사건으로 다시
  // 알리기 위해 모든 동시 원인을 지문과 본문에 포함한다. 한 워크플로당 발송은 1건으로
  // 묶되, 새 원인이 추가되면 fingerprint가 바뀌어 CAS 알림이 다시 열린다.
  const priority: AutoPrIssueKind[] = ["run-failed", "pr-stale", "never-ran"];
  const ordered = [...events].sort(
    (a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind),
  );
  return {
    key: def.key,
    label: def.label,
    kind: ordered[0].kind,
    fingerprint: ordered.map((event) => event.fingerprint).join("|"),
    reason: ordered.map((event) => event.reason).join("\n\n"),
  };
}

/** 감시 대상 전체를 평가한다. */
export function evaluateAutoPrHealth(
  defs: AutoWorkflowDef[],
  runsByKey: Map<string, WorkflowRunInfo[]>,
  openPrs: OpenPrInfo[],
  nowMs: number,
): AutoPrIssue[] {
  const out: AutoPrIssue[] = [];
  for (const def of defs) {
    const issue = evaluateAutoWorkflow(def, runsByKey.get(def.key) ?? [], openPrs, nowMs);
    if (issue) out.push(issue);
  }
  return out;
}

/** 알림 본문 — 텔레그램/푸시 공용. */
export function formatAutoPrAlert(issue: AutoPrIssue): string {
  const head = issue.kind === "run-failed"
    ? "🔴 자동 PR 실행 실패"
    : issue.kind === "pr-stale"
      ? "🟠 자동 PR 적체"
      : "🟡 자동 배치 미실행";
  return `${head}\n${issue.label}: ${issue.reason}`;
}
