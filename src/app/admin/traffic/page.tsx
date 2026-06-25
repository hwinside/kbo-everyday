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

type TrafficRow = { day: string; platform: string; pv: number; uv: number };
type TrafficResp = {
  since: string;
  days: number;
  rows: TrafficRow[];
  totals: Record<string, { pv: number; uv: number }>;
};

// Display order + labels + colors for known platforms. Unknown (pre-tagging
// rows) is shown last and muted so it never reads as real "web" traffic.
const PLATFORMS: { key: string; label: string; color: string }[] = [
  { key: "ios_native", label: "iOS 앱", color: "#0A84FF" },
  { key: "android_native", label: "안드 앱", color: "#3DDC84" },
  { key: "pwa", label: "PWA", color: "#A855F7" },
  { key: "web", label: "웹", color: "#F59E0B" },
  { key: "native", label: "앱(기타)", color: "#64D2FF" },
  { key: "unknown", label: "기록 전", color: "#48484A" },
];

const PERIODS = [
  { days: 1, label: "오늘" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
];

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "8px",
  },
  labelStyle: { color: "#8E8E93" },
};

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

export default function TrafficPage() {
  const [days, setDays] = useState(7);
  const [resp, setResp] = useState<TrafficResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/traffic?days=${days}`, { headers: { "x-admin-pin": getPin() } })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((d: TrafficResp) => {
        if (!cancelled) setResp(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  // Platforms that actually appear in this window, in display order.
  const activePlatforms = useMemo(() => {
    const present = new Set(Object.keys(resp?.totals ?? {}));
    return PLATFORMS.filter((p) => present.has(p.key));
  }, [resp]);

  // Pivot rows → one record per day with a column per platform (for stacked bars).
  const chartData = useMemo(() => {
    if (!resp) return [];
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of resp.rows) {
      const d = (byDay[r.day] ??= {});
      d[r.platform] = Number(r.pv);
    }
    return Object.keys(byDay)
      .sort()
      .map((day) => ({ day: day.slice(5), ...byDay[day] }));
  }, [resp]);

  const totalPv = useMemo(
    () => Object.values(resp?.totals ?? {}).reduce((s, t) => s + t.pv, 0),
    [resp],
  );
  const appPv = useMemo(() => {
    const t = resp?.totals ?? {};
    return (t.ios_native?.pv ?? 0) + (t.android_native?.pv ?? 0) + (t.native?.pv ?? 0);
  }, [resp]);
  const appShare = totalPv > 0 ? Math.round((appPv / totalPv) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">트래픽</h1>
          <p className="text-sm text-[#8E8E93] mt-1">플랫폼별 페이지뷰 · 방문자</p>
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

      {error && (
        <div className="glass-card p-4 text-sm text-red-400">데이터 로드 실패: {error}</div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">총 페이지뷰</p>
          <p className="text-2xl font-bold mt-1">{loading ? "—" : fmt(totalPv)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-[#8E8E93]">앱 비중</p>
          <p className="text-2xl font-bold mt-1 text-[#0A84FF]">{loading ? "—" : `${appShare}%`}</p>
        </div>
        {PLATFORMS.filter((p) => ["ios_native", "android_native"].includes(p.key)).map((p) => (
          <div key={p.key} className="glass-card p-4">
            <p className="text-xs text-[#8E8E93]">{p.label} PV</p>
            <p className="text-2xl font-bold mt-1" style={{ color: p.color }}>
              {loading ? "—" : fmt(resp?.totals[p.key]?.pv ?? 0)}
            </p>
          </div>
        ))}
      </div>

      {/* Daily PV by platform (stacked) */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-semibold mb-4">일별 페이지뷰 (플랫폼별)</h2>
        {loading ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">불러오는 중…</div>
        ) : chartData.length === 0 ? (
          <div className="h-72 flex items-center justify-center text-[#8E8E93] text-sm">데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={288}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" stroke="#8E8E93" fontSize={11} />
              <YAxis stroke="#8E8E93" fontSize={11} />
              <Tooltip {...tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {activePlatforms.map((p) => (
                <Bar
                  key={p.key}
                  dataKey={p.key}
                  name={p.label}
                  stackId="pv"
                  fill={p.color}
                  radius={p.key === activePlatforms[activePlatforms.length - 1].key ? [4, 4, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Per-platform breakdown */}
      <div className="glass-card p-4">
        <h2 className="text-sm font-semibold mb-4">플랫폼별 합계 ({resp?.days ?? days}일)</h2>
        <div className="space-y-2">
          {loading ? (
            <p className="text-sm text-[#8E8E93]">불러오는 중…</p>
          ) : activePlatforms.length === 0 ? (
            <p className="text-sm text-[#8E8E93]">데이터 없음</p>
          ) : (
            activePlatforms.map((p) => {
              const t = resp?.totals[p.key] ?? { pv: 0, uv: 0 };
              const share = totalPv > 0 ? Math.round((t.pv / totalPv) * 100) : 0;
              return (
                <div key={p.key} className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-sm w-20 shrink-0">{p.label}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${share}%`, background: p.color }} />
                  </div>
                  <span className="text-sm tabular-nums w-14 text-right">{fmt(t.pv)}</span>
                  <span className="text-xs text-[#8E8E93] tabular-nums w-20 text-right">방문자 {fmt(t.uv)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
