"use client";

import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import {
  Loader2,
  BarChart3,
  Users,
  FileText,
  MessageSquare,
  Camera,
  AlertTriangle,
  Bot,
  Globe,
  TrendingUp,
  MessagesSquare,
  Heart,
  Video,
  Image as ImageIcon,
} from "lucide-react";
import type { FeedbackItem } from "@/lib/admin/types";
import type { GaDauResponse } from "@/lib/admin/ga4-dau";
import { getTeamById } from "@/lib/constants/teams";

/* ── helpers ─────────────────────────────────────────── */

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

async function apiFetch<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { "x-admin-pin": getPin() },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

/* ── types for API responses ─────────────────────────── */

interface UsersResponse {
  todaySignups: number;
  recentUsers: { id: string; nickname: string; team_id: string; created_at: string }[];
}

interface ContentResponse {
  dailyPosts: {
    date: string;
    posts: number;
    comments: number;
    photos: number;
    chats: number;
    likes: number;
    gameReviewCount?: number;
    gameReviewUserCount?: number;
    postUserCount?: number;
    generalPostUserCount?: number;
    commentUserCount?: number;
    photoUserCount?: number;
    chatUserCount?: number;
    likeUserCount?: number;
  }[];
  // 직관 스토리 업로드 일별(영상/사진) 영구 롤업 — 개요 오늘 KPI 용.
  venueStoryDaily?: { date: string; videos: number; photos: number }[];
}

interface StatsResponse {
  data: { date: string; uv: number; pv: number }[];
}

interface FeedbackResponse {
  data: FeedbackItem[];
}

interface JobsResponse {
  data: { id: number; status: string }[];
}

interface ActiveUsersResponse {
  dau: number;
  wau: number;
  mau: number;
  total: number;
}

interface PagesResponse {
  pages: { path: string; views: number }[];
}

interface CohortResponse {
  weeklyUsers: { week: string; newUsers: number; returningUsers: number; total: number }[];
}

interface OverviewData {
  users: UsersResponse;
  content: ContentResponse;
  stats: StatsResponse;
  feedback: FeedbackResponse;
  jobs: JobsResponse;
  activeUsers: ActiveUsersResponse | null;
  gaDau: GaDauResponse | null;
  ga4Pages: PagesResponse | null;
  ga4Cohort: CohortResponse | null;
}

/* ── chart tooltip style ─────────────────────────────── */

const chartTooltipStyle = {
  contentStyle: {
    background: "#1C1C1F",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 12,
    fontSize: 13,
  },
  labelStyle: { color: "#8E8E93" },
};

/* ── KPI card config ─────────────────────────────────── */

interface KpiDef {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  detailType?: string;
}

