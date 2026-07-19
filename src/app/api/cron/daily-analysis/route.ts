import { NextRequest, NextResponse } from "next/server";
import { runDailyAnalysis } from "@/lib/analysis/daily-analysis-core";

// 매일 01:00 KST 백스톱 크론. 어제 경기를 분석해 오늘 날짜로 저장 + 스냅샷 갱신.
// 저녁 daily-analysis-live 트리거가 이미 당일 분석을 만들었어도, 다음날 새벽 이 크론이
// 정식 날짜(오늘)로 재저장하며 스냅샷/휴식일 복사까지 담당한다. 핵심 로직은 core에 있다.
const CRON_SECRET = process.env.CRON_SECRET || "";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { status, body } = await runDailyAnalysis("scheduled");
  return NextResponse.json(body, { status });
}
