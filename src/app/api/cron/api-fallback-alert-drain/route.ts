import { NextRequest, NextResponse } from "next/server";
import { drainApiFallbackAlerts } from "@/lib/monitoring/api-fallback-tracker";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 30;

/**
 * API 열화 경보 recovery drainer (장애대책 슬라이스1, 삼순 3차 NO-GO 반영).
 *
 * fast path(요약 라우트 after())의 즉시 전송이 실패/crash 하면 outbox 는 durable 하게 남는다.
 * 이 크론이 새 열화 이벤트와 독립적으로 due outbox 를 재획득(새 토큰) → 텔레그램 재전송 →
 * 2xx confirm / 실패 nack 한다. 단발 outage 후 요청이 끊겨도 경보가 영구 미발송되지 않게 한다.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await drainApiFallbackAlerts({ leaseSeconds: 120, maxBatch: 20 });
  return NextResponse.json({ ok: true, ...summary });
}
