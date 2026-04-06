"use client";

import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import {
  Loader2,
  BarChart3,
  Users,
  FileText,
  MessageSquare,
  Camera,
  AlertTriangle,
  Bot,
  Globe,
  TrendingUp,
} from "lucide-react";
import type { FeedbackItem } from "@/lib/admin/types";

/* ── helpers ─────────────────────────────────────────── */

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { "x-admin-pin": getPin() },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

/* ── types for API responses ─────────────────────────── */

interface UsersResponse {
  todaySignups: number;
  recentUsers: { id: string; nickname: string; team_id: string; created_at: string }[];
}

interface ContentResponse {
  dailyPosts: { date: string; posts: number; comments: number; photos: number }[];
}

interface StatsResponse {
  data: { date: string; uv: number; pv: number }[];
}

interface FeedbackResponse {
  data: FeedbackItem[];
}

interface JobsResponse {
  data: { id: number; status: string }[];
}

interface DauResponse {
  daily: { date: string; activeUsers: number; pageViews: number }[];
  dau: number;
  wau: number;
  mau: number;
}

interface PagesResponse {
  pages: { path: string; views: number }[];
}

interface CohortResponse {
  weeklyUsers: { week: string; newUsers: number; returningUsers: number; total: number }[];
}

interface OverviewData {
  users: UsersResponse;
  content: ContentResponse;
  stats: StatsResponse;
  feedback: FeedbackResponse;
  jobs: JobsResponse;
  ga4Dau: DauResponse | null;
  ga4Pages: PagesResponse | null;
  ga4Cohort: CohortResponse | null;
}

/* ── chart tooltip style ─────────────────────────────── */

const chartTooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

/* ── KPI card config ─────────────────────────────────── */

interface KpiDef {
  label: string;
  value: number | string;
  icon: React.ReactNode;
}

function KpiCard({ label, value, icon }: KpiDef) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="text-sm text-[#8E8E93]">{label}</p>
      </div>
      <p className="text-3xl font-bold tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

/* ── feedback type dot color ─────────────────────────── */

const feedbackDotColor: Record<FeedbackItem["type"], string> = {
  bug: "#FF453A",
  data: "#FFD60A",
  feature: "#30D158",
  content: "#6366F1",
  other: "#8E8E93",
};

/* ── date formatting helper ──────────────────────────── */

function formatGaDate(d: string) {
  // GA4 returns "20260405" format
  if (d.length === 8) return `${d.slice(4, 6)}/${d.slice(6)}`;
  return d.slice(5);
}

