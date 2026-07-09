import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getKSTToday } from "@/lib/utils/date-kst";
import { ascConfigured, fetchIosDownloads } from "@/lib/appstore/sales";
import { playStatsConfigured, fetchAndroidDownloads } from "@/lib/play/installs";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

// Apple/Google install reports lag ~1–2 days and late-arriving rows can revise
// a day, so re-pull a small trailing window each run and upsert.
const LOOKBACK_DAYS = 5;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ascConfigured() && !playStatsConfigured()) {
    return NextResponse.json({ error: "No store credentials configured" }, { status: 503 });
  }

  const logId = await startJob("sync-app-downloads");
  const today = getKSTToday();
  const rows: { platform: string; date: string; units: number }[] = [];
  const skipped: string[] = [];

  // Trailing window of KST dates (D-1 … D-LOOKBACK). Anchoring at 00:00 UTC
  // (not +09:00) keeps toISOString()'s date aligned with the KST day — a
  // +09:00 midnight is 15:00 UTC the *previous* day, which would shift D-1→D-2.
  const dates: string[] = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  try {
    if (ascConfigured()) {
      for (const date of dates) {
        const units = await fetchIosDownloads(date);
        if (units === null) {
          skipped.push(`ios:${date}`); // report not available yet
          continue;
        }
        rows.push({ platform: "ios", date, units });
      }
    }

    if (playStatsConfigured()) {
      const android = await fetchAndroidDownloads(dates);
      for (const date of dates) {
        const units = android.get(date);
        if (units === undefined) {
          skipped.push(`android:${date}`); // report not available yet
          continue;
        }
        rows.push({ platform: "android", date, units });
      }
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from("app_downloads")
        .upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), {
          onConflict: "platform,date",
        });
      if (error) throw new Error(error.message);
    }

    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.platform] = (acc[r.platform] ?? 0) + 1;
      return acc;
    }, {});
    await finishJob(
      logId,
      "success",
      `ios upserted ${counts.ios ?? 0}, android upserted ${counts.android ?? 0}, skipped ${skipped.length}`,
    );
    return NextResponse.json({ ok: true, upserted: rows.length, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishJob(logId, "error", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
