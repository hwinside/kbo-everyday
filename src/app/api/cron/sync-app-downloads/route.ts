import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getKSTToday } from "@/lib/utils/date-kst";
import { ascConfigured, fetchIosDownloads } from "@/lib/appstore/sales";
import { playStatsConfigured, fetchAndroidDownloads } from "@/lib/play/installs";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 60;

// Apple sales reports lag ~1–2 days and late-arriving rows can revise a day,
// so re-pull a small trailing window each run and upsert.
const IOS_LOOKBACK_DAYS = 5;

// Google's Play stats CSVs are published 3–7 days after the fact (per-day
// rows can appear well after a 5-day window), so Android needs a longer
// trailing window than iOS or late-published days are silently dropped forever.
// https://support.google.com/googleplay/android-developer/answer/6135870
const ANDROID_LOOKBACK_DAYS = 10;

function trailingKstDates(today: string, days: number): string[] {
  const dates: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

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

  // Trailing windows of KST dates (D-1 … D-LOOKBACK, platform-specific — see
  // lookback constants above). Anchoring at 00:00 UTC (not +09:00) keeps
  // toISOString()'s date aligned with the KST day — a +09:00 midnight is
  // 15:00 UTC the *previous* day, which would shift D-1→D-2.

  try {
    if (ascConfigured()) {
      for (const date of trailingKstDates(today, IOS_LOOKBACK_DAYS)) {
        const units = await fetchIosDownloads(date);
        if (units === null) {
          skipped.push(`ios:${date}`); // report not available yet
          continue;
        }
        rows.push({ platform: "ios", date, units });
      }
    }

    if (playStatsConfigured()) {
      const androidDates = trailingKstDates(today, ANDROID_LOOKBACK_DAYS);
      const android = await fetchAndroidDownloads(androidDates);
      for (const date of androidDates) {
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
