import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { getKSTToday } from "@/lib/utils/date-kst";

export const dynamic = "force-dynamic";

type Row = { day: string; platform: string; devices: number; hits: number };
type PlatformStat = { todayDevices: number; peakDevices: number; totalHits: number };

/**
 * 워치(갤워치 Wear OS + 애플워치) 앱 사용 계측 조회 — 미들웨어가 record_watch_ping으로 적재한
 * 일자·플랫폼별 집계. devices = distinct 해시IP(대략의 워치 대수), hits = 워치 API 호출량.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const daysParam = Number(new URL(req.url).searchParams.get("days") || "14");
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 90) : 14;

  const sinceDate = new Date(getKSTToday() + "T00:00:00Z");
  sinceDate.setUTCDate(sinceDate.getUTCDate() - (days - 1));
  const since = sinceDate.toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("admin_watch_activity", { p_since: since });
  if (error) return supabaseErrorResponse(error);

  const rows: Row[] = (
    (data ?? []) as { day: string; platform: string; devices: number; hits: number }[]
  ).map((r) => ({
    day: r.day,
    platform: r.platform,
    devices: Number(r.devices),
    hits: Number(r.hits),
  }));

  const today = getKSTToday();
  const stat = (platform: string): PlatformStat => {
    const pr = rows.filter((r) => r.platform === platform);
    return {
      todayDevices: pr.find((r) => r.day === today)?.devices ?? 0,
      peakDevices: pr.reduce((m, r) => Math.max(m, r.devices), 0),
      totalHits: pr.reduce((s, r) => s + r.hits, 0),
    };
  };

  return NextResponse.json({
    since,
    days,
    rows,
    wear: stat("wear"),
    apple: stat("apple"),
  });
}
