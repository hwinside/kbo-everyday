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

interface OverviewData {
  users: UsersResponse;
  content: ContentResponse;
  stats: StatsResponse;
  feedback: FeedbackResponse;
  jobs: JobsResponse;
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
  value: number;
  icon: React.ReactNode;
}

function KpiCard({ label, value, icon }: KpiDef) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="text-sm text-[#8E8E93]">{label}</p>
      </div>
      <p className="text-3xl font-bold tabular-nums">{value.toLocaleString()}</p>
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

/* ── page component ──────────────────────────────────── */

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<UsersResponse>("/api/admin/users"),
      apiFetch<ContentResponse>("/api/admin/content?days=1"),
      apiFetch<StatsResponse>("/api/admin/stats?days=30"),
      apiFetch<FeedbackResponse>("/api/admin/feedback?status=received"),
      apiFetch<JobsResponse>("/api/admin/jobs?status=error&limit=10"),
    ])
      .then(([users, content, stats, feedback, jobs]) => {
        setData({ users, content, stats, feedback, jobs });
      })
      .catch(() => {
        /* silently fail — UI will show zeros / empty states */
      })
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

  /* ── traffic chart data ── */
  const statsData = data?.stats?.data ?? [];
  const chartData = statsData.map((s) => ({
    date: s.date.slice(5),
    UV: s.uv,
    PV: s.pv,
  }));

  /* ── recent feedback (3) ── */
  const recentFeedback = (data?.feedback?.data ?? []).slice(0, 3);

  /* ── recent users (5) ── */
  const recentUsers = (data?.users?.recentUsers ?? []).slice(0, 5);

  /* ── KPI definitions ── */
  const kpis: KpiDef[] = [
    { label: "오늘 가입자", value: todaySignups, icon: <Users className="w-4 h-4 text-[#6366F1]" /> },
    { label: "오늘 게시글", value: todayPosts, icon: <FileText className="w-4 h-4 text-[#30D158]" /> },
    { label: "오늘 댓글", value: todayComments, icon: <MessageSquare className="w-4 h-4 text-[#FFD60A]" /> },
    { label: "오늘 직찍", value: todayPhotos, icon: <Camera className="w-4 h-4 text-[#FF9F0A]" /> },
    { label: "미처리 피드백", value: pendingFeedback, icon: <AlertTriangle className="w-4 h-4 text-[#FF453A]" /> },
    { label: "크롤러 실패", value: crawlerErrors, icon: <Bot className="w-4 h-4 text-[#FF453A]" /> },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">대시보드 개요</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      {/* Traffic Chart */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">일별 트래픽 추이 (30일)</h2>
        {chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#636366]">
            <BarChart3 className="w-10 h-10" />
            <p className="text-sm">데이터 수집 전</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData}>
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
