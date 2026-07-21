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

export interface FastLoopDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * KBO 라이브 스코어보드 재조회. ok:false = HTTP/network 실패 — "라이브 0"과 구분해
   * 루프를 끊지 않고 다음 tick에서 재시도한다(삼순 blocker② — 오류를 경기 종료로 오인 금지).
   */
  fetchLiveGames(): Promise<{ ok: boolean; games: KboRawGame[] }>;
  pushWidgets(games: KboRawGame[]): Promise<unknown>;
}

export interface FastLoopTick {
  atMs: number;
  result: unknown;
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
      const w = await deps.pushWidgets(fresh.games);
      ticks.push({ atMs, result: w });
    } catch (e) {
      ticks.push({ atMs, result: { error: (e as Error).message } });
    }
  }
  return ticks;
}
