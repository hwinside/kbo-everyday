"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CheckCircle, XCircle, Gauge, Globe, Database, Rocket } from "lucide-react";
import { API_USAGE, PERF_METRICS, DEPLOY_HISTORY } from "@/lib/admin/mock-data";

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

function PerfCard({
  label,
  metrics,
  unit,
}: {
  label: string;
  metrics: { p50: number; p95: number; p99: number };
  unit: string;
}) {
  const getColor = (value: number, thresholds: [number, number]) =>
    value <= thresholds[0] ? "#30D158" : value <= thresholds[1] ? "#FFD60A" : "#FF453A";

  // Thresholds differ per metric
  const thresholds: [number, number] =
    label === "LCP" ? [2.5, 4] : label === "FID" ? [100, 300] : label === "CLS" ? [0.1, 0.25] : [200, 500];

  return (
    <div className="glass-card p-5">
      <h3 className="text-sm font-semibold text-[#8E8E93] mb-3">{label}</h3>
      <div className="space-y-2">
        {(["p50", "p95", "p99"] as const).map((p) => (
          <div key={p} className="flex items-center justify-between">
            <span className="text-xs text-[#636366] uppercase">{p}</span>
            <span
              className="text-lg font-bold tabular-nums"
              style={{ color: getColor(metrics[p], thresholds) }}
            >
              {metrics[p]}
              <span className="text-xs font-normal ml-0.5">{unit}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminSystemPage() {
  const apiChartData = useMemo(
    () =>
      API_USAGE.map((a) => ({
        name: a.name,
        사용량: a.daily,
        한도: a.limit || undefined,
      })),
    []
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">시스템 모니터링</h1>

      {/* API Usage */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-[#6366F1]" />
          <h2 className="text-lg font-semibold">API 호출량 (일간)</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {API_USAGE.map((api) => (
            <div key={api.name} className="p-4 rounded-xl bg-white/3">
              <p className="text-sm text-[#8E8E93] mb-1">{api.name}</p>
              <div className="flex items-end gap-2">
                <span className="text-2xl font-bold tabular-nums" style={{ color: api.color }}>
                  {api.daily.toLocaleString()}
                </span>
                {api.limit > 0 && (
                  <span className="text-xs text-[#636366] mb-1">/ {api.limit.toLocaleString()}</span>
                )}
              </div>
              {api.limit > 0 && (
                <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (api.daily / api.limit) * 100)}%`,
                      background: api.color,
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={apiChartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="name" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="사용량" fill="#6366F1" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Web Vitals */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Gauge className="w-5 h-5 text-[#6366F1]" />
          <h2 className="text-lg font-semibold">성능 모니터링 (Web Vitals)</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <PerfCard label="LCP" metrics={PERF_METRICS.lcp} unit="s" />
          <PerfCard label="FID" metrics={PERF_METRICS.fid} unit="ms" />
          <PerfCard label="CLS" metrics={PERF_METRICS.cls} unit="" />
          <PerfCard label="API 응답시간" metrics={PERF_METRICS.apiResponseMs} unit="ms" />
        </div>

        {/* Error Rate */}
        <div className="glass-card p-5 mt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#8E8E93]">에러율</span>
            <span
              className="text-2xl font-bold tabular-nums"
              style={{ color: PERF_METRICS.errorRate < 1 ? "#30D158" : "#FF453A" }}
            >
              {PERF_METRICS.errorRate}%
            </span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${PERF_METRICS.errorRate * 10}%`,
                background: PERF_METRICS.errorRate < 1 ? "#30D158" : "#FF453A",
              }}
            />
          </div>
        </div>
      </div>

      {/* Supabase */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Database className="w-5 h-5 text-[#6366F1]" />
          <h2 className="text-lg font-semibold">Supabase 사용량</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: "데이터베이스", used: "142 MB", limit: "500 MB", pct: 28 },
            { label: "스토리지", used: "1.8 GB", limit: "5 GB", pct: 36 },
            { label: "월간 요청", used: "245K", limit: "500K", pct: 49 },
          ].map((item) => (
            <div key={item.label} className="p-4 rounded-xl bg-white/3">
              <p className="text-sm text-[#8E8E93] mb-1">{item.label}</p>
              <p className="text-xl font-bold tabular-nums">
                {item.used}{" "}
                <span className="text-xs font-normal text-[#636366]">/ {item.limit}</span>
              </p>
              <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#6366F1] transition-all"
                  style={{ width: `${item.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Deploy History */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Rocket className="w-5 h-5 text-[#6366F1]" />
          <h2 className="text-lg font-semibold">배포 히스토리</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8">
                <th className="text-left py-2 text-[#8E8E93] font-medium">버전</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">환경</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">상태</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">배포 시간</th>
                <th className="text-right py-2 text-[#8E8E93] font-medium">소요</th>
              </tr>
            </thead>
            <tbody>
              {DEPLOY_HISTORY.map((d) => (
                <tr key={d.id} className="border-b border-white/5">
                  <td className="py-2.5 font-mono text-sm">{d.version}</td>
                  <td className="py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        d.env === "production"
                          ? "bg-[#30D158]/15 text-[#30D158]"
                          : "bg-[#FFD60A]/15 text-[#FFD60A]"
                      }`}
                    >
                      {d.env}
                    </span>
                  </td>
                  <td className="py-2.5">
                    {d.status === "success" ? (
                      <CheckCircle className="w-4 h-4 text-[#30D158]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[#FF453A]" />
                    )}
                  </td>
                  <td className="py-2.5 text-[#8E8E93]">
                    {new Date(d.deployedAt).toLocaleString("ko-KR")}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-[#8E8E93]">{d.duration}초</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
