"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Inbox, Eye, CheckCircle, XCircle, ChevronDown, Loader2 } from "lucide-react";
import type { FeedbackItem } from "@/lib/admin/types";

/* ── Labels & Colors ── */

const TYPE_LABELS: Record<string, string> = {
  bug: "버그",
  data: "데이터 수정",
  feature: "기능 제안",
  content: "콘텐츠",
  other: "기타",
};

const TYPE_COLORS: Record<string, string> = {
  bug: "#FF453A",
  data: "#FFD60A",
  feature: "#6366F1",
  content: "#30D158",
  other: "#8E8E93",
};

const STATUS_LABELS: Record<string, string> = {
  received: "접수",
  reviewing: "검토중",
  done: "완료",
  rejected: "반려",
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "received":
      return <Inbox className="w-4 h-4 text-[#6366F1]" />;
    case "reviewing":
      return <Eye className="w-4 h-4 text-[#FFD60A]" />;
    case "done":
      return <CheckCircle className="w-4 h-4 text-[#30D158]" />;
    case "rejected":
      return <XCircle className="w-4 h-4 text-[#FF453A]" />;
    default:
      return null;
  }
}

/* ── Data Mapping ── */

/* ── Raw DB row shape ── */

interface FeedbackRaw {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  page_url: string | null;
  device_info: string | null;
  status: string;
  admin_note: string | null;
  created_at: string;
}

function mapFeedback(raw: FeedbackRaw): FeedbackItem {
  return {
    id: raw.id,
    userId: raw.user_id,
    type: raw.type as FeedbackItem["type"],
    title: raw.title,
    body: raw.body,
    pageUrl: raw.page_url,
    deviceInfo: raw.device_info,
    status: raw.status as FeedbackItem["status"],
    adminNote: raw.admin_note,
    createdAt: raw.created_at,
  };
}

/* ── Chart Data Helper ── */

function buildChartData(items: FeedbackItem[]) {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  return days.map((dateStr) => {
    const label = dateStr.slice(5); // MM-DD
    const dayItems = items.filter((it) => it.createdAt.slice(0, 10) === dateStr);
    return {
      date: label,
      버그: dayItems.filter((it) => it.type === "bug").length,
      "데이터 수정": dayItems.filter((it) => it.type === "data").length,
      "기능 제안": dayItems.filter((it) => it.type === "feature").length,
      콘텐츠: dayItems.filter((it) => it.type === "content").length,
      기타: dayItems.filter((it) => it.type === "other").length,
    };
  });
}

/* ── Page Component ── */

