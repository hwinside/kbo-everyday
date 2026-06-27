import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import type { CohortHeatmapRow, FunnelStep, GamedayRetention, VisitDistBucket } from "@/lib/admin/types";

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
  // 날짜별 3종 완비 확인 — 최근 5일치 후보만 체크 (limit 초과 방지)
  let latestDate: string | null = null;
  {
    // step 1: 최근 날짜 5개 후보 추출 (metric_type 무관, 역순 정렬)
    const { data: rawDates } = await supabase
      .from("retention_metrics")
      .select("date")
      .order("date", { ascending: false })
      .limit(500);
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const r of rawDates ?? []) {
      if (!seen.has(r.date)) { seen.add(r.date); candidates.push(r.date); }
      if (candidates.length >= 5) break;
    }
    // step 2: 각 후보 날짜에 cohort+funnel+gameday 존재 여부 확인
    // .limit(3) 사용 금지 — 같은 type row만 3개 잡히는 회귀 방지 (삼순이 리뷰 #2)
    const required = ["cohort", "funnel", "gameday"] as const;
    for (const candidate of candidates) {
      const checks = await Promise.all(
        required.map(async (mt) => {
          const { count } = await supabase
            .from("retention_metrics")
            .select("*", { count: "exact", head: true })
            .eq("date", candidate)
            .eq("metric_type", mt);
          return (count ?? 0) > 0;
        }),
      );
      if (checks.every(Boolean)) {
        latestDate = candidate;
        break;
      }
    }
  }

  if (!latestDate) {
    return NextResponse.json({ cohort: [], dailyCohort: [], funnel: [], gameday: [], visitDist: [], date: null });
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
          d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d14: 0, d30: 0,
        });
      }
      const entry = grouped.get(row.cohort_key)!;
      const key = row.metric_key.toLowerCase() as keyof CohortHeatmapRow;
      if (key in entry && key !== "cohortKey" && key !== "cohortSize") {
        (entry as unknown as Record<string, number>)[key] = row.rate;
        entry.cohortSize = Math.max(entry.cohortSize, row.total);
      }
    }
    cohort = Array.from(grouped.values());
  }

  // Daily cohort heatmap (가입일별)
  let dailyCohort: CohortHeatmapRow[] = [];
  if (type === "all" || type === "daily_cohort") {
    const { data } = await supabase
      .from("retention_metrics")
      .select("*")
      .eq("date", latestDate)
      .eq("metric_type", "daily_cohort")
      .order("cohort_key", { ascending: true });

    const grouped = new Map<string, CohortHeatmapRow>();
    for (const row of data ?? []) {
      if (!grouped.has(row.cohort_key)) {
        grouped.set(row.cohort_key, {
          cohortKey: row.cohort_key,
          cohortSize: row.total,
          d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d14: 0, d30: 0,
        });
      }
      const entry = grouped.get(row.cohort_key)!;
      const key = row.metric_key.toLowerCase() as keyof CohortHeatmapRow;
      if (key in entry && key !== "cohortKey" && key !== "cohortSize") {
        (entry as unknown as Record<string, number>)[key] = row.rate;
        entry.cohortSize = Math.max(entry.cohortSize, row.total);
      }
    }
    dailyCohort = Array.from(grouped.values());
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

  // Visit frequency distribution
  let visitDist: VisitDistBucket[] = [];
  if (type === "all" || type === "visit_dist") {
    const { data } = await supabase
      .from("retention_metrics")
      .select("*")
      .eq("date", latestDate)
      .eq("metric_type", "visit_dist")
      .eq("cohort_key", "all")
      .order("metric_key", { ascending: true });

    const bucketOrder = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"];
    const bucketMap = new Map<string, number>();
    for (const row of data ?? []) {
      bucketMap.set(row.metric_key, row.value);
    }
    visitDist = bucketOrder
      .filter((b) => bucketMap.has(b))
      .map((b) => ({ bucket: b, count: bucketMap.get(b)! }));
  }

  return NextResponse.json({ cohort, dailyCohort, funnel, gameday, visitDist, date: latestDate });
}
