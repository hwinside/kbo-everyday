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
      // Get function invocations from Vercel
      // The usage endpoint may not return the expected shape, so we
      // compute daily API route invocation counts from deployments log.
      // Alternatively use Vercel's web analytics API.
      try {
        const now = Date.now();
        const from = now - 7 * 86400000;
        const res = await fetch(
          `https://api.vercel.com/v2/usage?projectId=${projectId}&from=${from}&to=${now}`,
          { headers: HEADERS() }
        );
        if (res.ok) {
          const json = await res.json();
          // Try to normalize into [{date, requests}]
          if (Array.isArray(json)) {
            return NextResponse.json({ usage: json });
          }
          // If it's an object with data array
          if (json.data && Array.isArray(json.data)) {
            return NextResponse.json({ usage: json.data });
          }
          // Return raw with fallback flag
          return NextResponse.json({ usage: [], fallback: true, raw: json });
        }
      } catch {
        // Ignore
      }

      // Fallback: compute daily deploy counts from recent deployments
      const res = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=100`,
        { headers: HEADERS() }
      );
      if (res.ok) {
        const json = await res.json();
        const dailyCounts: Record<string, number> = {};
        for (const d of json.deployments ?? []) {
          const ts = d.createdAt ?? d.created;
          if (!ts) continue;
          const date = new Date(ts).toISOString().slice(0, 10);
          dailyCounts[date] = (dailyCounts[date] || 0) + 1;
        }
        const usage = Object.entries(dailyCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-7)
          .map(([date, requests]) => ({ date, requests }));
        return NextResponse.json({ usage, source: "deployments" });
      }

      return NextResponse.json({ usage: [], fallback: true });
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
