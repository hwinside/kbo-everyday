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
import StackedTooltip from "@/components/admin/StackedTooltip";
import { Loader2, FileText, Trash2 } from "lucide-react";
import { TEAMS } from "@/lib/constants/teams";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import ROSTER from "@/lib/constants/players-roster.json";

const tooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

interface ContentDay {
  date: string;
  posts: number;
  comments: number;
  photos: number;
  chats: number;
}

interface VenueStoryDay {
  date: string;
  videos: number;
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

interface EngagedDay {
  date: string;
  engaged: number;
  firstEngaged: number;
}

interface ContentData {
  popularPosts: PopularPost[];
  teamActivity: TeamActivity[];
  engagedDaily: EngagedDay[];
  contentDaily: ContentDay[];
  venueStoryDaily?: VenueStoryDay[];
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
    const rosterEntry = (ROSTER as { kboId: string; name: string; team: string }[]).find(r => r.kboId === boardId);
    if (rosterEntry) return `⚾ ${rosterEntry.team}/${rosterEntry.name}`;
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

/* ── 기간 토글 (7일/30일/누적) 공용 ── */

type TrendPeriod = "7d" | "30d" | "cumulative";

const PERIOD_TABS: { key: TrendPeriod; label: string }[] = [
  { key: "7d", label: "7일" },
  { key: "30d", label: "30일" },
  { key: "cumulative", label: "누적" },
];

function PeriodTabs({ period, onChange }: { period: TrendPeriod; onChange: (p: TrendPeriod) => void }) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-white/5">
      {PERIOD_TABS.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            period === t.key ? "bg-[#6366F1] text-white" : "text-[#8E8E93] hover:text-white"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// KST 기준 오늘까지 최근 N일 날짜 목록 (데이터 없는 날도 0으로 채우기 위함)
function kstWindowDates(days: number): string[] {
  const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const end = new Date(todayKST + "T00:00:00Z").getTime();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

// 콘텐츠 일별 카운트 차트 카드: 7일/30일(일별) / 누적(running sum 라인)
// rows 는 { date, ...숫자필드 } 형식이면 무엇이든 받는다(콘텐츠/직관 스토리 공용).
function ContentTrendCard<T extends { date: string }>({
  title,
  rows,
  series,
  dailyKind,
  height,
}: {
  title: string;
  rows: T[];
  series: { key: Exclude<keyof T, "date">; label: string; color: string }[];
  dailyKind: "bar" | "line";
  height: number;
}) {
  const [period, setPeriod] = useState<TrendPeriod>("7d");
  const isCumulative = period === "cumulative";

  let chartData: Record<string, string | number>[];
  if (isCumulative) {
    const running: Record<string, number> = {};
    chartData = rows.map((r) => {
      const point: Record<string, string | number> = { label: r.date.slice(5) };
      for (const s of series) {
        const key = s.key as string;
        running[key] = (running[key] ?? 0) + Number(r[s.key] ?? 0);
        point[s.label] = running[key];
      }
      return point;
    });
  } else {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    chartData = kstWindowDates(period === "30d" ? 30 : 7).map((date) => {
      const row = byDate.get(date);
      const point: Record<string, string | number> = { label: date.slice(5) };
      for (const s of series) point[s.label] = Number(row?.[s.key] ?? 0);
      return point;
    });
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-lg font-semibold">{title}</h2>
        <PeriodTabs period={period} onChange={setPeriod} />
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center text-[#8E8E93]" style={{ height }}>
          <p>아직 데이터 없음</p>
        </div>
      ) : isCumulative || dailyKind === "line" ? (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="#636366" fontSize={12} minTickGap={isCumulative ? 28 : 8} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            {series.length > 1 && <Legend />}
            {series.map((s) => (
              <Line key={String(s.key)} type="monotone" dataKey={s.label} stroke={s.color} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip content={<StackedTooltip />} />
            {series.length > 1 && <Legend />}
            {series.map((s, i) => (
              <Bar
                key={String(s.key)}
                dataKey={s.label}
                stackId="a"
                fill={s.color}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* ── Engaged User trend card (7일/30일/누적 토글) ── */

// KST 기준 오늘부터 거꾸로 N일 창을 채운다 (작성 0명인 날도 0으로 표시)
function fillDailyWindow(rows: EngagedDay[], days: number): { label: string; value: number }[] {
  const byDate = new Map(rows.map((r) => [r.date, r.engaged]));
  return kstWindowDates(days).map((date) => ({
    label: date.slice(5),
    value: byDate.get(date) ?? 0,
  }));
}

function EngagedUsersCard({ rows }: { rows: EngagedDay[] }) {
  const [period, setPeriod] = useState<TrendPeriod>("7d");
  const isCumulative = period === "cumulative";

  let chartData: { label: string; value: number }[];
  if (isCumulative) {
    let running = 0;
    chartData = rows.map((r) => {
      running += r.firstEngaged;
      return { label: r.date.slice(5), value: running };
    });
  } else {
    chartData = fillDailyWindow(rows, period === "30d" ? 30 : 7);
  }

  const caption = isCumulative
    ? "런칭 이후 누적 참여 유저 (중복 제외)"
    : "글/댓글/크관 채팅/사진 중 하나 이상 작성한 유저 수 (일별)";

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
        <h2 className="text-lg font-semibold">Engaged User 추이</h2>
        <PeriodTabs period={period} onChange={setPeriod} />
      </div>
      <p className="text-xs text-[#8E8E93] mb-4">{caption}</p>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-[260px] text-[#8E8E93]">
          <p>데이터 수집 전</p>
        </div>
      ) : isCumulative ? (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="#636366" fontSize={12} minTickGap={28} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Line type="monotone" dataKey="value" name="누적 참여 유저" stroke="#64D2FF" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="value" name="참여 유저" fill="#64D2FF" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function DedupPhotosSection() {
  const [checking, setChecking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<{ duplicateGroups: number; postsToDelete: number } | null>(null);
  const [deleteResult, setDeleteResult] = useState<{ deleted: number; dmSent?: number } | null>(null);

  const pin = getPin();
  const headers: Record<string, string> = pin ? { "x-admin-pin": pin } : {};

  async function handleCheck() {
    setChecking(true);
    setResult(null);
    setDeleteResult(null);
    try {
      const res = await fetch("/api/admin/dedup-photos", { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      setResult(await res.json());
    } catch { setResult(null); }
    finally { setChecking(false); }
  }

  async function handleDelete() {
    if (!confirm("중복 사진 게시물을 삭제합니다. 계속할까요?")) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/dedup-photos", { method: "POST", headers });
      if (!res.ok) throw new Error(`${res.status}`);
      setDeleteResult(await res.json());
      setResult(null);
    } catch { /* noop */ }
    finally { setDeleting(false); }
  }

  return (
    <div className="glass-card p-5">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Trash2 className="w-5 h-5" />
        사진 중복 게시물 정리
      </h2>
      <p className="text-sm text-[#8E8E93] mb-4">
        24시간 내 같은 유저가 같은 이미지를 중복 업로드한 게시물을 찾아 삭제합니다. 가장 먼저 올린 글만 유지됩니다.
      </p>
      <div className="flex gap-3">
        <button
          onClick={handleCheck}
          disabled={checking}
          className="px-4 py-2 rounded-lg bg-[#6366F1] text-white text-sm font-medium disabled:opacity-50"
        >
          {checking ? "조회 중..." : "중복 조회"}
        </button>
        {result && result.postsToDelete > 0 && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium disabled:opacity-50"
          >
            {deleting ? "삭제 중..." : `${result.postsToDelete}건 삭제`}
          </button>
        )}
      </div>
      {result && (
        <p className="mt-3 text-sm">
          {result.postsToDelete === 0
            ? "중복 게시물 없음"
            : `${result.duplicateGroups}개 그룹, ${result.postsToDelete}건 삭제 대상`}
        </p>
      )}
      {deleteResult && (
        <p className="mt-3 text-sm text-green-400">
          {deleteResult.deleted}건 삭제 완료{deleteResult.dmSent ? `, ${deleteResult.dmSent}명에게 쪽지 발송` : ""}
        </p>
      )}
    </div>
  );
}

export default function AdminContentPage() {
  const [data, setData] = useState<ContentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/content?days=10")
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

  const popularPosts = data?.popularPosts ?? [];
  const teamActivity = data?.teamActivity ?? [];
  const contentDaily = data?.contentDaily ?? [];
  const venueStoryDaily = data?.venueStoryDaily ?? [];

  const teamActivityData = teamActivity
    .filter((t) => TEAMS.some((team) => team.slug === t.board_id || String(team.id) === t.board_id))
    .map((t) => ({
      팀: boardIdToTeamName(t.board_id),
      게시글: t.count,
    }))
    .sort((a, b) => b.게시글 - a.게시글);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">콘텐츠 분석</h1>

      {/* Engaged Users */}
      <EngagedUsersCard rows={data?.engagedDaily ?? []} />

      {/* Post + Comment trend */}
      <ContentTrendCard
        title="게시글 / 댓글 추이"
        rows={contentDaily}
        series={[
          { key: "posts", label: "게시글", color: "#6366F1" },
          { key: "comments", label: "댓글", color: "#30D158" },
        ]}
        dailyKind="bar"
        height={300}
      />

      {/* Chat trend */}
      <ContentTrendCard
        title="크관 채팅 추이"
        rows={contentDaily}
        series={[{ key: "chats", label: "채팅", color: "#FF9F0A" }]}
        dailyKind="bar"
        height={240}
      />

      {/* Photo upload trend */}
      <ContentTrendCard
        title="사진 업로드 추이"
        rows={contentDaily}
        series={[{ key: "photos", label: "사진", color: "#FFD60A" }]}
        dailyKind="line"
        height={240}
      />

      {/* 직관 스토리 업로드 추이(영상/사진) — 실제 GPS 인증 업로드만, 그날 업로드 수 영구 보존 */}
      <ContentTrendCard
        title="직관 스토리 업로드 추이"
        rows={venueStoryDaily}
        series={[
          { key: "videos", label: "영상", color: "#BF5AF2" },
          { key: "photos", label: "사진", color: "#5AC8FA" },
        ]}
        dailyKind="bar"
        height={260}
      />

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

      {/* Dedup Photos */}
      <DedupPhotosSection />
    </div>
  );
}
