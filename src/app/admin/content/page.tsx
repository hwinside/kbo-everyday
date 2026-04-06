"use client";

import { useState, useEffect } from "react";
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
import { Loader2, FileText } from "lucide-react";
import { TEAMS } from "@/lib/constants/teams";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

interface DailyPost {
  date: string;
  posts: number;
  comments: number;
  photos: number;
}

interface PopularPost {
  id: string;
  title: string;
  board_id: string;
  board_type?: string | null;
  like_count: number;
  comment_count: number;
  created_at: string;
  image_urls?: string[];
}

interface TeamActivity {
  board_id: string;
  count: number;
}

interface ContentData {
  dailyPosts: DailyPost[];
  popularPosts: PopularPost[];
  teamActivity: TeamActivity[];
}

function getPin(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch(path: string): Promise<ContentData> {
  const pin = getPin();
  const res = await fetch(path, {
    headers: pin ? { "x-admin-pin": pin } : {},
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function boardIdToTeamName(boardId: string, boardType?: string | null): string {
  // Determine type: if boardType is set, use it; otherwise infer from boardId format
  const inferredType = boardType || (TEAMS.some(t => t.slug === boardId || String(t.id) === boardId) ? "team" : "player");

  if (inferredType === "player") {
    const entry = Object.entries(PLAYER_PHOTO_MAP).find(([, id]) => id === boardId);
    return entry ? `⚾ ${entry[0]}` : `⚾ 선수 #${boardId}`;
  }
  const team = TEAMS.find((t) => t.slug === boardId || String(t.id) === boardId);
  return team ? team.shortName : boardId;
}

function postLabel(p: PopularPost): string {
  if (p.title && p.title.trim()) return p.title;
  // Photo posts have no title by design → emoji + name + datetime
  const isTeam = TEAMS.some(t => t.slug === p.board_id || String(t.id) === p.board_id);
  const name = boardIdToTeamName(p.board_id, p.board_type);
  const prefix = isTeam ? "🏟️ " : "";
  const dt = p.created_at?.slice(0, 16).replace("T", " ").replace(/-/g, ".") ?? "";
  return `${prefix}${name} · ${dt}`;
}

export default function AdminContentPage() {
  const [data, setData] = useState<ContentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/content?days=30")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-[#8E8E93]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-[#8E8E93]">
        <p>데이터를 불러오지 못했습니다</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    );
  }

  const dailyPosts = data?.dailyPosts ?? [];
  const popularPosts = data?.popularPosts ?? [];
  const teamActivity = data?.teamActivity ?? [];

  const postCommentData = dailyPosts.map((s) => ({
    date: s.date.slice(5),
    게시글: s.posts,
    댓글: s.comments,
  }));

  const photoData = dailyPosts.map((s) => ({
    date: s.date.slice(5),
    직찍: s.photos,
  }));

  const teamActivityData = teamActivity.map((t) => ({
    팀: boardIdToTeamName(t.board_id),
    게시글: t.count,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">콘텐츠 분석</h1>

      {/* Post + Comment daily */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">게시글 / 댓글 일별 추이</h2>
        {dailyPosts.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] text-[#8E8E93]">
            <p>아직 데이터 없음</p>
          </div>
        ) : (
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
        )}
      </div>

      {/* Photo upload trend */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">직찍 업로드 추이</h2>
        {dailyPosts.length === 0 ? (
          <div className="flex items-center justify-center h-[240px] text-[#8E8E93]">
            <p>아직 데이터 없음</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={photoData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} />
              <YAxis stroke="#636366" fontSize={12} />
              <Tooltip {...tooltipStyle} />
              <Line type="monotone" dataKey="직찍" stroke="#FFD60A" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Team Activity Bar Chart */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">팀별 게시판 활성도</h2>
        {teamActivity.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] text-[#8E8E93]">
            <p>아직 데이터 없음</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={teamActivityData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis type="number" stroke="#636366" fontSize={12} />
              <YAxis dataKey="팀" type="category" stroke="#636366" fontSize={12} width={40} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="게시글" fill="#6366F1" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Popular Posts */}
      <div className="glass-card p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold mb-4">인기 게시글 Top 10</h2>
        {popularPosts.length === 0 ? (
          <div className="flex items-center justify-center h-[200px] text-[#8E8E93]">
            <FileText className="w-5 h-5 mr-2" />
            <p>인기 게시글 없음</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8">
                <th className="text-left py-2 text-[#8E8E93] font-medium">#</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">제목</th>
                <th className="text-left py-2 text-[#8E8E93] font-medium">팀</th>
                <th className="text-right py-2 text-[#8E8E93] font-medium pr-3">반응</th>
                <th className="text-right py-2 text-[#8E8E93] font-medium pl-3">날짜</th>
              </tr>
            </thead>
            <tbody>
              {popularPosts.map((p, i) => (
                <tr key={p.id} className="border-b border-white/5">
                  <td className="py-2.5 text-[#636366]">{i + 1}</td>
                  <td className="py-2.5 font-medium max-w-[200px] truncate">{postLabel(p)}</td>
                  <td className="py-2.5 text-[#8E8E93]">{boardIdToTeamName(p.board_id, p.board_type)}</td>
                  <td className="py-2.5 text-right tabular-nums pr-3">
                    {(p.like_count + p.comment_count).toLocaleString()}
                  </td>
                  <td className="py-2.5 text-right text-[#8E8E93] pl-3">
                    {p.created_at.slice(5, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
