"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CPU_SAMPLE_MAX_AGE_SECONDS,
  CPU_SAMPLE_MAX_WINDOW_SECONDS,
  cpuUsedPercentFromSnapshots,
  type CpuCounterSnapshot,
} from "@/lib/admin/system-health";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Timer,
  XCircle,
} from "lucide-react";

type HealthLevel = "healthy" | "warning" | "critical" | "unknown";

interface SystemHealthResponse {
  level: HealthLevel;
  metrics: {
    cpuUsedPercent: number | null;
    cpuSampleSeconds: number | null;
    cpuSampleEndedAt: string | null;
    cpuCounter: CpuCounterSnapshot | null;
    cpuCores: number | null;
    load1: number | null;
    load1PerCore: number | null;
    memoryUsedPercent: number | null;
    diskUsedPercent: number | null;
    postgresUp: boolean | null;
    poolerUp: boolean | null;
    postgresConnections: number | null;
    poolActiveConnections: number | null;
    poolWaitingConnections: number | null;
    oldestTransactionSeconds: number | null;
    level: HealthLevel;
    reasons: string[];
  } | null;
  services: Array<{
    name: "db" | "rest" | "auth" | "storage";
    status: string;
    level: "healthy" | "critical" | "unknown";
  }>;
  sourceErrors: { metrics: string | null; management: string | null };
  checkedAt: string;
}

const SERVICE_LABELS = {
  db: "Database",
  rest: "REST API",
  auth: "Auth",
  storage: "Storage",
} as const;

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

// 마지막 유효 CPU값 보존 (삼순 게이트: 소스 실패 시 last-good+시각 표시, 현재값 위장 금지)
const CPU_LAST_GOOD_KEY = "admin_cpu_last_good";
const CPU_LAST_GOOD_TTL_MS = 30 * 60_000;

interface CpuLastGood {
  percent: number;
  atMs: number;
}

function readCpuLastGood(): CpuLastGood | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CPU_LAST_GOOD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CpuLastGood>;
    if (typeof parsed.percent !== "number" || typeof parsed.atMs !== "number") return null;
    if (!Number.isFinite(parsed.percent) || !Number.isFinite(parsed.atMs)) return null;
    if (Date.now() - parsed.atMs > CPU_LAST_GOOD_TTL_MS) return null; // TTL 초과 = 미표시
    return { percent: parsed.percent, atMs: parsed.atMs };
  } catch {
    return null;
  }
}

function writeCpuLastGood(entry: CpuLastGood): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CPU_LAST_GOOD_KEY, JSON.stringify(entry));
  } catch {
    // 저장 불가는 기능 비활성일 뿐
  }
}

function levelStyle(level: HealthLevel) {
  if (level === "healthy") return "text-[#30D158] bg-[#30D158]/10 border-[#30D158]/20";
  if (level === "warning") return "text-[#FFD60A] bg-[#FFD60A]/10 border-[#FFD60A]/20";
  if (level === "critical") return "text-[#FF453A] bg-[#FF453A]/10 border-[#FF453A]/20";
  return "text-[#8E8E93] bg-white/5 border-white/10";
}

function levelLabel(level: HealthLevel) {
  if (level === "healthy") return "정상";
  if (level === "warning") return "주의";
  if (level === "critical") return "긴급";
  return "확인 불가";
}

