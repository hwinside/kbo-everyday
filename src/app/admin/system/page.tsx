"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Globe,
  Gauge,
  Database,
  Rocket,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
} from "lucide-react";

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

/* ── types ───────────────────────────────────────────── */

interface Deployment {
  uid: string;
  state: string;
  url: string;
  createdAt: number;
  meta: { commit: string; branch: string; author: string };
}

interface SupabaseUsage {
  dbSize: string | null;
  tables: Record<string, number>;
}

/* ── empty state ─────────────────────────────────────── */

function EmptyState({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="glass-card p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon className="w-5 h-5 text-[#6366F1]" />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
        <Icon className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">데이터 없음</p>
      </div>
    </div>
  );
}

/* ── deploy status helpers ───────────────────────────── */

function deployStatusIcon(state: string) {
  if (state === "READY") return <CheckCircle className="w-4 h-4 text-[#30D158]" />;
  if (state === "ERROR") return <XCircle className="w-4 h-4 text-[#FF453A]" />;
  return <Clock className="w-4 h-4 text-[#FFD60A]" />;
}

function deployStatusLabel(state: string) {
  if (state === "READY") return "성공";
  if (state === "ERROR") return "실패";
  if (state === "BUILDING" || state === "INITIALIZING") return "빌드 중";
  if (state === "QUEUED") return "대기";
  if (state === "CANCELED") return "취소";
  return state;
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return `${d}일 전`;
}

/* ── page component ──────────────────────────────────── */

export default function AdminSystemPage() {
  const [loading, setLoading] = useState(true);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [supabaseUsage, setSupabaseUsage] = useState<SupabaseUsage | null>(null);
  const [apiUsage, setApiUsage] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const errs: Record<string, string> = {};

    Promise.all([
      apiFetch<{ deployments: Deployment[] }>("/api/admin/vercel?type=deployments")
        .then((r) => setDeployments(r.deployments ?? []))
        .catch((e) => { errs.deploy = e.message; }),
      apiFetch<SupabaseUsage>("/api/admin/supabase-usage")
        .then((r) => setSupabaseUsage(r))
        .catch((e) => { errs.supabase = e.message; }),
      apiFetch("/api/admin/vercel?type=usage")
        .then((r) => setApiUsage(r))
        .catch((e) => { errs.api = e.message; }),
    ]).finally(() => {
      setErrors(errs);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-[#636366]" />
      </div>
    );
  }

  /* ── API usage chart data ── */
  const apiUsageData = (() => {
    if (!apiUsage || typeof apiUsage !== "object") return [];
    const u = apiUsage as Record<string, unknown>;
    if (u.fallback) return [];
    if (Array.isArray(u.usage)) {
      return (u.usage as { date?: string; requests?: number }[]).map((d) => ({
        date: d.date ?? "",
        requests: d.requests ?? 0,
      }));
    }
    return [];
  })();

  /* ── supabase table data for chart ── */
  const tableData = supabaseUsage
    ? Object.entries(supabaseUsage.tables).map(([name, count]) => ({
        name: name.replace(/_/g, " "),
        rows: count,
      }))
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">시스템 모니터링</h1>

      {/* API Usage */}
      {apiUsageData.length > 0 ? (
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">API 호출량 (7일)</h2>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={apiUsageData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" stroke="#636366" fontSize={12} />
              <YAxis stroke="#636366" fontSize={12} />
              <Tooltip {...chartTooltipStyle} />
              <Bar dataKey="requests" fill="#6366F1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState icon={Globe} title="API 호출량 (일간)" />
      )}

      {/* Performance — keep as empty (no data source yet) */}
      <EmptyState icon={Gauge} title="성능 모니터링 (Web Vitals)" />

      {/* Supabase Usage */}
      {supabaseUsage && !errors.supabase ? (
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Database className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">Supabase 사용량</h2>
          </div>

          {/* DB Size */}
          {supabaseUsage.dbSize && (
            <div className="mb-4 p-3 rounded-xl bg-white/5">
              <p className="text-sm text-[#8E8E93]">DB 크기</p>
              <p className="text-xl font-bold tabular-nums">{supabaseUsage.dbSize}</p>
            </div>
          )}

          {/* Table row counts */}
          {tableData.length > 0 && (
            <div>
              <p className="text-sm text-[#8E8E93] mb-3">테이블별 행 수</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={tableData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" stroke="#636366" fontSize={12} />
                  <YAxis dataKey="name" type="category" stroke="#636366" fontSize={11} width={100} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar dataKey="rows" fill="#30D158" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ) : (
        <EmptyState icon={Database} title="Supabase 사용량" />
      )}

      {/* Deploy History */}
      {deployments.length > 0 ? (
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Rocket className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">배포 히스토리</h2>
          </div>
          <div className="space-y-3">
            {deployments.map((d) => (
              <div
                key={d.uid}
                className="flex items-start gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/[0.07] transition-colors"
              >
                {/* Status icon */}
                <div className="mt-0.5 shrink-0">{deployStatusIcon(d.state)}</div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {d.meta.commit || "배포"}
                  </p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-[#8E8E93]">
                    <span>{deployStatusLabel(d.state)}</span>
                    <span>·</span>
                    <span>{d.meta.branch || "main"}</span>
                    <span>·</span>
                    <span>{timeAgo(d.createdAt)}</span>
                    {d.meta.author && (
                      <>
                        <span>·</span>
                        <span>{d.meta.author}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Link */}
                {d.url && (
                  <a
                    href={`https://${d.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[#636366] hover:text-white transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState icon={Rocket} title="배포 히스토리" />
      )}
    </div>
  );
}
