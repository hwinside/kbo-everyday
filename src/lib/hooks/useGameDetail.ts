"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import {
  shouldCommitResponse,
  shouldPreserveCanonicalLineup,
  type SourceSnapshot,
} from "@/lib/source-snapshot";
import { useVisibilityAwareInterval } from "@/lib/hooks/useVisibilityAwareInterval";

export type { GameDetailResponse };
export type {
  LineupEntry,
  BatterRecord,
  PitcherRecord,
} from "@/app/api/game-detail/route";

export interface GameDetailSnapshot extends SourceSnapshot {
  lineupSource: NonNullable<GameDetailResponse["trace"]>["lineupSource"];
  boxScoreSource: NonNullable<GameDetailResponse["trace"]>["boxScoreSource"];
}

export function useGameDetail(
  gameId: string | undefined,
  pollInterval = 30000,
) {
  const [data, setData] = useState<GameDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<GameDetailSnapshot | null>(null);
  const stoppedRef = useRef(false);
  const finalSinceRef = useRef<number | null>(null);
  const responseGenerationRef = useRef(0);
  const dataRef = useRef<GameDetailResponse | null>(null);
  const snapshotRef = useRef<GameDetailSnapshot | null>(null);

  // Max 30 min of polling after final (KBO can take time to fill boxScore, especially preseason)
  const FINAL_MAX_POLL_MS = 30 * 60 * 1000;

  const fetchDetail = useCallback(async () => {
    if (!gameId || stoppedRef.current) return;
    const responseGeneration = ++responseGenerationRef.current;
    try {
      const res = await fetch(`/api/game-detail?gameId=${encodeURIComponent(gameId)}`);
      const json = await res.json() as GameDetailResponse & { error?: string };
      if (!shouldCommitResponse(responseGenerationRef.current, responseGeneration)) return;
      if (!res.ok || json.error || !json.trace) {
        setError(json.error || `HTTP ${res.status}`);
        return;
      }
      const incomingSnapshot: GameDetailSnapshot = {
        generation: responseGeneration,
        sourceAtMs: json.trace.sourceAtMs,
        fetchedAtMs: json.trace.fetchedAtMs,
        lineupSource: json.trace.lineupSource,
        boxScoreSource: json.trace.boxScoreSource,
      };
      const preserveLineup = shouldPreserveCanonicalLineup(
        snapshotRef.current?.lineupSource,
        incomingSnapshot.lineupSource,
      );
      const committedSnapshot = preserveLineup && snapshotRef.current
        ? { ...incomingSnapshot, lineupSource: snapshotRef.current.lineupSource }
        : incomingSnapshot;
      const committedData = preserveLineup && dataRef.current?.lineup
        ? {
            ...json,
            lineup: dataRef.current.lineup,
            trace: { ...json.trace, lineupSource: committedSnapshot.lineupSource },
          }
        : json;
      dataRef.current = committedData;
      snapshotRef.current = committedSnapshot;
      setData(committedData);
      setSnapshot(committedSnapshot);
      setError(null);

      const isFinalOrCancelled = json.status === "final" || json.status === "cancelled";
      const hasRealBox = json.boxScore &&
        (json.boxScore.awayBatters?.length > 0 || json.boxScore.homeBatters?.length > 0);

      if (isFinalOrCancelled) {
        if (hasRealBox) {
          // Got real data — stop immediately
          stoppedRef.current = true;
        } else {
          // Final but no boxScore — keep polling up to FINAL_MAX_POLL_MS
          if (!finalSinceRef.current) {
            finalSinceRef.current = Date.now();
          } else if (Date.now() - finalSinceRef.current > FINAL_MAX_POLL_MS) {
            stoppedRef.current = true;
          }
        }
      }
    } catch (e: unknown) {
      if (shouldCommitResponse(responseGenerationRef.current, responseGeneration)) {
        setError((e as Error).message);
      }
    } finally {
      if (shouldCommitResponse(responseGenerationRef.current, responseGeneration)) {
        setLoading(false);
      }
    }
  }, [gameId]);

  // gameId 전환 시 상태 리셋. 첫 fetch·폴링은 아래 visibility-aware 폴러가 담당한다.
  useEffect(() => {
    responseGenerationRef.current++;
    stoppedRef.current = false;
    finalSinceRef.current = null;
    dataRef.current = null;
    snapshotRef.current = null;
    setLoading(true);
  }, [gameId]);

  // 숨은 탭(백그라운드)에선 폴링을 멈춰 Edge Request 낭비를 없애고, 복귀 시 즉시 정확히 1회
  // 실행 후 폴링을 재개한다. resume owner는 이 폴러 하나뿐 — 별도 focus/visibility 복구
  // effect를 두지 않아 복귀 시 중복 요청·listener leak이 없다. 보는 유저 실시간성은 100% 유지.
  // 콜백은 fetchDetail의 Promise를 그대로 반환해 코어의 await 기반 single-flight에 실 fetch를
  // 결속한다. stop(final+box) 후엔 undefined를 반환해 tick이 no-op이 되고, 복귀로도 되살아나지 않는다.
  useVisibilityAwareInterval(
    () => (stoppedRef.current ? undefined : fetchDetail()),
    pollInterval,
    { resetKey: gameId },
  );

  return { data, loading, error, snapshot, refetch: fetchDetail };
}
