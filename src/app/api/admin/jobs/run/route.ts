import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";

const CRON_SECRET = process.env.CRON_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_WORKFLOW_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "hwinside/kbo-everyday";
const ROSTER_WORKFLOW_ID = "update-roster-stats.yml";

const JOB_PATHS: Record<string, string> = {
  "youtube-highlights": "/api/cron/highlights",
  "roster-update": "/api/cron/roster",
  "stats-update": "/api/cron/stats",
  "photos-check": "/api/cron/photos",
};

async function triggerRosterWorkflow() {
  if (!GITHUB_TOKEN) {
    return NextResponse.json(
      {
        error: "Missing GITHUB_TOKEN (or GITHUB_WORKFLOW_TOKEN)",
      },
      { status: 500 },
    );
  }

  const [owner, repo] = GITHUB_REPO.split("/");
  if (!owner || !repo) {
    return NextResponse.json(
      { error: `Invalid GITHUB_REPO: ${GITHUB_REPO}` },
      { status: 500 },
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${ROSTER_WORKFLOW_ID}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "keubo-fan-admin",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `GitHub workflow dispatch failed: ${res.status}`, details: text },
      { status: res.status },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "로스터 동기화 워크플로우를 트리거했습니다. 완료되면 자동 머지/배포됩니다.",
    workflow: ROSTER_WORKFLOW_ID,
  });
}

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function POST(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const jobName = body.job as string;

  if (jobName === "roster-sync") {
    return triggerRosterWorkflow();
  }

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
