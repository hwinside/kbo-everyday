import { NextRequest, NextResponse } from "next/server";
import { runLineupWatchdog } from "@/lib/notifications/lineup-watchdog";

const CRON_SECRET = process.env.CRON_SECRET || "";
const REQUEST_BUDGET_MS = 16_000;
const LINEUP_FETCH_MS = 3_000;

export const maxDuration = 30;

function getKSTDateStr(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 라인업 확정 알림 watchdog (하린아빠 스펙 2026-07-29, #cs 1785295937.731339).
 * 매분(경기 전 시간대) 오늘의 미시작 경기를 훑어 KBO LINEUP_CK=true(확정) 최초 전이 시
 * 홈/원정 각 팀 팬에게 자기 팀 라인업 확정 푸시를 1회 보낸다(원장 단일 전이 보장).
 * 오케스트레이션(snapshot-first·공정 drain·deadline 전파·systemic 실패 판정)은 runLineupWatchdog 담당.
 */
async function handle(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startMs = Date.now();
  const result = await runLineupWatchdog({
    dateStr: getKSTDateStr(startMs),
    deadlineAtMs: startMs + REQUEST_BUDGET_MS,
    lineupFetchMs: LINEUP_FETCH_MS,
  });

  // false-green 차단: systemic 실패는 non-2xx 로 노출(Vercel cron health 가 red).
  const httpStatus = result.status === "failed" ? 502 : 200;
  return NextResponse.json(
    { ok: result.status === "ok", tookMs: Date.now() - startMs, ...result },
    { status: httpStatus },
  );
}

export async function GET(req: NextRequest) {
  return handle(req);
}
