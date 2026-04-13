import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";
import { createClient } from "@supabase/supabase-js";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  try {
    // Table row counts via count queries
    const tables: Record<string, number> = {};
    const tableNames = ["profiles", "posts", "photos", "admin_daily_stats", "user_feedback",
      "comments", "highlights", "game_summaries", "admin_job_logs", "chat_messages"];

    await Promise.all(
      tableNames.map(async (t) => {
        try {
          const { count } = await supabase.from(t).select("*", { count: "exact", head: true });
          tables[t] = count ?? 0;
        } catch {
          tables[t] = -1; // table might not exist
        }
      })
    );

    // DB size via Supabase Management API (if token available)
    let dbSize: string | null = null;
    const mgmtToken = process.env.SUPABASE_MANAGEMENT_TOKEN;
    const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").match(/\/\/([^.]+)/)?.[1];

    if (mgmtToken && projectRef) {
      try {
        const res = await fetch(
          `https://api.supabase.com/v1/projects/${projectRef}/usage`,
          { headers: { Authorization: `Bearer ${mgmtToken}`, "Content-Type": "application/json" } }
        );
        if (res.ok) {
          const usage = await res.json();
          // Supabase Management API returns db_size in bytes
          if (usage.db_size) {
            const mb = (usage.db_size / (1024 * 1024)).toFixed(1);
            dbSize = `${mb} MB`;
          }
        }
      } catch {
        // Management API not available, skip
      }
    }

    return NextResponse.json({ dbSize, tables });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
