"use client";

import { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  Bot,
  Play,
  Database,
} from "lucide-react";
import { JOB_DEFS, fmtAge, type JobHealthLevel } from "@/lib/admin/job-health";

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

interface JobHealthRow {
  name: string;
  label: string;
  level: JobHealthLevel;
  reason: string;
  latestStatus: string | null;
  latestAt: string | null;
  dataGeneratedAt: string | null;
  dataAgeHours: number | null;
}

function HealthBadge({ level }: { level: JobHealthLevel }) {
  if (level === "healthy") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#30D158]/15 text-[#30D158]">
        <CheckCircle className="w-3 h-3" /> 정상
      </span>
    );
  }
  if (level === "partial") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FF9F0A]/15 text-[#FF9F0A]">
        <AlertTriangle className="w-3 h-3" /> 부분실패
      </span>
    );
  }
  if (level === "stale") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FF453A]/15 text-[#FF453A]">
        <AlertTriangle className="w-3 h-3" /> 정체(STALE)
      </span>
    );
  }
  if (level === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FF453A]/15 text-[#FF453A]">
        <XCircle className="w-3 h-3" /> 에러
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-white/5 text-[#636366]">
      기록 없음
    </span>
  );
}

// 히스토리 테이블(개별 실행 로그) 상태 배지 — 실행 단위라 running 포함.
function LogStatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#30D158]/15 text-[#30D158]">
        <CheckCircle className="w-3 h-3" /> 성공
      </span>
    );
  }
  if (status === "warning") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#FF9F0A]/15 text-[#FF9F0A]">
        <AlertTriangle className="w-3 h-3" /> 부분실패
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
  health,
  onRun,
  running,
}: {
  job: (typeof JOB_DEFS)[number];
  latestLog: JobLogRow | undefined;
  health: JobHealthRow | undefined;
  onRun: (jobName: string) => void;
  running: boolean;
}) {
  const lastRun = latestLog?.started_at;
  const duration = latestLog?.duration_ms;
  const level = health?.level ?? (latestLog ? "healthy" : "unknown");
  const isBad = level === "stale" || level === "error";

  return (
    <div className={`glass-card p-5 space-y-3 ${isBad ? "ring-1 ring-[#FF453A]/40" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">{job.label}</h3>
        <HealthBadge level={level} />
      </div>
      <p className="text-xs text-[#8E8E93]">{job.description}</p>

      {/* 문제 사유 */}
      {isBad && health?.reason && (
        <p className="text-xs font-medium text-[#FF453A]">⚠ {health.reason}</p>
      )}

      {/* 데이터 반영 시각 (스탯/로스터 크롤) */}
      {job.dataFreshness && (
        <div className="flex items-center gap-1.5 text-xs">
          <Database className="w-3.5 h-3.5 text-[#636366]" />
          <span className="text-[#8E8E93]">데이터 반영</span>
          <span
            className={
              health && health.dataAgeHours != null && health.dataAgeHours > 48
                ? "text-[#FF453A] font-medium"
                : "text-[#8E8E93]"
            }
          >
            {health?.dataGeneratedAt
              ? `${new Date(health.dataGeneratedAt).toLocaleDateString("ko-KR")} (${fmtAge(health.dataAgeHours)})`
              : "-"}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1.5 text-[#8E8E93]">
          <Clock className="w-3.5 h-3.5" />
          <span>{job.schedule}</span>
        </div>
        <div className="text-right text-[#8E8E93]">
          {duration != null ? `${(duration / 1000).toFixed(1)}초` : "-"}
        </div>
      </div>
      <div className="pt-2 border-t border-white/8 flex items-center justify-between">
        <span className="text-xs text-[#636366]">
          {lastRun ? `실행 ${new Date(lastRun).toLocaleString("ko-KR")}` : "실행 기록 없음"}
        </span>
        <button
          onClick={() => onRun(job.name)}
          disabled={running}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#6366F1]/15 text-[#6366F1] hover:bg-[#6366F1]/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          {running ? "실행중..." : "수동 실행"}
        </button>
      </div>
    </div>
  );
}

export default function AdminJobsPage() {
  const [logs, setLogs] = useState<JobLogRow[]>([]);
  const [health, setHealth] = useState<JobHealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ job: string; ok: boolean; message: string } | null>(null);

  const pin = () => sessionStorage.getItem("admin_pin") || "";

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs/health", { headers: { "x-admin-pin": pin() } });
      if (res.ok) {
        const json = await res.json();
        setHealth(json.jobs ?? []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    async function fetchAll() {
      try {
        const res = await fetch("/api/admin/jobs", { headers: { "x-admin-pin": pin() } });
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json();
        setLogs(json.data ?? []);
      } catch {
        setLogs([]);
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
    loadHealth();
  }, [loadHealth]);

  async function handleRunJob(jobName: string) {
    setRunningJob(jobName);
    setRunResult(null);
    try {
      const res = await fetch("/api/admin/jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin() },
        body: JSON.stringify({ job: jobName }),
      });
      const json = await res.json();
      const label = JOB_DEFS.find((j) => j.name === jobName)?.label ?? jobName;
      if (json.ok) {
        setRunResult({ job: jobName, ok: true, message: `${label} 실행 성공` });
        const logsRes = await fetch("/api/admin/jobs", { headers: { "x-admin-pin": pin() } });
        if (logsRes.ok) {
          const logsJson = await logsRes.json();
          setLogs(logsJson.data ?? []);
        }
        loadHealth();
      } else {
        setRunResult({ job: jobName, ok: false, message: json.error || json.data?.error || "실행 실패" });
      }
    } catch (e) {
      setRunResult({ job: jobName, ok: false, message: (e as Error).message });
    } finally {
      setRunningJob(null);
    }
  }

  // Build a map of latest log per job_name (소요시간/최근 실행 시각 표시용)
  const latestLogByJob = new Map<string, JobLogRow>();
  for (const log of logs) {
    const existing = latestLogByJob.get(log.job_name);
    if (!existing || new Date(log.started_at) > new Date(existing.started_at)) {
      latestLogByJob.set(log.job_name, log);
    }
  }
  const healthByJob = new Map(health.map((h) => [h.name, h]));
  const problems = health.filter((h) => h.level === "stale" || h.level === "error");

  const filteredLogs = logs.filter((log) => {
    if (filter !== "all" && log.job_name !== filter) return false;
    if (statusFilter !== "all" && log.status !== statusFilter) return false;
    return true;
  });

  const jobLabelMap = new Map(JOB_DEFS.map((j) => [j.name, j.label]));

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

      {/* 헬스 요약 배너 — 조용히 망가진 잡을 상단에 강제 노출 */}
      {problems.length > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl text-sm bg-[#FF453A]/12 text-[#FF453A] ring-1 ring-[#FF453A]/30">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">주의가 필요한 작업 {problems.length}개</p>
            <p className="mt-0.5 text-xs text-[#FF6961]">
              {problems.map((p) => `${p.label} — ${p.reason}`).join(" · ")}
            </p>
          </div>
        </div>
      )}

      {/* Run Result Toast */}
      {runResult && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium ${
            runResult.ok
              ? "bg-[#30D158]/15 text-[#30D158]"
              : "bg-[#FF453A]/15 text-[#FF453A]"
          }`}
        >
          {runResult.ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {runResult.message}
          <button
            onClick={() => setRunResult(null)}
            className="ml-auto text-xs opacity-60 hover:opacity-100"
          >
            닫기
          </button>
        </div>
      )}

      {/* Job Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {JOB_DEFS.map((j) => (
          <JobCard
            key={j.name}
            job={j}
            latestLog={latestLogByJob.get(j.name)}
            health={healthByJob.get(j.name)}
            onRun={handleRunJob}
            running={runningJob === j.name}
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
                {JOB_DEFS.map((j) => (
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
                <option value="warning">부분실패</option>
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
                    <LogStatusBadge status={log.status} />
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
                        <LogStatusBadge status={log.status} />
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
