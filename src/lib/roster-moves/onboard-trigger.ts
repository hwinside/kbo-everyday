/**
 * 신규 선수 온보딩 자동 트리거 (2026-08-01, #cs 1785572202.838849).
 *
 * 배경: 카라스코(56103)가 KBO 등록명단에 뜬 것을 roster-moves cron이 17:02에 이미 감지했지만
 * (roster_moves register/pending 기록됨), roster SSOT 온보딩(사진 다운로드 + players-roster.json
 * 등록)은 다음 새벽 05시 배치까지 기다려야 했다. 그 사이 선수 사진이 이니셜 폴백으로 노출된다.
 *
 * 계약:
 *   - 이번 run이 감지한 register 무브 중 **roster SSOT에 아직 없는** kboId가 하나라도 있으면
 *     `update-roster-stats.yml` workflow_dispatch 를 1회 보낸다.
 *   - "roster SSOT에 없다"는 판정은 readiness의 `missing`에 `roster`가 포함되는지로 한다
 *     (resolvePlayer 기반 — 외국인 FP/AQ canonical 변환까지 동일 의미론).
 *   - 트리거는 **best-effort**다. 실패해도 cron 본체 결과(스냅샷/무브/승격)를 바꾸지 않는다.
 *     온보딩은 어차피 새벽 배치가 다시 처리하므로 여기서 5xx를 낼 이유가 없다.
 *
 * 중복 방어 (자동 PR 난립 차단):
 *   - GitHub Actions 최근 run 목록을 조회해 **진행 중(queued/in_progress) run이 있으면 skip**.
 *   - 최근 `MIN_DISPATCH_INTERVAL_MS` 이내에 시작된 run이 있으면 skip(같은 날 30분 tick마다
 *     같은 미등록 선수를 계속 보게 되므로, 이 쿨다운이 실질적 dedupe 역할을 한다).
 *   - 위 두 판정은 **GitHub 실제 상태**를 근거로 한다. 로컬 메모리 플래그는 서버리스 인스턴스마다
 *     달라 신뢰할 수 없다.
 */

const OWNER = "hwinside";
const REPO = "kbo-everyday";
const WORKFLOW = "update-roster-stats.yml";

/** 직전 run 시작 후 이 시간 안에는 다시 dispatch 하지 않는다(크롤~머지 13~14분 + 여유). */
export const MIN_DISPATCH_INTERVAL_MS = 30 * 60 * 1000;

/** GitHub run 목록에서 dedupe 판정에 필요한 최소 필드. */
export interface WorkflowRunSummary {
  status: string | null;
  created_at: string | null;
}

export type OnboardTriggerDecision =
  | { dispatch: false; reason: "no-new-players" }
  | { dispatch: false; reason: "run-in-flight" }
  | { dispatch: false; reason: "cooldown"; sinceMs: number }
  | { dispatch: true; players: string[] };

/**
 * dispatch 여부 순수 판정 — HTTP 없이 테스트 가능한 코어.
 * @param newPlayers roster SSOT 미등록으로 판정된 kboId 목록
 * @param recentRuns GitHub Actions 최근 run 요약(최신순일 필요 없음)
 * @param nowMs 현재 시각
 */
export function decideOnboardDispatch(
  newPlayers: string[],
  recentRuns: WorkflowRunSummary[],
  nowMs: number,
): OnboardTriggerDecision {
  if (newPlayers.length === 0) return { dispatch: false, reason: "no-new-players" };

  const inFlight = recentRuns.some(
    (run) => run.status === "queued" || run.status === "in_progress" || run.status === "requested"
      || run.status === "waiting" || run.status === "pending",
  );
  if (inFlight) return { dispatch: false, reason: "run-in-flight" };

  let newestStartMs: number | null = null;
  for (const run of recentRuns) {
    if (!run.created_at) continue;
    const startedMs = Date.parse(run.created_at);
    if (Number.isNaN(startedMs)) continue;
    if (newestStartMs === null || startedMs > newestStartMs) newestStartMs = startedMs;
  }
  if (newestStartMs !== null) {
    const sinceMs = nowMs - newestStartMs;
    // 미래 타임스탬프(시계 skew)는 방금 시작한 것으로 보수적으로 취급한다.
    if (sinceMs < MIN_DISPATCH_INTERVAL_MS) {
      return { dispatch: false, reason: "cooldown", sinceMs };
    }
  }

  // 호출부가 Set으로 걸러 넘기지만, 순수 함수 자체도 중복을 제거해 보고값이 항상 유일하게 한다.
  return { dispatch: true, players: [...new Set(newPlayers)].sort() };
}

export type OnboardTriggerStatus =
  | "no-new-players"
  | "run-in-flight"
  | "cooldown"
  | "no-token"
  | "dispatched"
  | "list-error"
  | "dispatch-error";

export interface OnboardTriggerResult {
  status: OnboardTriggerStatus;
  players?: string[];
}

export interface OnboardTriggerDeps {
  fetchImpl: typeof fetch;
  token: string;
  now: () => number;
  deadlineAtMs?: number;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * roster SSOT 미등록 신규 등록 선수가 있으면 크롤 워크플로를 1회 dispatch 한다.
 * 절대 throw 하지 않는다 — 호출부(cron)의 성공/실패 판정에 영향을 주지 않는다.
 */
export async function triggerRosterOnboarding(
  newPlayers: string[],
  deps: OnboardTriggerDeps,
): Promise<OnboardTriggerResult> {
  if (newPlayers.length === 0) return { status: "no-new-players" };
  if (!deps.token) return { status: "no-token" };

  const signal = deps.deadlineAtMs == null
    ? undefined
    : AbortSignal.timeout(Math.max(1, deps.deadlineAtMs - deps.now()));

  let recentRuns: WorkflowRunSummary[];
  try {
    const res = await deps.fetchImpl(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      { headers: githubHeaders(deps.token), signal },
    );
    if (!res.ok) return { status: "list-error" };
    const body = await res.json() as { workflow_runs?: WorkflowRunSummary[] };
    recentRuns = body.workflow_runs ?? [];
  } catch {
    // 목록을 못 읽으면 dedupe 판정 불가 → dispatch 하지 않는다(자동 PR 난립보다 지연이 안전).
    return { status: "list-error" };
  }

  const decision = decideOnboardDispatch(newPlayers, recentRuns, deps.now());
  if (!decision.dispatch) return { status: decision.reason };

  try {
    const res = await deps.fetchImpl(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(deps.token), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
        signal,
      },
    );
    if (res.status !== 204) return { status: "dispatch-error" };
  } catch {
    return { status: "dispatch-error" };
  }

  return { status: "dispatched", players: decision.players };
}
