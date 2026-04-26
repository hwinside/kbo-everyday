import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";

const CRON_SECRET = process.env.CRON_SECRET || "";

const JOB_PATHS: Record<string, string> = {
  "youtube-highlights": "/api/cron/highlights",
  "videos": "/api/cron/videos",
  "videos-shorts": "/api/cron/videos-shorts",
  "stats-update": "/api/cron/stats",
  "daily-analysis": "/api/cron/daily-analysis",
  "retention": "/api/cron/retention",
  "daily-fallback-report": "/api/cron/daily-fallback-report",
  "photos-check": "/api/cron/photos",
};

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function POST(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobName = body.job as string;

  if (!jobName || !JOB_PATHS[jobName]) {
    return NextResponse.json(
      { error: `Unknown job: ${jobName}` },
      { status: 400 },
    );
  }

  const cronPath = JOB_PATHS[jobName];
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    req.nextUrl.origin;

  try {
    const res = await fetch(`${baseUrl}${cronPath}`, {
      method: "GET",
      headers: CRON_SECRET
        ? { Authorization: `Bearer ${CRON_SECRET}` }
        : {},
    });

    const data = await res.json().catch(() => null);

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      data,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
