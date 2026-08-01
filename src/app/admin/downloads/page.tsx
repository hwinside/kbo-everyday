"use client";

import { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import StackedTooltip from "@/components/admin/StackedTooltip";

type Row = { platform: string; date: string; units: number };
type Resp = {
  since: string;
  days: number;
  rows: Row[];
  totals: Record<string, number>;
  cumulative: Record<string, number>;
};

const PLATFORMS: { key: string; label: string; color: string }[] = [
  { key: "ios", label: "iOS", color: "#0A84FF" },
  { key: "android", label: "안드로이드", color: "#3DDC84" },
];

const PERIODS = [
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
  { days: 90, label: "90일" },
];

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

const fmt = (n: number) => n.toLocaleString("ko-KR");

export default function DownloadsPage() {
  const [days, setDays] = useState(30);
  const [resp, setResp] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/downloads?days=${days}`, { headers: { "x-admin-pin": getPin() } })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((d: Resp) => { if (!cancelled) setResp(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const activePlatforms = useMemo(() => {
    const present = new Set(Object.keys(resp?.cumulative ?? {}));
    // iOS/Android are always shown as cards; chart bars only for present data.
    return PLATFORMS.filter((p) => present.has(p.key));
  }, [resp]);

  const chartData = useMemo(() => {
    if (!resp) return [];
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of resp.rows) {
      const d = (byDay[r.date] ??= {});
      d[r.platform] = Number(r.units);
    }
    return Object.keys(byDay).sort().map((date) => ({ date: date.slice(5), ...byDay[date] }));
  }, [resp]);

  const windowTotal = useMemo(
    () => Object.values(resp?.totals ?? {}).reduce((s, n) => s + n, 0),
    [resp],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">다운로드</h1>
          <p className="text-sm text-[#8E8E93] mt-1">앱스토어 설치수 (첫 다운로드)</p>
        </div>
        <div className="flex gap-1 p-1 rounded-xl bg-white/5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                days === p.days ? "bg-[#6366F1] text-white" : "text-[#8E8E93] hover:text-white"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="glass-card p-4 text-sm text-red-400">데이터 로드 실패: {error}</div>}

      {/* Cumulative + window cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {PLATFORMS.map((p) => (
          <div key={p.key} className="glass-card p-4">
            <p className="text-xs text-[#8E8E93]">{p.label} 누적</p>
            <p className="text-2xl font-bold mt-1" style={{ color: p.color }}>
              {loading ? "—" : fmt(resp?.cumulative[p.key] ?? 0)}
            </p>
          </div>
        ))}
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">기간 합계</p>
          <p className="text-2xl font-bold mt-1">{loading ? "—" : fmt(windowTotal)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">전체 누적</p>
          <p className="text-2xl font-bold mt-1">
            {loading ? "—" : fmt(Object.values(resp?.cumulative ?? {}).reduce((s, n) => s + n, 0))}
          </p>
        </div>
      </div>

      {/* Daily downloads by platform */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-semibold mb-4">일별 다운로드</h2>
        {loading ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">불러오는 중…</div>
        ) : chartData.length === 0 ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">아직 집계된 다운로드가 없어요</div>
        ) : (
          <ResponsiveContainer width="100%" height={288}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#8E8E93" fontSize={11} />
              <YAxis stroke="#8E8E93" fontSize={11} allowDecimals={false} />
              <Tooltip content={<StackedTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {activePlatforms.map((p, i) => (
                <Bar
                  key={p.key}
                  dataKey={p.key}
                  name={p.label}
                  stackId="dl"
                  fill={p.color}
                  radius={i === activePlatforms.length - 1 ? [4, 4, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="text-xs text-[#8E8E93] mt-3">
          iOS는 App Store Connect 판매 리포트(약 1–2일 지연), 안드로이드는 Google Play 설치 통계(일별 사용자 설치, 최대 7일 지연) 기준.
        </p>
      </div>
    </div>
  );
}
