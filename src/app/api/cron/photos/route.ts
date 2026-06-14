import { NextRequest, NextResponse } from "next/server";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";

const CDN_BASE = "https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/2026";
const CRON_SECRET = process.env.CRON_SECRET || "";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("photos-check");
  const roster = playersRoster as RosterPlayer[];

  // Only check numeric kboIds (CDN photos)
  const cdnPlayers = roster.filter((p) => /^\d+$/.test(p.kboId));

  let found = 0;
  let missing = 0;
  let errors = 0;

  try {
    // HEAD requests to check photo existence - batch with rate limiting
    for (let i = 0; i < cdnPlayers.length; i++) {
      const p = cdnPlayers[i];
      try {
        const res = await fetch(`${CDN_BASE}/${p.kboId}.jpg`, {
          method: "HEAD",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          found++;
        } else {
          missing++;
        }
      } catch {
        errors++;
      }

      // Rate limit: ~20 req/s
      if (i % 20 === 19) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const foreignCount = roster.length - cdnPlayers.length;
    const summary = `CDN 확인 ${cdnPlayers.length}명: 존재 ${found}, 누락 ${missing}, 에러 ${errors} / 외국인(미확인) ${foreignCount}명`;

    await finishJob(logId, "success", summary);

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      total: roster.length,
      cdnChecked: cdnPlayers.length,
      found,
      missing,
      errors,
      foreignSkipped: foreignCount,
    });
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
