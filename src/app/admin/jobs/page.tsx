"use client";

import { useState, useEffect } from "react";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  Bot,
} from "lucide-react";

interface JobLogRow {
  id: number;
  job_name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result_summary: string | null;
  error_message: string | null;
}

const JOB_INFOS = [
  { name: "youtube-highlights", label: "유튜브 하이라이트", schedule: "매 4시간", description: "구단별 유튜브 하이라이트 영상 수집" },
  { name: "roster-update", label: "로스터 업데이트", schedule: "매일 06:00", description: "KBO 기록 페이지에서 선수 목록 수집" },
  { name: "stats-update", label: "선수 스탯 업데이트", schedule: "매일 06:00", description: "KBO 타자/투수 스탯 크롤링 → Supabase 저장" },
  { name: "photos-check", label: "선수 사진 모니터링", schedule: "매주 일 06:00", description: "KBO CDN 선수 사진 존재 여부 확인" },
];

function JobStatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#30D158]/15 text-[#30D158]">
        <CheckCircle className="w-3 h-3" /> 성공
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FF453A]/15 text-[#FF453A]">
        <XCircle className="w-3 h-3" /> 에러
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FFD60A]/15 text-[#FFD60A]">
      <Loader2 className="w-3 h-3 animate-spin" /> 실행중
    </span>
  );
}

function JobCard({
  job,
  latestLog,
}: {
  job: (typeof JOB_INFOS)[number];
  latestLog: JobLogRow | undefined;
}) {
  const status = latestLog?.status ?? "unknown";
  const lastRun = latestLog?.started_at;
  const duration = latestLog?.duration_ms;

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start justify-between">
        <h3 className="font-semibold">{job.label}</h3>
        {latestLog ? (
          <JobStatusBadge status={status} />
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-white/5 text-[#636366]">
            기록 없음
          </span>
        )}
      </div>
      <p className="text-xs text-[#8E8E93]">{job.description}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-[#8E8E93]">
          <Clock className="w-3.5 h-3.5" />
          <span>{job.schedule}</span>
        </div>
        <div className="text-right text-[#8E8E93]">
          {duration != null ? `${(duration / 1000).toFixed(1)}초` : "-"}
        </div>
      </div>
      <div className="pt-2 border-t border-white/8">
        <span className="text-xs text-[#636366]">
          {lastRun
            ? new Date(lastRun).toLocaleString("ko-KR")
            : "실행 기록 없음"}
        </span>
      </div>
    </div>
  );
}

export default function AdminJobsPage() {
  const [logs, setLogs] = useState<JobLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    async function fetchLogs() {
      try {
        const pin = sessionStorage.getItem("admin_pin") || "";
        const res = await fetch("/api/admin/jobs", {
          headers: { "x-admin-pin": pin },
        });
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json();
        setLogs(json.data ?? []);
      } catch {
        setLogs([]);
      } finally {
        setLoading(false);
      }
    }
    fetchLogs();
  }, []);

  // Build a map of latest log per job_name
  const latestLogByJob = new Map<string, JobLogRow>();
  for (const log of logs) {
    const existing = latestLogByJob.get(log.job_name);
    if (!existing || new Date(log.started_at) > new Date(existing.started_at)) {
      latestLogByJob.set(log.job_name, log);
    }
  }

  const filteredLogs = logs.filter((log) => {
    if (filter !== "all" && log.job_name !== filter) return false;
    if (statusFilter !== "all" && log.status !== statusFilter) return false;
    return true;
  });

  const jobLabelMap = new Map(JOB_INFOS.map((j) => [j.name, j.label]));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 animate-spin text-[#6366F1]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">크롤러 / 배치 작업</h1>

      {/* Job Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {JOB_INFOS.map((j) => (
          <JobCard
            key={j.name}
            job={j}
            latestLog={latestLogByJob.get(j.name)}
          />
        ))}
      </div>

      {/* Job History */}
      <div className="glass-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold">실행 히스토리</h2>
          <div className="flex gap-2">
            <div className="relative">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="appearance-none bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 pr-8 text-sm outline-none focus:border-[#6366F1]"
              >
                <option value="all">전체 작업</option>
                {JOB_INFOS.map((j) => (
                  <option key={j.name} value={j.name}>
                    {j.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[#636366] pointer-events-none" />
            </div>
            <div className="relative">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="appearance-none bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 pr-8 text-sm outline-none focus:border-[#6366F1]"
              >
                <option value="all">전체 상태</option>
                <option value="success">성공</option>
                <option value="error">에러</option>
                <option value="running">실행중</option>
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[#636366] pointer-events-none" />
            </div>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#636366]">
            <Bot className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">등록된 작업 없음</p>
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {filteredLogs.slice(0, 50).map((log) => (
                <div key={log.id} className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium leading-snug">
                        {jobLabelMap.get(log.job_name) ?? log.job_name}
                      </p>
                      <p className="mt-1 text-xs text-[#8E8E93]">
                        {new Date(log.started_at).toLocaleString("ko-KR")}
                      </p>
                    </div>
                    <JobStatusBadge status={log.status} />
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-[#636366] mb-1">소요시간</p>
                      <p className="tabular-nums text-[#E5E5EA]">
                        {log.duration_ms != null
                          ? `${(log.duration_ms / 1000).toFixed(1)}초`
                          : "-"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[#636366] mb-1">결과</p>
                      <p className={`text-sm leading-snug break-words ${log.error_message ? "text-[#FF453A]" : "text-[#8E8E93]"}`}>
                        {log.error_message || log.result_summary || "-"}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8">
                    <th className="text-left py-2 text-[#8E8E93] font-medium">작업</th>
                    <th className="text-left py-2 text-[#8E8E93] font-medium">상태</th>
                    <th className="text-left py-2 text-[#8E8E93] font-medium">시작 시간</th>
                    <th className="text-right py-2 text-[#8E8E93] font-medium">소요시간</th>
                    <th className="text-left py-2 text-[#8E8E93] font-medium">결과</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.slice(0, 50).map((log) => (
                    <tr key={log.id} className="border-b border-white/5">
                      <td className="py-2.5 font-medium">
                        {jobLabelMap.get(log.job_name) ?? log.job_name}
                      </td>
                      <td className="py-2.5">
                        <JobStatusBadge status={log.status} />
                      </td>
                      <td className="py-2.5 text-[#8E8E93]">
                        {new Date(log.started_at).toLocaleString("ko-KR")}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-[#8E8E93]">
                        {log.duration_ms != null
                          ? `${(log.duration_ms / 1000).toFixed(1)}초`
                          : "-"}
                      </td>
                      <td className="py-2.5 text-[#8E8E93] max-w-[200px] truncate">
                        {log.error_message ? (
                          <span className="text-[#FF453A]">{log.error_message}</span>
                        ) : (
                          log.result_summary || "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