/* ── page component ──────────────────────────────────── */

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    const fetchGA4 = async <T,>(type: string): Promise<T | null> => {
      try {
        return await apiFetch<T>(`/api/admin/analytics?type=${type}`);
      } catch {
        return null;
      }
    };

    Promise.all([
      apiFetch<UsersResponse>("/api/admin/users"),
      apiFetch<ContentResponse>("/api/admin/content?days=1"),
      apiFetch<StatsResponse>("/api/admin/stats?days=30"),
      apiFetch<FeedbackResponse>("/api/admin/feedback?status=received"),
      apiFetch<JobsResponse>("/api/admin/jobs?status=error&limit=10"),
      fetchGA4<DauResponse>("dau"),
      fetchGA4<PagesResponse>("pages"),
      fetchGA4<CohortResponse>("cohort"),
    ])
      .then(([users, content, stats, feedback, jobs, ga4Dau, ga4Pages, ga4Cohort]) => {
        setData({ users, content, stats, feedback, jobs, ga4Dau, ga4Pages, ga4Cohort });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /* ── loading state ── */
  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[#636366]" />
      </div>
    );
  }

  /* ── extract KPI values ── */
  const todaySignups = data?.users?.todaySignups ?? 0;

  const todayContent = data?.content?.dailyPosts ?? [];
  const todayPosts = todayContent.reduce((s, d) => s + (d.posts ?? 0), 0);
  const todayComments = todayContent.reduce((s, d) => s + (d.comments ?? 0), 0);
  const todayPhotos = todayContent.reduce((s, d) => s + (d.photos ?? 0), 0);

  const pendingFeedback = data?.feedback?.data?.length ?? 0;
  const crawlerErrors = data?.jobs?.data?.filter((l) => l.status === "error").length ?? 0;

  /* ── GA4 data ── */
  const ga4Daily = data?.ga4Dau?.daily ?? [];
  const ga4ChartData = ga4Daily.map((d) => ({
    date: formatGaDate(d.date),
    DAU: d.activeUsers,
    PV: d.pageViews,
  }));

  /* ── traffic chart data (fallback to admin_daily_stats if no GA4) ── */
  const statsData = data?.stats?.data ?? [];
  const fallbackChartData = statsData.map((s) => ({
    date: s.date.slice(5),
    UV: s.uv,
    PV: s.pv,
  }));

  const hasGA4 = ga4ChartData.length > 0;

  /* ── recent feedback (3) ── */
  const recentFeedback = (data?.feedback?.data ?? []).slice(0, 3);

  /* ── recent users (5) ── */
  const recentUsers = (data?.users?.recentUsers ?? []).slice(0, 5);

  /* ── popular pages ── */
  const popularPages = data?.ga4Pages?.pages ?? [];

  /* ── cohort ── */
  const cohortData = data?.ga4Cohort?.weeklyUsers ?? [];

  /* ── KPI definitions ── */
  const kpis: KpiDef[] = [
    { label: "오늘 가입자", value: todaySignups, icon: <Users className="w-4 h-4 text-[#6366F1]" /> },
    { label: "오늘 게시글", value: todayPosts, icon: <FileText className="w-4 h-4 text-[#30D158]" /> },
    { label: "오늘 댓글", value: todayComments, icon: <MessageSquare className="w-4 h-4 text-[#FFD60A]" /> },
    { label: "오늘 직찍", value: todayPhotos, icon: <Camera className="w-4 h-4 text-[#FF9F0A]" /> },
    { label: "미처리 피드백", value: pendingFeedback, icon: <AlertTriangle className="w-4 h-4 text-[#FF453A]" /> },
    { label: "크롤러 실패", value: crawlerErrors, icon: <Bot className="w-4 h-4 text-[#FF453A]" /> },
  ];

  /* ── GA4 DAU/WAU/MAU KPIs ── */
  const ga4Kpis: KpiDef[] = data?.ga4Dau
    ? [
        { label: "DAU (오늘)", value: data.ga4Dau.dau, icon: <TrendingUp className="w-4 h-4 text-[#6366F1]" /> },
        { label: "WAU (7일)", value: data.ga4Dau.wau, icon: <TrendingUp className="w-4 h-4 text-[#30D158]" /> },
        { label: "MAU (30일)", value: data.ga4Dau.mau, icon: <TrendingUp className="w-4 h-4 text-[#FF9F0A]" /> },
      ]
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">대시보드 개요</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      {/* GA4 DAU/WAU/MAU */}
      {ga4Kpis.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {ga4Kpis.map((k) => (
            <KpiCard key={k.label} {...k} />
          ))}
        </div>
      )}

      {/* Traffic Chart — GA4 or fallback */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">
          {hasGA4 ? "일별 DAU · PV (GA4, 30일)" : "일별 트래픽 추이 (30일)"}
        </h2>
        {(hasGA4 ? ga4ChartData : fallbackChartData).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#636366]">
            <BarChart3 className="w-10 h-10" />
            <p className="text-sm">데이터 수집 전</p>
          </div>
        ) : hasGA4 ? (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={ga4ChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} />
              <YAxis stroke="#636366" fontSize={12} />
              <Tooltip {...chartTooltipStyle} />
              <Legend />
              <Line type="monotone" dataKey="DAU" stroke="#6366F1" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="PV" stroke="#30D158" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={fallbackChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} />
              <YAxis stroke="#636366" fontSize={12} />
              <Tooltip {...chartTooltipStyle} />
              <Legend />
              <Line type="monotone" dataKey="UV" stroke="#6366F1" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="PV" stroke="#30D158" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Popular Pages + Cohort row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Popular Pages */}
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">인기 페이지 (7일)</h2>
          </div>
          {popularPages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
              <Globe className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">데이터 없음</p>
            </div>
          ) : (
            <div className="space-y-2">
              {popularPages.map((p, i) => (
                <div key={p.path} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-[#636366] w-5 text-right shrink-0">{i + 1}</span>
                    <span className="text-sm truncate">{p.path}</span>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-[#8E8E93] shrink-0">
                    {p.views.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cohort Retention */}
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-[#30D158]" />
            <h2 className="text-lg font-semibold">주간 신규/복귀 유저</h2>
          </div>
          {cohortData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
              <TrendingUp className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">데이터 없음</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={cohortData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="week" stroke="#636366" fontSize={12} tickFormatter={(w) => `W${w}`} />
                <YAxis stroke="#636366" fontSize={12} />
                <Tooltip
                  {...chartTooltipStyle}
                  formatter={(value?: number | string, name?: string) =>
                    [Number(value ?? 0).toLocaleString(), name === "newUsers" ? "신규" : "복귀"]
                  }
                  labelFormatter={(w) => `Week ${w}`}
                />
                <Bar dataKey="newUsers" fill="#6366F1" name="신규" radius={[4, 4, 0, 0]} />
                <Bar dataKey="returningUsers" fill="#30D158" name="복귀" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Bottom row: Recent Feedback + Recent Users */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent Feedback */}
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">최근 건의</h2>
          {recentFeedback.length === 0 ? (
            <p className="text-sm text-[#636366] py-4 text-center">건의 없음</p>
          ) : (
            <ul className="space-y-3">
              {recentFeedback.map((fb) => (
                <li key={fb.id} className="flex items-start gap-3">
                  <span
                    className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: feedbackDotColor[fb.type] }}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{fb.title}</p>
                    <p className="text-xs text-[#8E8E93]">
                      {new Date(fb.createdAt).toLocaleDateString("ko-KR")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Users */}
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">최근 가입자</h2>
          {recentUsers.length === 0 ? (
            <p className="text-sm text-[#636366] py-4 text-center">가입자 없음</p>
          ) : (
            <ul className="space-y-3">
              {recentUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Users className="w-4 h-4 text-[#8E8E93] shrink-0" />
                    <span className="text-sm font-medium truncate">{u.nickname}</span>
                    {u.team_id && (
                      <span className="text-xs text-[#8E8E93] shrink-0">{u.team_id}</span>
                    )}
                  </div>
                  <span className="text-xs text-[#636366] shrink-0 ml-2">
                    {new Date(u.created_at).toLocaleDateString("ko-KR")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
