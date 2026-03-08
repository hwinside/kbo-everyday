"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  generateDailyStats,
  generateCohortData,
  TEAM_DISTRIBUTION,
  LEVEL_DISTRIBUTION,
} from "@/lib/admin/mock-data";

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

function CohortHeatmap() {
  const cohort = useMemo(() => generateCohortData(), []);
  const days = [0, 1, 2, 3, 5, 7, 14, 21, 30];

  return (
    <div className="glass-card p-5 overflow-x-auto">
      <h2 className="text-lg font-semibold mb-4">코호트 리텐션 히트맵</h2>
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="text-left py-2 px-2 text-[#8E8E93] font-medium">가입 주차</th>
            <th className="py-2 px-1 text-[#8E8E93] font-medium">코호트</th>
            {days.map((d) => (
              <th key={d} className="py-2 px-1 text-[#8E8E93] font-medium">
                D{d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohort.map((row) => (
            <tr key={row.week}>
              <td className="py-1.5 px-2 text-[#F5F5F7] font-medium">{row.week}</td>
              <td className="py-1.5 px-1 text-center text-[#8E8E93]">{row.cohortSize}</td>
              {days.map((d) => {
                const val = row.retention[d];
                if (val < 0) {
                  return <td key={d} className="py-1.5 px-1" />;
                }
                const alpha = val / 100;
                return (
                  <td key={d} className="py-1.5 px-1">
                    <div
                      className="w-full text-center py-1 rounded"
                      style={{
                        background: `rgba(48, 209, 88, ${alpha * 0.7})`,
                        color: alpha > 0.4 ? "#fff" : "#8E8E93",
                      }}
                    >
                      {val}%
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminUsersPage() {
  const stats = useMemo(() => generateDailyStats(), []);

  const signupVsUv = stats.map((s) => ({
    date: s.date.slice(5),
    가입자: s.newUsers,
    UV: s.uv,
  }));

  // Simulate DAU/WAU/MAU
  const dauWauMau = stats.map((s, i) => ({
    date: s.date.slice(5),
    DAU: s.uv,
    WAU: Math.round(s.uv * 2.5 + i * 10),
    MAU: Math.round(s.uv * 5 + i * 20),
  }));

  /* eslint-disable react-hooks/purity */
  const recentUsers = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    nickname: `유저${1000 + i}`,
    team: TEAM_DISTRIBUTION[i % 10].team,
    joinedAt: new Date(Date.now() - i * 3600000 * 4).toLocaleString("ko-KR"),
    posts: Math.floor(Math.random() * 20),
  }));
  /* eslint-enable react-hooks/purity */

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">유저 분석</h1>

      {/* Signup vs UV */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">가입자 vs UV 추이</h2>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={signupVsUv}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#636366" fontSize={12} />
            <YAxis yAxisId="left" stroke="#636366" fontSize={12} />
            <YAxis yAxisId="right" orientation="right" stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Legend />
            <Line yAxisId="right" type="monotone" dataKey="UV" stroke="#6366F1" strokeWidth={2} dot={false} />
            <Line yAxisId="left" type="monotone" dataKey="가입자" stroke="#FFD60A" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* DAU / WAU / MAU */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">DAU / WAU / MAU</h2>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={dauWauMau}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Legend />
            <Line type="monotone" dataKey="DAU" stroke="#6366F1" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="WAU" stroke="#30D158" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="MAU" stroke="#FF453A" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Team + Level Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">팀별 분포</h2>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={TEAM_DISTRIBUTION}
                dataKey="value"
                nameKey="team"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                label={({ name, value }) => `${name ?? ""} ${value}%`}
                fontSize={11}
              >
                {TEAM_DISTRIBUTION.map((entry) => (
                  <Cell key={entry.team} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">레벨 분포</h2>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={LEVEL_DISTRIBUTION}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="level" stroke="#636366" fontSize={11} />
              <YAxis stroke="#636366" fontSize={12} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" fill="#6366F1" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Cohort Heatmap */}
      <CohortHeatmap />

      {/* Recent Users */}
      <div className="glass-card p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-4">최근 가입자</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8">
              <th className="text-left py-2 text-[#8E8E93] font-medium">닉네임</th>
              <th className="text-left py-2 text-[#8E8E93] font-medium">팀</th>
              <th className="text-left py-2 text-[#8E8E93] font-medium">가입일</th>
              <th className="text-right py-2 text-[#8E8E93] font-medium">게시글</th>
            </tr>
          </thead>
          <tbody>
            {recentUsers.map((u) => (
              <tr key={u.id} className="border-b border-white/5">
                <td className="py-2.5">{u.nickname}</td>
                <td className="py-2.5 text-[#8E8E93]">{u.team}</td>
                <td className="py-2.5 text-[#8E8E93]">{u.joinedAt}</td>
                <td className="py-2.5 text-right tabular-nums">{u.posts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
