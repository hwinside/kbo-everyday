import { NextRequest, NextResponse } from "next/server";
import { runStarterWatchdog } from "@/lib/notifications/starter-watchdog";

const CRON_SECRET = process.env.CRON_SECRET || "";
const REQUEST_BUDGET_MS = 16_000;
// KBO 예고선발은 연전 첫날 시리즈 전체(D+1·D+2 포함)가 공시될 수 있어 오늘부터 3일치를 훑는다.
const DATE_SPAN_DAYS = 3;

export const maxDuration = 30;

function getKSTDateStr(nowMs: number, offsetDays = 0): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/**
 * 예고선발 공개 알림 watchdog (유저 제안 #cs 1785380092.155589, 삼순 조건부 GO 계약).
 * 오늘~D+2 의 미시작 경기를 훑어 양팀 선발이 빈값→공식값으로 채워진 최초 전이 시
 * 홈/원정 각 팀 팬에게 예고선발 공개 푸시를 1회 보낸다(원장 단일 전이 보장 — 재수집/cron 중복 실행 중복 0).
 * 오케스트레이션(격리 병렬·due drainer·deadline 전파·systemic 실패 판정)은 runStarterWatchdog 담당.
 */
async function handle(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startMs = Date.now();
  const dateStrs = Array.from({ length: DATE_SPAN_DAYS }, (_, i) => getKSTDateStr(startMs, i));
  const result = await runStarterWatchdog({
    dateStrs,
    deadlineAtMs: startMs + REQUEST_BUDGET_MS,
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