export default function AdminFeedbackPage() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [noteValues, setNoteValues] = useState<Record<number, string>>({});

  const getPin = useCallback(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("admin_pin") || "";
    }
    return "";
  }, []);

  /* ── Fetch ── */

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/feedback", {
          headers: { "x-admin-pin": getPin() },
        });
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json();
        if (!cancelled) {
          const mapped = (json.data as FeedbackRaw[]).map(mapFeedback);
          setItems(mapped);
        }
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [getPin]);

  /* ── Derived ── */

  const statusCounts = useMemo(
    () => ({
      received: items.filter((i) => i.status === "received").length,
      reviewing: items.filter((i) => i.status === "reviewing").length,
      done: items.filter((i) => i.status === "done").length,
      rejected: items.filter((i) => i.status === "rejected").length,
    }),
    [items],
  );

  const filteredItems = useMemo(
    () => (typeFilter === "all" ? items : items.filter((i) => i.type === typeFilter)),
    [items, typeFilter],
  );

  const chartData = useMemo(() => buildChartData(items), [items]);

  /* ── Handlers ── */

  async function handleStatusChange(id: number, status: string) {
    const res = await fetch("/api/admin/feedback", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-pin": getPin(),
      },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, status: status as FeedbackItem["status"] } : it)),
      );
    }
  }

  async function handleSaveNote(id: number, adminNote: string) {
    const res = await fetch("/api/admin/feedback", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-admin-pin": getPin(),
      },
      body: JSON.stringify({ id, admin_note: adminNote }),
    });
    if (res.ok) {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, adminNote } : it)),
      );
    }
  }

  /* ── Tooltip Style ── */

  const tooltipStyle = {
    contentStyle: {
      background: "#1C1C1F",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 12,
      fontSize: 13,
    },
    labelStyle: { color: "#8E8E93" },
  };

  /* ── Loading State ── */

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 animate-spin text-[#6366F1]" />
      </div>
    );
  }

  /* ── Empty State ── */

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-32 text-[#8E8E93]">
        건의 없음
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">건의함 관리</h1>

      {/* Status Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.entries(statusCounts) as [string, number][]).map(([status, count]) => (
          <div key={status} className="glass-card p-5 text-center">
            <div className="flex items-center justify-center gap-2 mb-2">
              <StatusIcon status={status} />
              <span className="text-sm text-[#8E8E93]">{STATUS_LABELS[status]}</span>
            </div>
            <p className="text-3xl font-bold">{count}</p>
          </div>
        ))}
      </div>

      {/* Feedback Trend Chart */}
      <div className="glass-card p-5">
        <h2 className="text-lg font-semibold mb-4">인입 추이 (최근 7일)</h2>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#636366" fontSize={12} />
            <YAxis stroke="#636366" fontSize={12} />
            <Tooltip {...tooltipStyle} />
            <Legend />
            <Bar dataKey="버그" stackId="a" fill="#FF453A" />
            <Bar dataKey="데이터 수정" stackId="a" fill="#FFD60A" />
            <Bar dataKey="기능 제안" stackId="a" fill="#6366F1" />
            <Bar dataKey="콘텐츠" stackId="a" fill="#30D158" />
            <Bar dataKey="기타" stackId="a" fill="#8E8E93" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Filter + List */}
      <div className="glass-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold">건의 목록</h2>
          <div className="relative">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="appearance-none bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 pr-8 text-sm outline-none focus:border-[#6366F1]"
            >
              <option value="all">전체 분류</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[#636366] pointer-events-none" />
          </div>
        </div>

        <div className="space-y-2">
          {filteredItems.map((item) => {
            const isExpanded = expandedId === item.id;
            const noteKey = item.id;
            const currentNote = noteValues[noteKey] ?? item.adminNote ?? "";

            return (
              <div
                key={item.id}
                className="rounded-xl bg-white/3 hover:bg-white/5 transition-colors"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  className="w-full text-left p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{ background: TYPE_COLORS[item.type] }}
                        />
                        <span className="text-xs text-[#8E8E93]">{TYPE_LABELS[item.type]}</span>
                        <span className="text-xs text-[#636366]">
                          {new Date(item.createdAt).toLocaleDateString("ko-KR")}
                        </span>
                      </div>
                      <p className="font-medium text-sm truncate">{item.title}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <StatusIcon status={item.status} />
                      <span className="text-xs text-[#8E8E93]">{STATUS_LABELS[item.status]}</span>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3 text-sm">
                    <div className="pt-3 border-t border-white/8 space-y-2">
                      {item.body && <p className="text-[#8E8E93]">{item.body}</p>}
                      {item.pageUrl && (
                        <p className="text-xs text-[#636366]">페이지: {item.pageUrl}</p>
                      )}
                      {item.deviceInfo && (
                        <p className="text-xs text-[#636366]">기기: {item.deviceInfo}</p>
                      )}
                    </div>

                    {/* Status Change */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#8E8E93]">상태:</span>
                      <select
                        value={item.status}
                        onChange={(e) => handleStatusChange(item.id, e.target.value)}
                        className="appearance-none bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs outline-none focus:border-[#6366F1]"
                      >
                        <option value="received">접수</option>
                        <option value="reviewing">검토중</option>
                        <option value="done">완료</option>
                        <option value="rejected">반려</option>
                      </select>
                    </div>

                    {/* Admin Note */}
                    <div className="space-y-2">
                      <textarea
                        value={currentNote}
                        onChange={(e) =>
                          setNoteValues((prev) => ({ ...prev, [noteKey]: e.target.value }))
                        }
                        placeholder="관리자 메모..."
                        rows={2}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs outline-none focus:border-[#6366F1] resize-none placeholder:text-[#636366]"
                      />
                      <button
                        onClick={() => handleSaveNote(item.id, currentNote)}
                        className="px-3 py-1 rounded-lg bg-[#6366F1] hover:bg-[#6366F1]/80 text-xs font-medium transition-colors"
                      >
                        저장
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
