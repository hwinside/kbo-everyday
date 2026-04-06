import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function verifyPin(req: NextRequest): boolean {
  return req.headers.get("x-admin-pin") === process.env.ADMIN_PIN;
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
    // Get DB size via pg_database_size
    const { data: dbSize } = await supabase.rpc("pg_database_size_pretty");

    // Get table row counts from admin_daily_stats (most recent)
    const { count: statsCount } = await supabase
      .from("admin_daily_stats")
      .select("*", { count: "exact", head: true });

    // Get total users count
    const { count: usersCount } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true });

    // Get total posts count
    const { count: postsCount } = await supabase
      .from("posts")
      .select("*", { count: "exact", head: true });

    // Get total storage objects count
    const { count: storageCount } = await supabase
      .from("photos")
      .select("*", { count: "exact", head: true });

    // Get total feedback count
    const { count: feedbackCount } = await supabase
      .from("user_feedback")
      .select("*", { count: "exact", head: true });

    return NextResponse.json({
      dbSize: typeof dbSize === "string" ? dbSize : null,
      tables: {
        profiles: usersCount ?? 0,
        posts: postsCount ?? 0,
        photos: storageCount ?? 0,
        admin_daily_stats: statsCount ?? 0,
        user_feedback: feedbackCount ?? 0,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
