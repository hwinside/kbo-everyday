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

/** auto PR이 이 시간을 넘도록 열려 있으면 적체로 본다(크롤~머지 정상 소요는 15분 내외). */
export const PR_STALE_HOURS = 12;

export interface WorkflowRunInfo {
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
}

export type AutoPrIssueKind = "run-failed" | "pr-stale" | "never-ran";

export interface AutoPrIssue {
  key: string;
  label: string;
  kind: AutoPrIssueKind;
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
 * 판정 순서에 의미가 있다: run 실패(①)가 있으면 그것이 가장 직접적인 사유이므로 먼저 보고,
 * 그다음 PR 적체(②), 마지막으로 미실행(③)을 본다. 여러 이상이 겹쳐도 알림은 잡당 1건으로
 * 묶어 도배를 막는다(상세는 어드민 화면에서 확인).
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
  if (!latest) {
    return {
      key: def.key,
      label: def.label,
      kind: "never-ran",
      reason: `실행 기록이 없습니다 (${def.workflowFile})`,
    };
  }

  // ① 최신 완료 run이 실패 — **나이와 무관하게** 먼저 보고한다.
  //    오래된 실패를 "미실행"으로 바꿔 알리면 진짜 원인(빌드 깨짐)을 가린다.
  //    실패 후 재시도가 안 도는 상황도 결국 "마지막 실행이 실패(N일째)"로 둘 다 전달된다.
  const latestCompleted = sorted.find((r) => r.status === "completed");
  if (latestCompleted && latestCompleted.conclusion && latestCompleted.conclusion !== "success") {
    const age = ageHours(latestCompleted.createdAt, nowMs);
    return {
      key: def.key,
      label: def.label,
      kind: "run-failed",
      reason:
        `마지막 실행이 ${latestCompleted.conclusion}` +
        (age !== null ? ` (${fmtAge(age)})` : "") +
        (latestCompleted.htmlUrl ? `\n${latestCompleted.htmlUrl}` : ""),
    };
  }

  // ③ 미실행 — 주기의 2배를 넘도록 최신 run이 없다(스케줄러가 죽은 경우).
  //    가장 조용한 실패라 별도 판정이 필요하다 — ①은 워크플로가 돌아야만 잡힌다.
  const latestAge = ageHours(latest.createdAt, nowMs);
  if (latestAge !== null && latestAge > def.intervalHours * 2) {
    return {
      key: def.key,
      label: def.label,
      kind: "never-ran",
      reason: `${fmtAge(latestAge)} 실행되지 않았습니다 (예정 주기 ${def.intervalHours}시간)`,
    };
  }

  // ② auto PR 적체 — 열린 지 오래된 것이 있으면 머지 파이프라인이 막힌 것이다.
  //    checks가 성공인데도 방치된 케이스(#699)가 실제로 있었으므로 checks 성공 여부와
  //    무관하게 "열려 있는 시간"으로 판정한다.
  const stalePrs = openPrs
    .filter((pr) => pr.headRefName.startsWith(def.branchPrefix))
    .map((pr) => ({ pr, age: ageHours(pr.createdAt, nowMs) }))
    .filter((x) => x.age !== null && x.age > PR_STALE_HOURS)
    .sort((a, b) => (b.age as number) - (a.age as number));

  if (stalePrs.length > 0) {
    const detail = stalePrs
      .map(({ pr, age }) => {
        const checks = pr.checksPassing === null
          ? "체크 미상"
          : pr.checksPassing
            ? "체크 통과(머지만 안 됨)"
            : "체크 실패";
        return `#${pr.number} ${fmtAge(age as number)} · ${checks}`;
      })
      .join("\n");
    return {
      key: def.key,
      label: def.label,
      kind: "pr-stale",
      reason: `미머지 자동 PR ${stalePrs.length}건\n${detail}`,
    };
  }

  return null;
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
