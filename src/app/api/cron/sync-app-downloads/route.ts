import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getKSTToday } from "@/lib/utils/date-kst";
import { ascConfigured, fetchIosDownloads } from "@/lib/appstore/sales";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

// Apple's sales reports lag ~1–2 days and late-arriving rows can revise a day,
// so re-pull a small trailing window each run and upsert.
const LOOKBACK_DAYS = 5;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ascConfigured()) {
    return NextResponse.json({ error: "ASC credentials not configured" }, { status: 503 });
  }

  const logId = await startJob("sync-app-downloads");
  const today = getKSTToday();
  const rows: { platform: string; date: string; units: number }[] = [];
  const skipped: string[] = [];

  try {
    for (let i = 1; i <= LOOKBACK_DAYS; i++) {
      const date = new Date(
        new Date(today + "T00:00:00+09:00").getTime() - i * 86400000,
      ).toISOString().slice(0, 10);
      const units = await fetchIosDownloads(date);
      if (units === null) {
        skipped.push(date); // report not available yet
        continue;
      }
      rows.push({ platform: "ios", date, units });
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from("app_downloads")
        .upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), {
          onConflict: "platform,date",
        });
      if (error) throw new Error(error.message);
    }

    await finishJob(logId, "success", `ios upserted ${rows.length}, skipped ${skipped.length}`);
    return NextResponse.json({ ok: true, upserted: rows.length, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishJob(logId, "error", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
