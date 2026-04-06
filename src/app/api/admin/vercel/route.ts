import { NextRequest, NextResponse } from "next/server";

function verifyPin(req: NextRequest): boolean {
  return req.headers.get("x-admin-pin") === process.env.ADMIN_PIN;
}

const HEADERS = () => ({
  Authorization: "Bearer " + process.env.VERCEL_TOKEN,
});

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "deployments";
  const projectId = process.env.VERCEL_PROJECT_ID;

  try {
    if (type === "deployments") {
      const res = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=20`,
        { headers: HEADERS() }
      );
      if (!res.ok) throw new Error(`Vercel API ${res.status}`);
      const json = await res.json();

      const deployments = (json.deployments ?? []).map(
        (d: Record<string, unknown>) => ({
          uid: d.uid,
          state: d.state ?? d.readyState,
          url: d.url,
          createdAt: d.createdAt ?? d.created,
          meta: {
            commit: (d.meta as Record<string, unknown>)?.githubCommitMessage ?? "",
            branch: (d.meta as Record<string, unknown>)?.githubCommitRef ?? "",
            author: (d.meta as Record<string, unknown>)?.githubCommitAuthorName ?? "",
          },
        })
      );

      return NextResponse.json({ deployments });
    }

    if (type === "usage") {
      // Try to get function invocations from Vercel analytics
      const now = Date.now();
      const from = now - 7 * 86400000;
      const res = await fetch(
        `https://api.vercel.com/v1/projects/${projectId}/analytics/usage?from=${from}&to=${now}`,
        { headers: HEADERS() }
      );
      if (!res.ok) {
        // Fallback: return empty usage if endpoint not available
        return NextResponse.json({ usage: [], fallback: true });
      }
      const json = await res.json();
      return NextResponse.json({ usage: json });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
