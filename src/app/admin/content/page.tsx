"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { generateDailyStats } from "@/lib/admin/mock-data";
import { TEAMS } from "@/lib/constants/teams";

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

function TeamActivityHeatmap() {
  const teams = TEAMS.map((t) => t.shortName);
  const days = ["월", "화", "수", "목", "금", "토", "일"];
  // Generate mock heatmap data
  const data = teams.map((team) => ({
    team,
    values: days.map(() => Math.floor(Math.random() * 100)),
  }));

  return (
    <div className="glass-card p-5 overflow-x-auto">
      <h2 className="text-lg font-semibold mb-4">팀별 게시판 활성도 (이번 주)</h2>
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="text-left py-2 px-2 text-[#8E8E93] font-medium">팀</th>
            {days.map((d) => (
              <th key={d} className="py-2 px-2 text-[#8E8E93] font-medium text-center">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.team}>
              <td className="py-1.5 px-2 font-medium">{row.team}</td>
              {row.values.map((val, i) => {
                const alpha = val / 100;
                return (
                  <td key={i} className="py-1.5 px-1">
                    <div
                      className="text-center py-1 rounded"
                      style={{
                        background: `rgba(99, 102, 241, ${alpha * 0.8})`,
                        color: alpha > 0.4 ? "#fff" : "#8E8E93",
                      }}
                    >
                      {val}
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

export default function AdminContentPage() {
  const stats = useMemo(() => generateDailyStats(), []);

  const postCommentData = stats.map((s) => ({
    date: s.date.slice(5),
    게시글: s.posts,
    댓글: s.comments,
  }));

  const photoData = stats.map((s) => ({
    date: s.date.slice(5),
    직찍: s.photos,
  }));

  const popularPosts = [
    { id: 1, title: "오늘 잠실 직관 후기", team: "LG", views: 3420, comments: 156, date: "03/04" },
    { id: 2, title: "KIA 선발 로테이션 분석", team: "KIA", views: 2890, comments: 98, date: "03/04" },
    { id: 3, title: "두산 신인 드래프트 예상", team: "두산", views: 2654, comments: 134, date: "03/03" },
    { id: 4, title: "삼성 외국인 선수 평가", team: "삼성", views: 2340, comments: 87, date: "03/03" },
    { id: 5, title: "롯데 사직 구장 맛집 추천", team: "롯데", views: 2120, comments: 203, date: "03/02" },
    { id: 6, title: "SSG 개막전 예매 꿀팁", team: "SSG", views: 1980, comments: 76, date: "03/02" },
    { id: 7, title: "한화 시범경기 리뷰", team: "한화", views: 1845, comments: 64, date: "03/01" },
    { id: 8, title: "NC 포수 수비 스탯 분석", team: "NC", views: 1720, comments: 52, date: "03/01" },
    { id: 9, title: "KT 위즈파크 좌석 가이드", team: "KT", views: 1650, comments: 89, date: "02/28" },
    { id: 10, title: "키움 유망주 2군 성적", team: "키움", views: 1540, comments: 41, date: "02/28" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">콘텐츠 분석</h1>

      {/* Post + Comment daily */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">게시글 / 댓글 일별 추이</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={postCommentData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Legend />
            <Bar dataKey="게시글" stackId="a" fill="#6366F1" radius={[0, 0, 0, 0]} />
            <Bar dataKey="댓글" stackId="a" fill="#30D158" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Photo upload trend */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">직찍 업로드 추이</h2>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={photoData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Line type="monotone" dataKey="직찍" stroke="#FFD60A" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Team Activity Heatmap */}
      <TeamActivityHeatmap />

      {/* Popular Posts */}
      <div className="glass-card p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-4">인기 게시글 Top 10</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8">
              <th className="text-left py-2 text-[#8E8E93] font-medium">#</th>
              <th className="text-left py-2 text-[#8E8E93] font-medium">제목</th>
              <th className="text-left py-2 text-[#8E8E93] font-medium">팀</th>
              <th className="text-right py-2 text-[#8E8E93] font-medium">조회</th>
              <th className="text-right py-2 text-[#8E8E93] font-medium">댓글</th>
              <th className="text-right py-2 text-[#8E8E93] font-medium">날짜</th>
            </tr>
          </thead>
          <tbody>
            {popularPosts.map((p) => (
              <tr key={p.id} className="border-b border-white/5">
                <td className="py-2.5 text-[#636366]">{p.id}</td>
                <td className="py-2.5 font-medium">{p.title}</td>
                <td className="py-2.5 text-[#8E8E93]">{p.team}</td>
                <td className="py-2.5 text-right tabular-nums">{p.views.toLocaleString()}</td>
                <td className="py-2.5 text-right tabular-nums">{p.comments}</td>
                <td className="py-2.5 text-right text-[#8E8E93]">{p.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