function KpiCard({ label, value, icon, onClick }: KpiDef & { onClick?: () => void }) {
  return (
    <div
      className={`glass-card p-5 ${onClick ? "cursor-pointer hover:ring-1 hover:ring-white/10 transition-all" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="text-sm text-[#8E8E93]">{label}</p>
      </div>
      <p className="text-xl sm:text-2xl md:text-3xl font-bold tabular-nums tracking-tight whitespace-nowrap">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}

/* ── DAU / PV trend card (self-contained period toggle) ── */

type TrendPeriod = "today" | "7d" | "30d" | "90d" | "180d" | "all" | "cumulative";

const TREND_TABS: { key: TrendPeriod; label: string }[] = [
  { key: "today", label: "당일" },
  { key: "7d", label: "7일" },
  { key: "30d", label: "30일" },
  { key: "90d", label: "90일" },
  { key: "180d", label: "180일" },
  { key: "all", label: "전체(일별)" },
  { key: "cumulative", label: "누적" },
];

interface TrendResponse {
  period: string;
  series: { label: string; users: number | null; pv: number }[];
  cumulative: boolean;
}

function TrafficTrendCard({ metric }: { metric: "dau" | "pv" }) {
  const [period, setPeriod] = useState<TrendPeriod>("7d");
  const title = metric === "dau"
    ? period === "cumulative" ? "누적 방문자 (앱+웹)" : "DAU 추이 (GA4)"
    : "PV 추이 (앱+웹)";

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-white/5">
          {TREND_TABS.filter(t => metric === "dau" || t.key !== "all").map((t) => (
            <button
              key={t.key}
              onClick={() => setPeriod(t.key)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                period === t.key ? "bg-[#6366F1] text-white" : "text-[#8E8E93] hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* keyed by period → remounts on switch, so loading resets without a
          synchronous setState inside the effect */}
      <TrendChartBody key={period} metric={metric} period={period} />
    </div>
  );
}

function TrendChartBody({ metric, period }: { metric: "dau" | "pv"; period: TrendPeriod }) {
  const [series, setSeries] = useState<TrendResponse["series"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    // Owner scope: daily DAU is GA; PV/cumulative retain their existing source.
    // Source failures are visible and must not silently switch definitions.
    const gaDaily = metric === "dau" && period !== "cumulative" && period !== "today";
    const endpoint = gaDaily
      ? `/api/admin/analytics?type=daily-active-users&period=${period}`
      : metric === "dau" && period === "today"
        ? "/api/admin/analytics?type=trend&period=today"
        : `/api/admin/active-users?period=${period}`;
    apiFetch<TrendResponse | GaDauResponse>(endpoint)
      .then((r) => {
        if (!alive) return;
        if ("daily" in r) {
          setSeries(r.daily.map(d => ({ label: period === "all" ? d.date : d.date.slice(5).replace("-", "/"), users: d.activeUsers, pv: 0 })));
          setMissing(r.missingDates.length > 0);
        } else setSeries(r.series);
      })
      .catch(() => {
        if (alive) {
          setFailed(true);
          setSeries([]);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [metric, period]);

  const isDau = metric === "dau";
  const isCumulative = period === "cumulative";
  // Long daily windows (90d/180d) pack many points — widen tick spacing like
  // the cumulative view so the X축 labels don't overlap.
  const isLongDaily = period === "90d" || period === "180d" || period === "all";
  const color = isDau ? "#6366F1" : "#30D158";
  const lineName = isDau ? (isCumulative ? "누적 방문자" : "DAU") : isCumulative ? "누적 PV" : "PV";
  const caption = isCumulative
    ? isDau
      ? "누적 방문자"
      : "누적 페이지뷰"
    : period === "today"
      ? isDau
        ? "오늘 시간대별 활성 사용자"
        : "오늘 시간대별 페이지뷰"
      : isDau
        ? "GA4 일별 활성 사용자 · 최근 수치는 집계 지연으로 갱신될 수 있습니다"
        : "일별 페이지뷰";

  const chartData = (series ?? []).map((s) => ({
    label: s.label,
    value: isDau ? s.users : s.pv,
  }));

  return (
    <>
      <p className="text-xs text-[#8E8E93] mb-4">{caption}</p>
      {missing && <p className="text-xs text-[#FFD60A] mb-3">GA에서 확인되지 않은 날짜는 0으로 채우지 않고 비워 표시합니다.</p>}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-[#636366]" />
        </div>
      ) : failed ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#FF453A]">
          <AlertTriangle className="w-8 h-8" />
          <p className="text-sm">{isDau && !isCumulative ? "GA4 DAU 조회 실패 — 트래픽 수치로 대체하지 않습니다" : "자체 집계 조회 실패 — GA4로 대체하지 않습니다"}</p>
        </div>
      ) : chartData.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-[#636366]">
          <BarChart3 className="w-10 h-10" />
          <p className="text-sm">데이터 수집 전</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              stroke="#636366"
              fontSize={12}
              minTickGap={isCumulative || isLongDaily ? 28 : 8}
            />
            <YAxis stroke="#636366" fontSize={12} width={44} />
            <Tooltip {...chartTooltipStyle} />
            <Line
              type="monotone"
              dataKey="value"
              name={lineName}
              stroke={color}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </>
  );
}

/* ── Detail Modal ─────────────────────────────────────── */

interface DetailItem {
  id: number;
  time: string;
  nickname: string;
  title: string;
  content: string;
  link: string;
  imageUrls?: string[];
}

function DetailModal({
  title,
  type,
  onClose,
}: {
  title: string;
  type: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<DetailItem[]>([]);
  const [authors, setAuthors] = useState<{ nickname: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ items: DetailItem[]; topAuthors?: { nickname: string; count: number }[] }>(`/api/admin/today-detail?type=${type}`)
      .then((d) => { setItems(d.items); setAuthors(d.topAuthors ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [type]);

  const formatTime = (t: string) => {
    const d = new Date(t);
    return d.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[#1C1C1F] rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-[#8E8E93] hover:text-white text-xl">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">
          {type === "game_reviews" && (
            <p className="mb-3 text-xs text-[#8E8E93]">한국시간 오늘 작성 · 삭제 제외 · 숨김 포함 · 최신 100건</p>
          )}
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-[#636366]" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-center text-[#636366] py-10">데이터 없음</p>
          ) : (
            <>
            {authors.length > 0 && (
              <div className="mb-4 p-3 rounded-xl bg-white/5">
                <p className="text-xs text-[#8E8E93] mb-2">오늘 작성자 TOP 5</p>
                <div className="flex flex-wrap gap-2">
                  {authors.map((a, i) => (
                    <span key={a.nickname} className="text-sm">
                      <span className="text-[#8E8E93]">{i + 1}.</span>{" "}
                      <span className="font-medium">{a.nickname}</span>{" "}
                      <span className="text-[#636366]">({a.count}건)</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8">
                  <th className="text-left py-2 text-[#8E8E93] font-medium w-16">시간</th>
                  <th className="text-left py-2 text-[#8E8E93] font-medium w-20">작성자</th>
                  <th className="text-left py-2 text-[#8E8E93] font-medium">내용</th>
                  <th className="text-right py-2 text-[#8E8E93] font-medium w-12">링크</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-white/5">
                    <td className="py-2.5 text-[#8E8E93] whitespace-nowrap">{formatTime(item.time)}</td>
                    <td className="py-2.5 font-medium truncate max-w-[80px]">{item.nickname}</td>
                    <td className="py-2.5 max-w-[300px]">
                      <div className="whitespace-pre-wrap break-words text-sm">
                        {item.title && item.title !== "(제목 없음)" && item.title !== "(사진)"
                          ? <><span className="font-medium">{item.title}</span> <span className="text-[#8E8E93]">{item.content}</span></>
                          : /^https?:\/\/.*\.(gif|jpg|jpeg|png|webp)/i.test(item.content)
                            ? <a href={item.content} target="_blank" rel="noopener noreferrer"><img src={item.content} alt="" className="w-24 h-24 rounded object-cover" /></a>
                            : item.content}
                      </div>
                      {item.imageUrls && item.imageUrls.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {item.imageUrls.slice(0, 3).map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                              <img src={url} alt="" className="w-24 h-24 rounded object-cover" />
                            </a>
                          ))}
                          {item.imageUrls.length > 3 && (
                            <span className="text-xs text-[#8E8E93] self-end">+{item.imageUrls.length - 3}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {item.link && (
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#6366F1] hover:underline text-xs"
                        >
                          보기
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── feedback type dot color ─────────────────────────── */

const feedbackDotColor: Record<FeedbackItem["type"], string> = {
  bug: "#FF453A",
  data: "#FFD60A",
  feature: "#30D158",
  content: "#6366F1",
  android_test: "#0A84FF",
  other: "#8E8E93",
};


/* ── page component ──────────────────────────────────── */

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<OverviewData | null>(null);
  const [detailModal, setDetailModal] = useState<{ title: string; type: string } | null>(null);

  useEffect(() => {
    const fetchGA4 = async <T,>(type: string): Promise<T | null> => {
      try {
        return await apiFetch<T>(`/api/admin/analytics?type=${type}`);
      } catch {
        return null;
      }
    };

    Promise.all([
      apiFetch<UsersResponse>("/api/admin/users"),
      apiFetch<ContentResponse>("/api/admin/content?days=1"),
      apiFetch<StatsResponse>("/api/admin/stats?days=30"),
      apiFetch<FeedbackResponse>("/api/admin/feedback"),
      apiFetch<JobsResponse>("/api/admin/jobs?status=error&today=1"),
      fetchGA4<PagesResponse>("pages"),
      fetchGA4<CohortResponse>("cohort"),
      // 자체 집계 실패 시 null → fail-close 표시. GA4로 대체하지 않는다(지표 정의가 다름).
      apiFetch<ActiveUsersResponse>("/api/admin/active-users").catch(() => null),
      fetchGA4<GaDauResponse>("daily-active-users&period=today"),
    ])
      .then(([users, content, stats, feedback, jobs, ga4Pages, ga4Cohort, activeUsers, gaDau]) => {
        setData({ users, content, stats, feedback, jobs, ga4Pages, ga4Cohort, activeUsers, gaDau });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /* ── loading state ── */
  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[#636366]" />
      </div>
    );
  }

  /* ── extract KPI values ── */
  const todaySignups = data?.users?.todaySignups ?? 0;

  // KST 오늘 날짜 (YYYY-MM-DD) — 일별 카운트 필터용
  const todayKSTStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

  const todayContent = data?.content?.dailyPosts ?? [];
  const todayEntry = todayContent.find((d) => d.date === todayKSTStr);
  const todayPostsAll = todayEntry?.posts ?? 0;
  const todayPhotos_ = todayEntry?.photos ?? 0;
  const todayPosts = todayPostsAll - todayPhotos_; // 일반글만
  const todayComments = todayEntry?.comments ?? 0;
  const todayGameReviews = todayEntry?.gameReviewCount ?? 0;
  const gameReviewUserCount = todayEntry?.gameReviewUserCount ?? 0;
  const todayPhotos = todayPhotos_;
  const todayChats = todayEntry?.chats ?? 0;
  const todayLikes = todayEntry?.likes ?? 0;

  // 직관 스토리 오늘 업로드(영상/사진) — 전 기간 롤업에서 KST 오늘 분.
  const venueStoryDaily = data?.content?.venueStoryDaily ?? [];
  const todayVenue = venueStoryDaily.find((d) => d.date === todayKSTStr);
  const todayVenueVideos = todayVenue?.videos ?? 0;
  const todayVenuePhotos = todayVenue?.photos ?? 0;

  const generalPostUserCount = todayEntry?.generalPostUserCount ?? 0;
  const commentUserCount = todayEntry?.commentUserCount ?? 0;
  const photoUserCount = todayEntry?.photoUserCount ?? 0;
  const chatUserCount = todayEntry?.chatUserCount ?? 0;
  const likeUserCount = todayEntry?.likeUserCount ?? 0;

  const withUsers = (count: number, users: number) =>
    users > 0 ? `${count} (${users}명)` : `${count}`;

  const todayFeedback = (data?.feedback?.data ?? []).filter(
    (fb: { created_at?: string; createdAt?: string }) => {
      const ts = fb.created_at ?? fb.createdAt ?? "";
      return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }) === todayKSTStr;
    },
  ).length;

  // 크롤러 실패: API에서 오늘 KST 기준 에러만 반환
  const crawlerErrors = data?.jobs?.data?.length ?? 0;

  /* ── recent feedback (3) ── */
  const recentFeedback = (data?.feedback?.data ?? []).slice(0, 3);

  /* ── recent users (5) ── */
  const recentUsers = (data?.users?.recentUsers ?? []).slice(0, 5);

  /* ── popular pages ── */
  const popularPages = data?.ga4Pages?.pages ?? [];

  /* ── cohort ── */
  const cohortData = data?.ga4Cohort?.weeklyUsers ?? [];

  /* ── KPI definitions ── */
  const kpis: KpiDef[] = [
    { label: "오늘 가입자", value: todaySignups, icon: <Users className="w-4 h-4 text-[#6366F1]" /> },
    { label: "오늘 일반글", value: withUsers(todayPosts, generalPostUserCount), icon: <FileText className="w-4 h-4 text-[#30D158]" />, detailType: "posts" },
    { label: "오늘 한줄평", value: withUsers(todayGameReviews, gameReviewUserCount), icon: <MessageSquare className="w-4 h-4 text-[#BF5AF2]" />, detailType: "game_reviews" },
    { label: "오늘 댓글", value: withUsers(todayComments, commentUserCount), icon: <MessageSquare className="w-4 h-4 text-[#FFD60A]" />, detailType: "comments" },
    { label: "오늘 사진", value: withUsers(todayPhotos, photoUserCount), icon: <Camera className="w-4 h-4 text-[#FF9F0A]" />, detailType: "photos" },
    { label: "오늘 채팅(크관)", value: withUsers(todayChats, chatUserCount), icon: <MessagesSquare className="w-4 h-4 text-[#32D4EB]" />, detailType: "chats" },
    { label: "오늘 좋아요", value: withUsers(todayLikes, likeUserCount), icon: <Heart className="w-4 h-4 text-[#FF375F]" /> },
    { label: "오늘 직관 영상", value: todayVenueVideos, icon: <Video className="w-4 h-4 text-[#BF5AF2]" />, detailType: "venue_videos" },
    { label: "오늘 직관 사진", value: todayVenuePhotos, icon: <ImageIcon className="w-4 h-4 text-[#5AC8FA]" />, detailType: "venue_photos" },
    { label: "오늘 건의", value: todayFeedback, icon: <AlertTriangle className="w-4 h-4 text-[#FF453A]" /> },
    { label: "크롤러 실패", value: crawlerErrors, icon: <Bot className="w-4 h-4 text-[#FF453A]" /> },
  ];

  /* DAU alone returns to GA; WAU/MAU/total remain the existing internal KPIs.
     Neither source is a fallback for the other. */
  const activeKpis: KpiDef[] = [
    { label: "DAU (오늘·GA4)", value: data?.gaDau ? data.gaDau.dau ?? "집계 대기" : "조회 실패", icon: <TrendingUp className="w-4 h-4 text-[#6366F1]" /> },
    ...(data?.activeUsers ? [
        { label: "WAU (7일·앱+웹)", value: data.activeUsers.wau, icon: <TrendingUp className="w-4 h-4 text-[#30D158]" /> },
        { label: "MAU (30일·앱+웹)", value: data.activeUsers.mau, icon: <TrendingUp className="w-4 h-4 text-[#FF9F0A]" /> },
        { label: "누적 방문자 (앱+웹)", value: data.activeUsers.total, icon: <TrendingUp className="w-4 h-4 text-[#BF5AF2]" /> },
      ] : []),
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">대시보드 개요</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <KpiCard
            key={k.label}
            {...k}
            onClick={k.detailType ? () => setDetailModal({ title: k.label, type: k.detailType! }) : undefined}
          />
        ))}
      </div>

      {/* DAU is GA4; other KPIs keep the pre-existing source. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {activeKpis.map((k) => (
            <KpiCard key={k.label} {...k} />
          ))}
        </div>
      <p className="text-xs text-[#8E8E93]">오늘 DAU는 GA4 집계 중 수치입니다. 트래픽의 로그인 DAU와는 집계 기준이 다릅니다.</p>
      {!data?.activeUsers && (
        <div className="glass-card p-4 flex items-center gap-2 text-sm text-[#FF453A]">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>자체 집계 WAU/MAU/누적 조회 실패 — GA4로 대체하지 않습니다 (지표 정의 상이).</span>
        </div>
      )}

      {/* GA4 DAU / existing PV and cumulative series. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrafficTrendCard metric="dau" />
        <TrafficTrendCard metric="pv" />
      </div>

      {/* Popular Pages + Cohort row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Popular Pages */}
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">인기 페이지 (7일)</h2>
          </div>
          {popularPages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
              <Globe className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">데이터 없음</p>
            </div>
          ) : (
            <div className="space-y-2">
              {popularPages.map((p, i) => (
                <div key={p.path} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-[#636366] w-5 text-right shrink-0">{i + 1}</span>
                    <span className="text-sm truncate">{p.path}</span>
                  </div>
                  <span className="text-sm font-medium tabular-nums text-[#8E8E93] shrink-0">
                    {p.views.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cohort Retention */}
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-[#30D158]" />
            <h2 className="text-lg font-semibold">주간 신규/복귀 유저</h2>
          </div>
          {cohortData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
              <TrendingUp className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">데이터 없음</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={cohortData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="week" stroke="#636366" fontSize={12} tickFormatter={(w) => `W${w}`} />
                <YAxis stroke="#636366" fontSize={12} />
                <Tooltip
                  {...chartTooltipStyle}
                  formatter={(value?: number | string, name?: string) =>
                    [Number(value ?? 0).toLocaleString(), name === "newUsers" ? "신규" : "복귀"]
                  }
                  labelFormatter={(w) => `Week ${w}`}
                />
                <Bar dataKey="newUsers" fill="#6366F1" name="신규" radius={[4, 4, 0, 0]} />
                <Bar dataKey="returningUsers" fill="#30D158" name="복귀" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Bottom row: Recent Feedback + Recent Users */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recent Feedback */}
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">최근 건의</h2>
          {recentFeedback.length === 0 ? (
            <p className="text-sm text-[#636366] py-4 text-center">건의 없음</p>
          ) : (
            <ul className="space-y-3">
              {recentFeedback.map((fb) => (
                <li key={fb.id} className="flex items-start gap-3">
                  <span
                    className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: feedbackDotColor[fb.type] }}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{fb.title}</p>
                    <p className="text-xs text-[#8E8E93]">
                      {new Date((fb as FeedbackItem & { created_at?: string }).created_at ?? fb.createdAt).toLocaleDateString("ko-KR")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Users */}
        <div className="glass-card p-5">
          <h2 className="text-lg font-semibold mb-4">최근 가입자</h2>
          {recentUsers.length === 0 ? (
            <p className="text-sm text-[#636366] py-4 text-center">가입자 없음</p>
          ) : (
            <ul className="space-y-3">
              {recentUsers.map((u) => (
                <li key={u.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Users className="w-4 h-4 text-[#8E8E93] shrink-0" />
                    <span className="text-sm font-medium truncate">{u.nickname}</span>
                    {u.team_id && (
                      <span className="text-xs text-[#8E8E93] shrink-0">{getTeamById(Number(u.team_id))?.shortName ?? u.team_id}</span>
                    )}
                  </div>
                  <span className="text-xs text-[#636366] shrink-0 ml-2">
                    {new Date(u.created_at).toLocaleDateString("ko-KR")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      {detailModal && (
        <DetailModal
          title={detailModal.title}
          type={detailModal.type}
          onClose={() => setDetailModal(null)}
        />
      )}
    </div>
  );
}
