"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
} from "recharts";
import type { CohortHeatmapRow, FunnelStep, GamedayRetention, VisitDistBucket } from "@/lib/admin/types";

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { "x-admin-pin": getPin() },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

const chartTooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
  },
  labelStyle: { color: "#8E8E93" },
};

function rateColor(rate: number): string {
  if (rate >= 0.4) return "#22C55E";
  if (rate >= 0.25) return "#84CC16";
  if (rate >= 0.15) return "#EAB308";
  if (rate >= 0.08) return "#F97316";
  return "#EF4444";
}

function rateBg(rate: number): string {
  if (rate >= 0.4) return "rgba(34,197,94,0.15)";
  if (rate >= 0.25) return "rgba(132,204,22,0.15)";
  if (rate >= 0.15) return "rgba(234,179,8,0.15)";
  if (rate >= 0.08) return "rgba(249,115,22,0.15)";
  return "rgba(239,68,68,0.15)";
}

const FUNNEL_COLORS = ["#6366F1", "#8B5CF6", "#A855F7", "#D946EF", "#EC4899"];

interface RetentionData {
  cohort: CohortHeatmapRow[];
  funnel: FunnelStep[];
  gameday: GamedayRetention[];
  visitDist: VisitDistBucket[];
  date: string | null;
}

export default function RetentionPage() {
  const [data, setData] = useState<RetentionData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<RetentionData>("/api/admin/retention")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        로딩 중...
      </div>
    );
  }

  if (!data?.date) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        아직 집계된 데이터가 없습니다. 크론이 실행된 후 데이터가 표시됩니다.
      </div>
    );
  }

  const latestCohort = data.cohort.at(-1);
  const d7Rate = latestCohort?.d7 ?? 0;
  const activationComplete = data.funnel.at(-1);
  const activationRate = activationComplete?.rate ?? 0;
  const latestGd = data.gameday.at(-1);
  const gd1Rate = latestGd?.gd1 ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">리텐션 모니터링</h1>
        <span className="text-sm text-gray-400">
          마지막 집계: {data.date}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">최근 코호트 D7 리텐션</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(d7Rate) }}>
            {(d7Rate * 100).toFixed(1)}%
          </p>
        </div>
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">Activation 완료율</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(activationRate) }}>
            {(activationRate * 100).toFixed(1)}%
          </p>
        </div>
        <div className="glass-card p-5">
          <p className="text-xs text-gray-400 mb-1">첫 경기일 복귀율</p>
          <p className="text-2xl font-bold tabular-nums" style={{ color: rateColor(gd1Rate) }}>
            {(gd1Rate * 100).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">코호트 리텐션 히트맵</h2>
        {data.cohort.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs">
                  <th className="text-left py-2 pr-4">코호트</th>
                  <th className="text-right py-2 px-3">인원</th>
                  {(["d1","d2","d3","d4","d5","d6","d7","d14","d30"] as const).map((k) => (
                    <th key={k} className="text-center py-2 px-2">{k.toUpperCase()}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.cohort.map((row) => (
                  <tr key={row.cohortKey} className="border-t border-white/5">
                    <td className="py-2 pr-4 text-gray-300 font-mono text-xs">
                      {row.cohortKey}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-400">
                      {row.cohortSize}
                    </td>
                    {(["d1","d2","d3","d4","d5","d6","d7","d14","d30"] as const).map((key) => (
                      <td
                        key={key}
                        className="py-2 px-2 text-center tabular-nums font-medium text-xs"
                        style={{
                          color: rateColor(row[key]),
                          background: rateBg(row[key]),
                        }}
                      >
                        {row[key] > 0 ? `${(row[key] * 100).toFixed(1)}%` : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">Activation Funnel</h2>
        {data.funnel.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={data.funnel}
              layout="vertical"
              margin={{ left: 80, right: 40 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                type="number"
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                stroke="#8E8E93"
                fontSize={11}
              />
              <YAxis
                type="category"
                dataKey="label"
                stroke="#8E8E93"
                fontSize={12}
                width={70}
              />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value) => [`${(Number(value) * 100).toFixed(1)}%`, "전환율"]}
              />
              <Bar dataKey="rate" radius={[0, 4, 4, 0]}>
                {data.funnel.map((_, i) => (
                  <Cell key={i} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        {data.funnel.length > 0 && (
          <div className="flex gap-4 mt-3 text-xs text-gray-400">
            {data.funnel.map((s) => (
              <span key={s.step}>
                {s.label}: <span className="text-white font-medium">{s.count.toLocaleString()}</span>명
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">게임데이 리텐션</h2>
        {data.gameday.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.gameday}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="cohortKey" stroke="#8E8E93" fontSize={11} />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                stroke="#8E8E93"
                fontSize={11}
              />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value, name) => [
                  `${(Number(value) * 100).toFixed(1)}%`,
                  name === "gd1" ? "1st 경기일" : name === "gd2" ? "2nd 경기일" : "3rd 경기일",
                ]}
              />
              <Line type="monotone" dataKey="gd1" stroke="#22D3EE" strokeWidth={2} name="gd1" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="gd2" stroke="#6366F1" strokeWidth={2} name="gd2" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="gd3" stroke="#A855F7" strokeWidth={2} name="gd3" dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="glass-card p-5">
        <h2 className="text-sm font-semibold mb-4">재방문 횟수별 유저 분포 (최근 30일)</h2>
        {data.visitDist.length === 0 ? (
          <p className="text-gray-500 text-sm">데이터 없음 — 다음 크론 실행 후 표시됩니다</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.visitDist} margin={{ left: 10, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="bucket"
                stroke="#8E8E93"
                fontSize={12}
                label={{ value: "방문 횟수", position: "insideBottom", offset: -5, fill: "#8E8E93", fontSize: 11 }}
              />
              <YAxis stroke="#8E8E93" fontSize={11} />
              <Tooltip
                {...chartTooltipStyle}
                formatter={(value) => [`${Number(value).toLocaleString()}명`, "유저 수"]}
                labelFormatter={(label) => `${label}회 방문`}
              />
              <Bar dataKey="count" fill="#6366F1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
