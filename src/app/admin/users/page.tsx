"use client";

import { useState, useEffect } from "react";
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Loader2, Users, BarChart3 } from "lucide-react";
import type { GaDauResponse } from "@/lib/admin/ga4-dau";

const TEAM_MAP: Record<number, { name: string; color: string }> = {
  1: { name: "LG", color: "#C60C30" },
  2: { name: "두산", color: "#131230" },
  3: { name: "KT", color: "#E85050" },
  4: { name: "SSG", color: "#CE0E2D" },
  5: { name: "NC", color: "#315288" },
  6: { name: "KIA", color: "#EA0029" },
  7: { name: "롯데", color: "#002856" },
  8: { name: "삼성", color: "#074CA1" },
  9: { name: "한화", color: "#FF6600" },
  10: { name: "키움", color: "#820024" },
};

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

function getPin(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch<T>(path: string): Promise<T> {
  const pin = getPin();
  const res = await fetch(path, {
    headers: pin ? { "x-admin-pin": pin } : {},
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

interface TeamDistItem {
  team_id: number | null;
  count: number;
}

interface RecentUser {
  nickname: string;
  team_id: number | null;
  created_at: string;
}

interface UsersResponse {
  totalUsers: number;
  teamDistribution: TeamDistItem[];
  recentUsers: RecentUser[];
  dailySignups?: { date: string; count: number }[];
}

const DAU_PERIODS = [
  { key: "7d", label: "7일" }, { key: "30d", label: "30일" },
  { key: "90d", label: "90일" }, { key: "180d", label: "180일" },
  { key: "all", label: "전체(일별)" },
] as const;

export default function AdminUsersPage() {
  const [loading, setLoading] = useState(true);
  const [usersData, setUsersData] = useState<UsersResponse | null>(null);
  const [ga4Data, setGa4Data] = useState<GaDauResponse | null>(null);
  const [period, setPeriod] = useState<typeof DAU_PERIODS[number]["key"]>("30d");

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [users, ga4] = await Promise.all([
          apiFetch<UsersResponse>("/api/admin/users"),
          apiFetch<GaDauResponse>(`/api/admin/analytics?type=daily-active-users&period=${period}`).catch(() => null),
        ]);
        if (alive) {
          setUsersData(users);
          setGa4Data(ga4);
        }
      } catch (e) {
        console.error("Failed to load admin users data:", e);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [period]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-[#636366]" />
      </div>
    );
  }

  if (!usersData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-[#636366]">
        <Users className="w-10 h-10 mb-2" />
        <p>데이터를 불러올 수 없습니다</p>
      </div>
    );
  }

  // Team distribution pie data
  const pieData = usersData.teamDistribution.map((item) => {
    if (item.team_id === null) {
      return { name: "미선택", value: item.count, color: "#636366" };
    }
    const team = TEAM_MAP[item.team_id];
    return {
      name: team?.name ?? `팀${item.team_id}`,
      value: item.count,
      color: team?.color ?? "#636366",
    };
  });

  // Join by the full date, not MM/DD (all-history can span multiple years).
  // Unavailable GA/sign-up dates remain null rather than invented zeroes.
  const ga4Daily = ga4Data?.daily ?? [];
  const dailySignups = usersData.dailySignups ?? [];
  const signupMap = new Map(dailySignups.map(s => [s.date, s.count]));
  const signupVsUv = ga4Daily.map(d => ({
    date: period === "all" ? d.date : d.date.slice(5).replace("-", "/"),
    가입자: signupMap.get(d.date) ?? null,
    활성사용자: d.activeUsers,
  }));

  // Recent users with mapped team names
  const recentUsers = usersData.recentUsers.map((u) => ({
    nickname: u.nickname,
    team: u.team_id !== null ? (TEAM_MAP[u.team_id]?.name ?? "미선택") : "미선택",
    joinedAt: new Date(u.created_at).toLocaleString("ko-KR"),
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">유저 분석</h1>

      {/* KPI — Total Users */}
      <div className="glass-card p-5 flex items-center gap-3">
        <Users className="w-6 h-6 text-[#6366F1]" />
        <span className="text-lg font-semibold">
          총 가입자 <span className="tabular-nums">{usersData.totalUsers.toLocaleString()}</span>명
        </span>
      </div>

      {/* Signup vs UV */}
      <div className="glass-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold">가입자 vs DAU (GA4)</h2>
          <div className="flex flex-wrap gap-1">
            {DAU_PERIODS.map(p => (
              <button key={p.key} onClick={() => { if (period !== p.key) { setLoading(true); setPeriod(p.key); } }} className={`px-3 py-1 rounded-lg text-xs ${period === p.key ? "bg-[#6366F1] text-white" : "bg-white/5 text-[#8E8E93]"}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-[#8E8E93] mb-4">DAU는 GA4의 일별 활성 사용자입니다. 당일은 제외하며 가입자는 최근 30일만 표시합니다.</p>
        {ga4Data?.missingDates.length ? <p className="text-xs text-[#FFD60A] mb-3">GA에서 확인되지 않은 날짜는 비워 표시합니다.</p> : null}
        {!ga4Data ? (
          <div className="text-sm text-[#FF453A] py-10">GA4 DAU를 불러오지 못했습니다. 0이나 트래픽 수치로 대체하지 않습니다.</div>
        ) : signupVsUv.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={signupVsUv}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} minTickGap={28} />
              <YAxis yAxisId="left" stroke="#636366" fontSize={12} />
              <YAxis yAxisId="right" orientation="right" stroke="#636366" fontSize={12} />
              <Tooltip {...tooltipStyle} />
              <Legend />
              <Line yAxisId="right" type="monotone" dataKey="활성사용자" name="DAU (GA4)" stroke="#6366F1" strokeWidth={2} dot={false} connectNulls={false} />
              <Line yAxisId="left" type="monotone" dataKey="가입자" stroke="#FFD60A" strokeWidth={2} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[280px] text-[#636366]">
            <BarChart3 className="w-8 h-8 mb-2" />
            <p>데이터 수집 전</p>
          </div>
        )}
      </div>

      {/* Team Distribution */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">팀별 분포</h2>
        {pieData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={({ name, value }) => `${name ?? ""} ${value}`}
                fontSize={11}
              >
                {pieData.map((entry, idx) => (
                  <Cell key={idx} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex flex-col items-center justify-center h-[280px] text-[#636366]">
            <Users className="w-8 h-8 mb-2" />
            <p>팀 분포 데이터 없음</p>
          </div>
        )}
      </div>

      {/* Recent Users */}
      <div className="glass-card p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-4">최근 가입자</h2>
        {recentUsers.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8">
                <th className="text-left py-2 text-[#8E8E93] font-medium">닉네임</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">팀</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">가입일</th>
              </tr>
            </thead>
            <tbody>
              {recentUsers.map((u, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-2.5">{u.nickname}</td>
                  <td className="py-2.5 text-[#8E8E93]">{u.team}</td>
                  <td className="py-2.5 text-[#8E8E93]">{u.joinedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center h-[200px] text-[#636366]">
            <Users className="w-8 h-8 mb-2" />
            <p>최근 가입자 없음</p>
          </div>
        )}
      </div>
    </div>
  );
}
