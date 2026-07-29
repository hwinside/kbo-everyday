import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { fetchLineupConfirmed } from "@/lib/crawler/lineup-confirmed";
import { formatLineupConfirmMessage } from "@/lib/notifications/lineup-confirm-message";
import { deliverLineupConfirm } from "@/lib/notifications/lineup-confirm-delivery";

const CRON_SECRET = process.env.CRON_SECRET || "";
const REQUEST_BUDGET_MS = 16_000;
const LINEUP_FETCH_MS = 3_000;
const PER_TEAM_ATTEMPT_MS = 6_000;

export const maxDuration = 30;

function getKSTDateStr(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 라인업 확정 알림 watchdog (하린아빠 스펙 2026-07-29, #cs 1785295937.731339).
 * 매분(경기 전 시간대) 오늘의 미시작 경기를 훑어 KBO LINEUP_CK=true(확정) 최초 전이 시
 * 홈/원정 각 팀 팬에게 자기 팀 라인업 확정 푸시를 1회 보낸다(원장 단일 전이 보장).
 * 취소/연기/이미 시작(live/final) 경기는 건너뛴다(gate ② fail-safe).
 */
async function handle(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startMs = Date.now();
  const deadlineAtMs = startMs + REQUEST_BUDGET_MS;
  const dateStr = getKSTDateStr(startMs);

  const summary = { scheduled: 0, confirmed: 0, snapshots: 0, accepted: 0, errors: 0 };

  let games;
  try {
    games = await fetchGames(dateStr);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), summary });
  }

  // 미시작(scheduled) 경기만 — live/final/cancelled 는 라인업 확정 알림 대상 아님(fail-safe).
  const scheduled = games.filter((g) => g.status === "scheduled");
  summary.scheduled = scheduled.length;

  for (const game of scheduled) {
    if (Date.now() >= deadlineAtMs) break;
    let confirmed: boolean | null = null;
    try {
      confirmed = await fetchLineupConfirmed(game.gameId, { timeoutMs: LINEUP_FETCH_MS });
    } catch {
      summary.errors++;
      continue;
    }
    if (confirmed !== true) continue;
    summary.confirmed++;

    // 홈/원정 각 팀 팬에게 자기 팀 라인업 확정 푸시. 원장이 (game,team)별 최초 1회를 보장.
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      if (Date.now() >= deadlineAtMs) break;
      try {
        const msg = formatLineupConfirmMessage({
          teamId,
          confirmedAt: new Date(),
          gameTimeKst: game.time,
        });
        const result = await deliverLineupConfirm({
          gameId: game.gameId,
          teamId,
          observedAtMs: Date.now(),
          payload: { title: msg.title, body: msg.body, url: `/games/${game.gameId}?tab=lineup` },
          attemptDeadlineAtMs: Math.min(deadlineAtMs, Date.now() + PER_TEAM_ATTEMPT_MS),
        });
        summary.accepted += result.fcmAcceptedDelta;
        if (result.snapshotCompleted) summary.snapshots++;
      } catch {
        summary.errors++;
      }
    }
  }

  return NextResponse.json({ ok: true, dateStr, tookMs: Date.now() - startMs, summary });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
