"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { TrendingUp, TrendingDown, AlertTriangle, XCircle } from "lucide-react";
import {
  generateDailyStats,
  generateKpis,
  generatePopularPages,
  generateAnomalies,
} from "@/lib/admin/mock-data";
import type { KpiData, AnomalyLog } from "@/lib/admin/types";

function KpiCard({ data }: { data: KpiData }) {
  const diff = data.value - data.prev;
  const pct = data.prev > 0 ? ((diff / data.prev) * 100).toFixed(1) : "0";
  const up = diff >= 0;

  return (
    <div className="glass-card p-5">
      <p className="text-sm text-[#8E8E93] mb-1">{data.label}</p>
      <p className="text-3xl font-bold tabular-nums">{data.value.toLocaleString()}</p>
      <div className={`flex items-center gap-1 mt-2 text-sm ${up ? "text-[#30D158]" : "text-[#FF453A]"}`}>
        {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
        <span>{up ? "▲" : "▼"} {Math.abs(Number(pct))}%</span>
        <span className="text-[#636366] ml-1">전일 대비</span>
      </div>
    </div>
  );
}

function AnomalyBanner({ anomalies }: { anomalies: AnomalyLog[] }) {
  if (anomalies.length === 0) return null;

  return (
    <div className="space-y-2">
      {anomalies.map((a) => (
        <div
          key={a.id}
          className={`flex items-start gap-3 p-4 rounded-xl border ${
            a.severity === "critical"
              ? "bg-red-500/10 border-red-500/30"
              : "bg-yellow-500/10 border-yellow-500/30"
          }`}
        >
          {a.severity === "critical" ? (
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
          )}
          <div>
            <p className="font-medium text-sm">🚨 {a.message}</p>
            <p className="text-xs text-[#8E8E93] mt-1">
              {new Date(a.createdAt).toLocaleString("ko-KR")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

const chartTooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

export default function AdminOverviewPage() {
  const stats = useMemo(() => generateDailyStats(), []);
  const kpis = useMemo(() => generateKpis(stats), [stats]);
  const pages = useMemo(() => generatePopularPages(), []);
  const anomalies = useMemo(() => generateAnomalies(), []);

  const chartData = stats.map((s) => ({
    date: s.date.slice(5),
    UV: s.uv,
    PV: s.pv,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">대시보드 개요</h1>

      <AnomalyBanner anomalies={anomalies} />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <KpiCard key={k.label} data={k} />
        ))}
      </div>

      {/* Traffic Chart */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">일별 트래픽 추이 (30일)</h2>
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
      </div>

      {/* Popular Pages */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">인기 페이지 Top 10</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={pages} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis type="number" stroke="#636366" fontSize={12} />
            <YAxis dataKey="label" type="category" stroke="#636366" fontSize={12} width={80} />
            <Tooltip {...chartTooltipStyle} />
            <Bar dataKey="views" fill="#6366F1" radius={[0, 6, 6, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