function formatAge(checkedAt: string): string {
  const ageMs = Math.max(0, Date.now() - Date.parse(checkedAt));
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "방금 전";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 ${hours % 24}시간 전`;
}

function LevelIcon({ level, className = "w-4 h-4" }: { level: HealthLevel; className?: string }) {
  if (level === "healthy") return <CheckCircle2 className={className} />;
  if (level === "warning") return <AlertTriangle className={className} />;
  if (level === "critical") return <XCircle className={className} />;
  return <Activity className={className} />;
}

function percentLevel(value: number | null, warning: number, critical: number): HealthLevel {
  if (value === null) return "unknown";
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return "healthy";
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  level,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  level: HealthLevel | null;
}) {
  return (
    <div className="rounded-xl bg-white/[0.04] border border-white/[0.06] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[#8E8E93]">
          <Icon className="w-4 h-4" />
          <span className="text-xs">{label}</span>
        </div>
        {level === null ? (
          <span className="text-[11px] text-[#636366]">순간값</span>
        ) : (
          <span className={`inline-flex items-center gap-1 text-[11px] ${level === "unknown" ? "text-[#636366]" : levelStyle(level).split(" ")[0]}`}>
            <LevelIcon level={level} className="w-3.5 h-3.5" />
            {levelLabel(level)}
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-[#636366]">{detail}</p>
    </div>
  );
}

export default function SystemHealthPanel() {
  const [data, setData] = useState<SystemHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cpuBaseline = useRef<{ counter: CpuCounterSnapshot; checkedAt: string } | null>(null);
  // sampleEndedAtMs = 이 rate가 끝난 시각. 재사용 시에도 갱신하지 않고 그 시각으로
  // freshness를 판정한다(삼순 2차 blocker 2: counter 정지 시 오래된 값이 순간값으로 위장되는 경로 차단).
  const lastCpuSample = useRef<{ usedPercent: number; sampleSeconds: number; sampleEndedAtMs: number } | null>(null);
  const latestRequest = useRef(0);
  const latestAppliedAt = useRef(Number.NEGATIVE_INFINITY);

  const load = useCallback(async (background = false) => {
    const requestId = ++latestRequest.current;
    if (background) setRefreshing(true);
    try {
      const response = await fetch("/api/admin/system-health", {
        headers: { "x-admin-pin": getPin() },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`서버 상태 조회 실패 (${response.status})`);
      const next = (await response.json()) as SystemHealthResponse;
      const checkedAtMs = Date.parse(next.checkedAt);
      if (requestId !== latestRequest.current || checkedAtMs < latestAppliedAt.current) return;
      latestAppliedAt.current = checkedAtMs;
      const counter = next.metrics?.cpuCounter ?? null;
      if (counter && next.metrics) {
        const previous = cpuBaseline.current;
        if (previous) {
          const sameSnapshot =
            counter.seriesFingerprint === previous.counter.seriesFingerprint &&
            counter.totalSeconds === previous.counter.totalSeconds &&
            counter.idleSeconds === previous.counter.idleSeconds;
          const used = cpuUsedPercentFromSnapshots(counter, previous.counter);
          const seconds = (Date.parse(next.checkedAt) - Date.parse(previous.checkedAt)) / 1_000;
          const serverFilled =
            next.metrics.cpuUsedPercent !== null && next.metrics.cpuUsedPercent !== undefined;
          if (used !== null && seconds > 0 && seconds <= CPU_SAMPLE_MAX_WINDOW_SECONDS) {
            const sample = {
              usedPercent: Math.round(used * 10) / 10,
              sampleSeconds: Math.round(seconds * 10) / 10,
              sampleEndedAtMs: checkedAtMs,
            };
            next.metrics.cpuUsedPercent = sample.usedPercent;
            next.metrics.cpuSampleSeconds = sample.sampleSeconds;
            next.metrics.cpuSampleEndedAt = next.checkedAt;
            lastCpuSample.current = sample;
            cpuBaseline.current = { counter, checkedAt: next.checkedAt };
          } else if (sameSnapshot && lastCpuSample.current && !serverFilled) {
            // 동일 scrape tick 재사용 — 단, rate 종료 시각 기준 90초까지만.
            const ageSeconds = (checkedAtMs - lastCpuSample.current.sampleEndedAtMs) / 1_000;
            if (ageSeconds <= CPU_SAMPLE_MAX_AGE_SECONDS) {
              next.metrics.cpuUsedPercent = lastCpuSample.current.usedPercent;
              next.metrics.cpuSampleSeconds = lastCpuSample.current.sampleSeconds;
              next.metrics.cpuSampleEndedAt = new Date(lastCpuSample.current.sampleEndedAtMs).toISOString();
            } else {
              lastCpuSample.current = null; // 정지된 counter를 현재값으로 위장하지 않는다
            }
          } else if (!sameSnapshot) {
            cpuBaseline.current = { counter, checkedAt: next.checkedAt };
            lastCpuSample.current = null;
          }
        } else {
          cpuBaseline.current = { counter, checkedAt: next.checkedAt };
        }
        // 서버가 즉시값을 채운 경우에도 재사용 기준을 그 rate 종료 시각로 맞춘다.
        const serverEndedAtMs = next.metrics.cpuSampleEndedAt ? Date.parse(next.metrics.cpuSampleEndedAt) : NaN;
        if (
          next.metrics.cpuUsedPercent !== null &&
          next.metrics.cpuUsedPercent !== undefined &&
          Number.isFinite(serverEndedAtMs) &&
          (!lastCpuSample.current || lastCpuSample.current.sampleEndedAtMs < serverEndedAtMs)
        ) {
          lastCpuSample.current = {
            usedPercent: next.metrics.cpuUsedPercent,
            sampleSeconds: next.metrics.cpuSampleSeconds ?? 0,
            sampleEndedAtMs: serverEndedAtMs,
          };
        }
      }
      if (next.metrics && next.metrics.cpuUsedPercent !== null && next.metrics.cpuUsedPercent !== undefined) {
        // last-good 시각은 응답 시각(checkedAt)이 아니라 **rate 종료 시각**으로 고정한다.
        const endedAtMs = next.metrics.cpuSampleEndedAt ? Date.parse(next.metrics.cpuSampleEndedAt) : NaN;
        if (Number.isFinite(endedAtMs)) {
          writeCpuLastGood({ percent: next.metrics.cpuUsedPercent, atMs: endedAtMs });
        }
      }
      setData(next);
      setError(null);
    } catch (loadError) {
      if (requestId === latestRequest.current) {
        setError(loadError instanceof Error ? loadError.message : "서버 상태 조회 실패");
      }
    } finally {
      if (requestId === latestRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(true), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="glass-card p-8 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[#636366]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-card p-5 border border-[#FF453A]/20">
        <div className="flex items-center gap-2 text-[#FF453A]">
          <XCircle className="w-5 h-5" />
          <p className="font-semibold">서버·DB Health 조회 실패</p>
        </div>
        <p className="mt-2 text-sm text-[#8E8E93]">{error}</p>
        <button onClick={() => void load()} className="mt-4 text-sm text-[#818CF8]">다시 조회</button>
      </div>
    );
  }

  const metrics = data.metrics;
  const waiting = metrics?.poolWaitingConnections ?? null;
  const transaction = metrics?.oldestTransactionSeconds ?? null;
  const sourceWarnings = Object.entries(data.sourceErrors).filter(([, value]) => value);
  const checkedAtMs = Date.parse(data.checkedAt);
  const aged = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > 120_000;
  const stale = Boolean(error) || aged;
  const displayLevel: HealthLevel = stale && data.level === "healthy" ? "warning" : data.level;

  return (
    <section className="glass-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-[#6366F1]" />
            <h2 className="text-lg font-semibold">서버·DB Health</h2>
            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs font-medium ${levelStyle(displayLevel)}`}>
              <LevelIcon level={displayLevel} className="w-3.5 h-3.5" />
              {levelLabel(displayLevel)}
            </span>
          </div>
          <p className="mt-1 text-xs text-[#636366]">
            Supabase 공식 Metrics · 마지막 성공 {new Date(data.checkedAt).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })} ({formatAge(data.checkedAt)})
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="p-2 rounded-lg bg-white/5 text-[#8E8E93] hover:text-white disabled:opacity-50"
          aria-label="서버 상태 새로고침"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {(() => {
          const current = metrics?.cpuUsedPercent;
          if (current !== null && current !== undefined) {
            return (
              <MetricCard
                icon={Cpu}
                label="CPU 사용률"
                value={`${current}%`}
                detail={metrics?.cpuSampleSeconds ? `${metrics.cpuSampleSeconds}초 실측 · 알림 70% 5분 / 85% 3분` : "실측치"}
                level={null}
              />
            );
          }
          const lastGood = readCpuLastGood();
          if (lastGood) {
            const ageMinutes = Math.max(1, Math.round((Date.now() - lastGood.atMs) / 60_000));
            return (
              <MetricCard
                icon={Cpu}
                label="CPU 사용률"
                value={`직전 ${lastGood.percent}%`}
                detail={`직전 측정 ${ageMinutes}분 전 · 실시간 아님 · 새 실측 대기 중`}
                level={"unknown"}
              />
            );
          }
          return (
            <MetricCard
              icon={Cpu}
              label="CPU 사용률"
              value="측정 중"
              detail="첫 샘플 수집 중 · 약 1~2분 후 표시"
              level={null}
            />
          );
        })()}
        <MetricCard
          icon={Activity}
          label="시스템 Load (1분)"
          value={metrics?.load1 === null || metrics?.load1 === undefined ? "—" : `${metrics.load1}`}
          detail={metrics?.cpuCores ? `${metrics.cpuCores} cores · 코어당 ${metrics.load1PerCore ?? "—"} · CPU와 별도` : "코어 정보 없음"}
          level={null}
        />
        <MetricCard
          icon={MemoryStick}
          label="메모리 사용"
          value={metrics?.memoryUsedPercent === null || metrics?.memoryUsedPercent === undefined ? "—" : `${metrics.memoryUsedPercent}%`}
          detail="cache·buffer 제외"
          level={percentLevel(metrics?.memoryUsedPercent ?? null, 75, 85)}
        />
        <MetricCard
          icon={HardDrive}
          label="Root 디스크 사용"
          value={metrics?.diskUsedPercent === null || metrics?.diskUsedPercent === undefined ? "—" : `${metrics.diskUsedPercent}%`}
          detail="경고 75% · 긴급 85%"
          level={percentLevel(metrics?.diskUsedPercent ?? null, 75, 85)}
        />
        <MetricCard
          icon={Database}
          label="PostgreSQL 연결"
          value={metrics?.postgresConnections === null || metrics?.postgresConnections === undefined ? "—" : `${metrics.postgresConnections}`}
          detail={`Pool 활성 ${metrics?.poolActiveConnections ?? "—"}`}
          level={metrics?.postgresUp === null || metrics?.postgresUp === undefined ? "unknown" : metrics.postgresUp ? "healthy" : "critical"}
        />
        <MetricCard
          icon={Network}
          label="Pool 연결 대기"
          value={waiting === null ? "—" : `${waiting}`}
          detail="1건 이상 즉시 긴급"
          level={waiting === null ? "unknown" : waiting > 0 ? "critical" : "healthy"}
        />
        <MetricCard
          icon={Timer}
          label="최장 트랜잭션"
          value={transaction === null ? "—" : `${transaction}초`}
          detail="60초 이상 긴급"
          level={transaction === null ? "unknown" : transaction >= 60 ? "critical" : "healthy"}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {data.services.map((service) => (
          <div key={service.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2">
            <LevelIcon level={service.level} className={`w-4 h-4 ${levelStyle(service.level).split(" ")[0]}`} />
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{SERVICE_LABELS[service.name]}</p>
              <p className="text-[10px] text-[#636366]">{levelLabel(service.level)}</p>
            </div>
          </div>
        ))}
      </div>

      {metrics?.reasons && metrics.reasons.length > 0 && (
        <div className="mt-4 rounded-lg bg-[#FFD60A]/5 border border-[#FFD60A]/10 px-3 py-2 text-xs text-[#FFD60A]">
          {metrics.reasons.join(" · ")}
        </div>
      )}
      {stale && (
        <div role="alert" className="mt-4 rounded-lg bg-[#FFD60A]/5 border border-[#FFD60A]/10 px-3 py-2 text-xs text-[#FFD60A]">
          {error
            ? `최근 갱신 실패 · 이전 정상값일 수 있음: ${error}`
            : `데이터 지연 · 마지막 성공 ${formatAge(data.checkedAt)}`}
        </div>
      )}
      {sourceWarnings.length > 0 && (
        <div className="mt-3 text-xs text-[#8E8E93]">
          일부 소스 지연: {sourceWarnings.map(([source]) => source === "metrics" ? "Metrics" : "Management").join(", ")}
        </div>
      )}
    </section>
  );
}
