import type { KboRawGame } from "@/types/api";

// 안드 위젯 fast-refresh(warmup 함수 내부 루프) 오케스트레이션 — route.ts에서 분리해
// fake clock/주입 의존성으로 deadline·오류 분기를 테스트한다(삼순 #718 fast-loop NO-GO).

/**
 * 요청 진입 시각 기준 *절대* deadline(ms) — maxDuration 60s에서 마지막 relay/FCM 청크가
 * 완료될 여유(~14s)를 남긴다. 기존 warmup 작업(알림/LA 등)이 오래 걸려도 +20/+40 tick이
 * 이 선을 넘으면 sleep/fetch/push를 시작하지 않아 다음 크론 틱(60s)과 겹치지 않는다
 * (삼순 blocker① — loop-상대 시각이 아닌 요청-절대 시각 기준).
 */
export const FAST_LOOP_DEADLINE_MS = 46_000;
/** 요청 진입 시각 기준 추가 사이클 목표 시점 — cron(60s) 사이 ~20s 간격 갱신. */
export const FAST_LOOP_TARGETS_MS: readonly number[] = [20_000, 40_000];
/** 초기 snapshot은 첫 fast tick보다 2초 먼저 실제 요청까지 중단해 늦은 옛 상태 발송을 막는다. */
export const INITIAL_PUSH_DEADLINE_MS = 18_000;

export function initialWidgetPushDeadlineAt(
  requestStartMs: number,
  overallDeadlineAtMs: number,
): number {
  return Math.min(overallDeadlineAtMs, requestStartMs + INITIAL_PUSH_DEADLINE_MS);
}

export interface WidgetSourceTrace {
  /** KBO 원천 요청 시작 시각(epoch ms). */
  sourceAtMs: number;
  /** KBO 응답 JSON 검증 완료 시각(epoch ms). */
  fetchedAtMs: number;
}

/**
 * KBO GetKboGameList 응답 최소 계약. JSON 파싱 실패·game 배열 누락·행 identity/state
 * 손상은 모두 null로 fail-close한다. 잘못된 응답을 정상 "라이브 0"으로 축약하면 다음
 * fast tick 재시도까지 사라지므로, 빈 배열은 game:[]이 명시된 경우에만 정상이다.
 */
export function parseKboGameListPayload(value: unknown): KboRawGame[] | null {
  if (value === null || typeof value !== "object") return null;
  const games = (value as { game?: unknown }).game;
  if (!Array.isArray(games)) return null;
  for (const row of games) {
    if (row === null || typeof row !== "object") return null;
    const game = row as Record<string, unknown>;
    if (typeof game.G_ID !== "string" || !/^\d{8}[A-Z]{4}\d$/.test(game.G_ID)) return null;
    if (typeof game.GAME_STATE_SC !== "string" || !["1", "2", "3"].includes(game.GAME_STATE_SC)) return null;
    if (typeof game.AWAY_NM !== "string" || game.AWAY_NM.trim().length === 0) return null;
    if (typeof game.HOME_NM !== "string" || game.HOME_NM.trim().length === 0) return null;
  }
  return games as KboRawGame[];
}

export interface FastLoopDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * KBO 라이브 스코어보드 재조회. ok:false = HTTP/network 실패 — "라이브 0"과 구분해
   * 루프를 끊지 않고 다음 tick에서 재시도한다(삼순 blocker② — 오류를 경기 종료로 오인 금지).
   */
  fetchLiveGames(): Promise<{ ok: boolean; games: KboRawGame[]; trace?: WidgetSourceTrace }>;
  pushWidgets(games: KboRawGame[], trace: WidgetSourceTrace): Promise<unknown>;
}

export interface FastLoopTick {
  atMs: number;
  result: unknown;
}

interface InitialWidgetPushInput {
  games: KboRawGame[];
  baseUrl: string;
  sourceAtMs: number;
  fetchedAtMs: number;
}

