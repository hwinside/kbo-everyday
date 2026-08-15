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

interface GA4DauResponse {
  daily: { date: string; activeUsers: number; pageViews: number }[];
  dau: number;
  wau: number;
  mau: number;
}

export default function AdminUsersPage() {
  const [loading, setLoading] = useState(true);
  const [usersData, setUsersData] = useState<UsersResponse | null>(null);
  const [ga4Data, setGa4Data] = useState<GA4DauResponse | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [users, ga4] = await Promise.all([
          apiFetch<UsersResponse>("/api/admin/users"),
          apiFetch<GA4DauResponse>("/api/admin/analytics?type=dau").catch(() => null),
        ]);
        setUsersData(users);
        setGa4Data(ga4);
      } catch (e) {
        console.error("Failed to load admin users data:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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

  // Signup vs UV chart data — combine profiles dailySignups + GA4 UV
  const ga4Daily = ga4Data?.daily ?? [];
  const ga4UvMap = new Map(ga4Daily.map((d) => {
    // GA4 date format: "20260414" → "04/14"
    return [`${d.date.slice(4, 6)}/${d.date.slice(6)}`, d.activeUsers];
  }));

  const dailySignups = usersData.dailySignups ?? [];
  const signupVsUv = dailySignups.length > 0
    ? dailySignups.map((s) => {
        const label = s.date.slice(5).replace("-", "/");
        return {
          date: label,
          가입자: s.count,
          활성사용자: ga4UvMap.get(label) ?? 0,
        };
      })
    : ga4Daily.map((d) => ({
        date: `${d.date.slice(4, 6)}/${d.date.slice(6)}`,
        가입자: 0,
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
        <h2 className="text-lg font-semibold mb-4">가입자 vs 활성 사용자 추이</h2>
        {signupVsUv.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={signupVsUv}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} />
              <YAxis yAxisId="left" stroke="#636366" fontSize={12} />
              <YAxis yAxisId="right" orientation="right" stroke="#636366" fontSize={12} />
              <Tooltip {...tooltipStyle} />
              <Legend />
              <Line yAxisId="right" type="monotone" dataKey="활성사용자" stroke="#6366F1" strokeWidth={2} dot={false} />
              <Line yAxisId="left" type="monotone" dataKey="가입자" stroke="#FFD60A" strokeWidth={2} dot={false} />
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
