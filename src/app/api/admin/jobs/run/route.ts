import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

const CRON_SECRET = process.env.CRON_SECRET || "";

const JOB_PATHS: Record<string, string> = {
  "youtube-highlights": "/api/cron/highlights",
  "videos-rss": "/api/cron/videos",
  "videos-player-shorts": "/api/cron/videos-shorts",
  "stats-update": "/api/cron/stats",
  "game-logs-ingest": "/api/cron/game-logs",
  "daily-analysis": "/api/cron/daily-analysis",
  "retention": "/api/cron/retention",
  "daily-fallback-report": "/api/cron/daily-fallback-report",
  "photos-check": "/api/cron/photos",
};

const GITHUB_WORKFLOW_JOBS: Record<
  string,
  { owner: string; repo: string; workflow: string }
> = {
  "roster-update": {
    owner: "hwinside",
    repo: "kbo-everyday",
    workflow: "update-roster-stats.yml",
  },
  "hero-shot-batch": {
    owner: "hwinside",
    repo: "kbo-everyday",
    workflow: "hero-shot-batch.yml",
  },
};

const ALL_JOBS = new Set([...Object.keys(JOB_PATHS), ...Object.keys(GITHUB_WORKFLOW_JOBS)]);

async function verifyPin(req: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(req);
}

async function triggerGitHubWorkflow(
  job: { owner: string; repo: string; workflow: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = process.env.GITHUB_PAT;
  if (!token) {
    return { ok: false, status: 500, data: { error: "GITHUB_PAT not configured" } };
  }

  const url = `https://api.github.com/repos/${job.owner}/${job.repo}/actions/workflows/${job.workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  if (res.status === 204) {
    return { ok: true, status: 204, data: { message: "워크플로우 트리거 완료. 크롤링 → 자동 PR+머지까지 약 6분 소요." } };
  }

  const data = await res.json().catch(() => null);
  return { ok: false, status: res.status, data };
}

export async function POST(req: NextRequest) {
  if (!(await verifyPin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobName = body.job as string;

  if (!jobName || !ALL_JOBS.has(jobName)) {
    return NextResponse.json(
      { error: `Unknown job: ${jobName}` },
      { status: 400 },
    );
  }

  // GitHub Actions workflow dispatch
  const ghJob = GITHUB_WORKFLOW_JOBS[jobName];
  if (ghJob) {
    try {
      const result = await triggerGitHubWorkflow(ghJob);
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message },
        { status: 500 },
      );
    }
  }

  // Vercel cron route
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
