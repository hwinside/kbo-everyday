"use client";

import { useMemo, useState } from "react";
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
import { Inbox, Eye, CheckCircle, XCircle, ChevronDown } from "lucide-react";
import { generateFeedbackItems } from "@/lib/admin/mock-data";
import type { FeedbackItem } from "@/lib/admin/types";

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

export default function AdminFeedbackPage() {
  const items = useMemo(() => generateFeedbackItems(), []);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null);

  const statusCounts = {
    received: items.filter((i) => i.status === "received").length,
    reviewing: items.filter((i) => i.status === "reviewing").length,
    done: items.filter((i) => i.status === "done").length,
    rejected: items.filter((i) => i.status === "rejected").length,
  };

  const filteredItems = typeFilter === "all" ? items : items.filter((i) => i.type === typeFilter);

  // Chart: feedback by type over last 7 days
  const chartData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dateStr = d.toISOString().slice(5, 10);
    return {
      date: dateStr,
      버그: Math.floor(Math.random() * 5),
      "데이터 수정": Math.floor(Math.random() * 3),
      "기능 제안": Math.floor(Math.random() * 4),
      콘텐츠: Math.floor(Math.random() * 2),
      기타: Math.floor(Math.random() * 2),
    };
  });

  const tooltipStyle = {
    contentStyle: {
      background: "#1C1C1F",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 12,
      fontSize: 13,
    },
    labelStyle: { color: "#8E8E93" },
  };

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
          {filteredItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setSelectedItem(selectedItem?.id === item.id ? null : item)}
              className="w-full text-left p-4 rounded-xl bg-white/3 hover:bg-white/5 transition-colors"
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

              {selectedItem?.id === item.id && (
                <div className="mt-3 pt-3 border-t border-white/8 space-y-2 text-sm">
                  {item.body && <p className="text-[#8E8E93]">{item.body}</p>}
                  {item.pageUrl && (
                    <p className="text-xs text-[#636366]">페이지: {item.pageUrl}</p>
                  )}
                  {item.deviceInfo && (
                    <p className="text-xs text-[#636366]">기기: {item.deviceInfo}</p>
                  )}
                  {item.adminNote && (
                    <div className="p-2 rounded-lg bg-[#6366F1]/10 text-xs">
                      <span className="text-[#6366F1] font-medium">관리자 메모:</span>{" "}
                      {item.adminNote}
                    </div>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