type InitialWidgetPush<T> = (
  games: KboRawGame[],
  baseUrl: string,
  opts: { deadlineAtMs: number; sourceAtMs: number; fetchedAtMs: number },
) => Promise<T>;

/**
 * 초기 위젯 push와 +20/+40 fast-loop를 같은 tick에서 시작한다. 어느 한쪽이 지연돼도
 * 다른 쪽의 시작을 막지 않도록 Promise를 먼저 둘 다 만들고, route 본작업과 병렬로 둔다.
 */
export function startWidgetRefreshPipelines<T>(deps: {
  pushInitial: InitialWidgetPush<T>;
  runFast(): Promise<FastLoopTick[]>;
}, opts: {
  requestStartMs: number;
  overallDeadlineAtMs: number;
  initial: InitialWidgetPushInput | null;
  initialSkipped: T;
}): { initialPromise: Promise<T>; fastPromise: Promise<FastLoopTick[]> } {
  const initialPromise = opts.initial == null
    ? Promise.resolve(opts.initialSkipped)
    : deps.pushInitial(opts.initial.games, opts.initial.baseUrl, {
        deadlineAtMs: initialWidgetPushDeadlineAt(opts.requestStartMs, opts.overallDeadlineAtMs),
        sourceAtMs: opts.initial.sourceAtMs,
        fetchedAtMs: opts.initial.fetchedAtMs,
      });
  const fastPromise = deps.runFast();
  return { initialPromise, fastPromise };
}

/**
 * fast-refresh 루프 실행. 각 tick은 requestStartMs + target 시점에 발사되며,
 * 모든 단계(sleep 시작·fetch 시작·push 시작)가 requestStartMs + deadlineMs 안에서만 시작된다.
 * 정상 응답에 라이브 경기가 0이면 종료, fetch 실패면 다음 tick 재시도.
 */
export async function runWidgetFastLoop(
  deps: FastLoopDeps,
  opts: { requestStartMs: number; targetsMs?: readonly number[]; deadlineMs?: number },
): Promise<FastLoopTick[]> {
  const targets = opts.targetsMs ?? FAST_LOOP_TARGETS_MS;
  const deadlineAt = opts.requestStartMs + (opts.deadlineMs ?? FAST_LOOP_DEADLINE_MS);
  const ticks: FastLoopTick[] = [];
  for (const targetMs of targets) {
    const targetAt = opts.requestStartMs + targetMs;
    // 이 tick의 목표 시점 자체가 deadline 밖이거나 이미 deadline 도달 → 루프 종료.
    if (targetAt >= deadlineAt || deps.now() >= deadlineAt) break;
    const waitMs = targetAt - deps.now();
    if (waitMs > 0) await deps.sleep(waitMs);
    if (deps.now() >= deadlineAt) break;
    const atMs = deps.now() - opts.requestStartMs;
    try {
      const fresh = await deps.fetchLiveGames();
      if (!fresh.ok) {
        // HTTP/network 실패 — 경기 종료로 오인해 break하지 않고 다음 tick 재시도(삼순 blocker②).
        ticks.push({ atMs, result: { error: "live_fetch_failed", retryNextTick: true } });
        continue;
      }
      const hasLive = fresh.games.some((g) => g.G_ID && g.GAME_STATE_SC === "2");
      if (!hasLive) break; // 정상 응답 + 라이브 0 → 모든 경기 종료, 루프 종료.
      if (deps.now() >= deadlineAt) break; // fetch가 남은 시간을 소진 → FCM/relay 시작 금지(blocker①).
      const trace = fresh.trace ?? { sourceAtMs: atMs + opts.requestStartMs, fetchedAtMs: deps.now() };
      const w = await deps.pushWidgets(fresh.games, trace);
      ticks.push({ atMs, result: w });
    } catch (e) {
      ticks.push({ atMs, result: { error: (e as Error).message } });
    }
  }
  return ticks;
}
