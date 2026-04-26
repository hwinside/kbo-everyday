import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import type { CohortHeatmapRow, FunnelStep, GamedayRetention } from "@/lib/admin/types";

const FUNNEL_LABELS: Record<string, string> = {
  signup: "가입",
  team_select: "팀 선택",
  first_post: "첫 글쓰기",
  first_comment: "첫 댓글",
  first_chat: "첫 채팅",
};

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type") || "all";

  // 가장 최근 완전 집계일 (cohort+funnel+gameday 3종 모두 있는 날짜만 인정)
  const { data: dateRows } = await supabase
    .from("retention_metrics")
    .select("date, metric_type")
    .order("date", { ascending: false })
    .limit(200);

  let latestDate: string | null = null;
  if (dateRows?.length) {
    const dateTypes = new Map<string, Set<string>>();
    for (const r of dateRows) {
      if (!dateTypes.has(r.date)) dateTypes.set(r.date, new Set());
      dateTypes.get(r.date)!.add(r.metric_type);
    }
    for (const [date, types] of dateTypes) {
      if (types.has("cohort") && types.has("funnel") && types.has("gameday")) {
        latestDate = date;
        break;
      }
    }
  }

  if (!latestDate) {
    return NextResponse.json({ cohort: [], funnel: [], gameday: [], date: null });
  }

  // Cohort heatmap
  let cohort: CohortHeatmapRow[] = [];
  if (type === "all" || type === "cohort") {
    const { data } = await supabase
      .from("retention_metrics")
      .select("*")
      .eq("date", latestDate)
      .eq("metric_type", "cohort")
      .order("cohort_key", { ascending: true });

    const grouped = new Map<string, CohortHeatmapRow>();
    for (const row of data ?? []) {
      if (!grouped.has(row.cohort_key)) {
        grouped.set(row.cohort_key, {
          cohortKey: row.cohort_key,
          cohortSize: row.total,
          d1: 0, d7: 0, d14: 0, d30: 0,
        });
      }
      const entry = grouped.get(row.cohort_key)!;
      const key = row.metric_key.toLowerCase() as "d1" | "d7" | "d14" | "d30";
      if (key in entry) {
        (entry as unknown as Record<string, number>)[key] = row.rate;
        entry.cohortSize = Math.max(entry.cohortSize, row.total);
      }
    }
    cohort = Array.from(grouped.values());
  }

  // Activation funnel
  let funnel: FunnelStep[] = [];
  if (type === "all" || type === "funnel") {
    const { data } = await supabase
      .from("retention_metrics")
      .select("*")
      .eq("date", latestDate)
      .eq("metric_type", "funnel")
      .eq("cohort_key", "all");

    const stepOrder = ["signup", "team_select", "first_post", "first_comment", "first_chat"];
    const stepMap = new Map<string, { count: number; rate: number }>();
    for (const row of data ?? []) {
      stepMap.set(row.metric_key, { count: row.value, rate: row.rate });
    }
    funnel = stepOrder
      .filter((s) => stepMap.has(s))
      .map((s) => ({
        step: s,
        label: FUNNEL_LABELS[s] || s,
        count: stepMap.get(s)!.count,
        rate: stepMap.get(s)!.rate,
      }));
  }

  // Gameday retention
  let gameday: GamedayRetention[] = [];
  if (type === "all" || type === "gameday") {
    const { data } = await supabase
      .from("retention_metrics")
      .select("*")
      .eq("date", latestDate)
      .eq("metric_type", "gameday")
      .order("cohort_key", { ascending: true });

    const grouped = new Map<string, GamedayRetention>();
    for (const row of data ?? []) {
      if (!grouped.has(row.cohort_key)) {
        grouped.set(row.cohort_key, {
          cohortKey: row.cohort_key,
          cohortSize: row.total,
          gd1: 0, gd2: 0, gd3: 0,
        });
      }
      const entry = grouped.get(row.cohort_key)!;
      const key = row.metric_key as "gd1" | "gd2" | "gd3";
      if (key in entry) {
        (entry as unknown as Record<string, number>)[key] = row.rate;
        entry.cohortSize = Math.max(entry.cohortSize, row.total);
      }
    }
    gameday = Array.from(grouped.values());
  }

  return NextResponse.json({ cohort, funnel, gameday, date: latestDate });
}
