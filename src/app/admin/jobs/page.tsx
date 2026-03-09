"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  Play,
  ChevronDown,
} from "lucide-react";
import { generateJobInfos, generateJobLogs } from "@/lib/admin/mock-data";
import type { JobInfo, JobLog } from "@/lib/admin/types";

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

function JobCard({ job }: { job: JobInfo }) {
  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex items-start justify-between">
        <h3 className="font-semibold">{job.label}</h3>
        <JobStatusBadge status={job.status} />
      </div>
      <p className="text-xs text-[#8E8E93]">{job.description}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-[#8E8E93]">
          <Clock className="w-3.5 h-3.5" />
          <span>{job.schedule}</span>
        </div>
        <div className="text-right text-[#8E8E93]">
          {(job.duration / 1000).toFixed(1)}초
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-white/8">
        <span className="text-xs text-[#636366]">
          {new Date(job.lastRun).toLocaleString("ko-KR")}
        </span>
        <button className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#6366F1]/15 text-[#6366F1] text-xs font-medium hover:bg-[#6366F1]/25 transition-colors">
          <Play className="w-3 h-3" /> 수동 실행
        </button>
      </div>
    </div>
  );
}

export default function AdminJobsPage() {
  const jobs = useMemo(() => generateJobInfos(), []);
  const allLogs = useMemo(() => generateJobLogs(), []);
  const [filter, setFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const filteredLogs = allLogs.filter((log) => {
    if (filter !== "all" && log.jobName !== filter) return false;
    if (statusFilter !== "all" && log.status !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">크롤러 / 배치 작업</h1>

      {/* Job Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {jobs.map((j) => (
          <JobCard key={j.name} job={j} />
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
                {jobs.map((j) => (
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

        <div className="overflow-x-auto">
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
                  <td className="py-2.5 font-medium">{log.jobName}</td>
                  <td className="py-2.5">
                    <JobStatusBadge status={log.status} />
                  </td>
                  <td className="py-2.5 text-[#8E8E93]">
                    {new Date(log.startedAt).toLocaleString("ko-KR")}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-[#8E8E93]">
                    {log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}초` : "-"}
                  </td>
                  <td className="py-2.5 text-[#8E8E93] max-w-[200px] truncate">
                    {log.errorMessage ? (
                      <span className="text-[#FF453A]">{log.errorMessage}</span>
                    ) : (
                      log.resultSummary || "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
