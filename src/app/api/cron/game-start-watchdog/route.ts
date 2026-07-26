import { NextRequest, NextResponse } from "next/server";
import type { GameEvent } from "@/types/game-events";
import type { StartPlateAppearanceEvidence } from "@/lib/notifications/start-freshness-policy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { fetchInitialGameEventsBounded } from "@/lib/notifications/start-evidence-fetch";
import { notifyGameStatusTransitions } from "@/lib/notifications/game-status";
import { runGameStartWatchdog } from "@/lib/notifications/game-start-watchdog";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";
import { runBeforeDeadline } from "@/lib/async-deadline";

const CRON_SECRET = process.env.CRON_SECRET || "";
const REQUEST_BUDGET_MS = 14_000;
const KBO_FETCH_MS = 4_000;
const EVIDENCE_FETCH_MS = 3_000;

export const maxDuration = 20;

function getKSTDateStr(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

async function handle(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestStartMs = Date.now();
  const deadlineAtMs = requestStartMs + REQUEST_BUDGET_MS;
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : req.nextUrl.origin);

  try {
    const result = await runGameStartWatchdog({
      fetchGames: async () => {
        const fetched = await fetchKboLiveGames(
          getKSTDateStr(requestStartMs),
          Math.min(deadlineAtMs, Date.now() + KBO_FETCH_MS),
        );
        return {
          ok: fetched.ok,
          games: fetched.games,
          observedAtMs: fetched.trace.fetchedAtMs,
        };
      },
      readStartStates: async (gameIds, readDeadlineAtMs) => {
        const remainingMs = readDeadlineAtMs - Date.now();
        if (remainingMs <= 0) throw new Error("state_read_deadline_exceeded");
        // query-guard: bounded -- KBO 당일 live gameIds(최대 10)만 단일 IN 조회.
        const query = supabaseAdmin
          .from("game_notify_state")
          .select(
            "game_id, start_notified, last_seen_scheduled_at, start_snapshot_at, start_snapshot_deadline_at",
          )
          .in("game_id", gameIds)
          .abortSignal(AbortSignal.timeout(remainingMs));
        const { data, error } = await query;
        if (error) throw new Error(`start state read: ${error.message}`);
        return data ?? [];
      },
      fetchStartEvidence: async (gameIds) => {
        const results = await fetchInitialGameEventsBounded(
          gameIds,
          async (gameId, evidenceDeadlineAtMs) => {
            const remainingMs = Math.max(1, evidenceDeadlineAtMs - Date.now());
            const response = await fetch(`${baseUrl}/api/game-events?gameId=${gameId}`, {
              cache: "no-store",
              headers: { "User-Agent": "kbo-game-start-watchdog/1.0" },
              signal: AbortSignal.timeout(remainingMs),
            });
            const json = response.ok
              ? await runBeforeDeadline(() => response.json(), evidenceDeadlineAtMs).catch(() => null)
              : null;
            return {
              gameId,
              ok: response.ok,
              status: response.status,
              events: (json?.events ?? []) as GameEvent[],
              eventCount: response.ok ? Number((json?.events ?? []).length) : null,
              startPlateAppearance:
                (json?.startPlateAppearance ?? null) as StartPlateAppearanceEvidence | null,
            };
          },
          Math.min(EVIDENCE_FETCH_MS, Math.max(1, deadlineAtMs - Date.now())),
        );
        return new Map(results.flatMap((result) =>
          result.ok && result.startPlateAppearance
            ? [[result.gameId, result.startPlateAppearance] as const]
            : []));
      },
      notifyStartTransitions: async (games, params) =>
        notifyGameStatusTransitions(games, params),
      isCancelled: isKboGameCancelled,
    }, deadlineAtMs);

    return NextResponse.json({
      ok: true,
      ...result,
      elapsedMs: Date.now() - requestStartMs,
    });
  } catch (error) {
    console.error("[game-start-watchdog] failed:", (error as Error).message);
    return NextResponse.json({
      ok: false,
      error: (error as Error).message,
      elapsedMs: Date.now() - requestStartMs,
    }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
