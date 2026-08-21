import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { computeInstantCpuFromStore, summarizeSystemMetrics, type HealthLevel } from "@/lib/admin/system-health";
import { loadRecentCpuSnapshots } from "@/lib/admin/cpu-snapshot-store";

export const dynamic = "force-dynamic";

const REQUIRED_SERVICES = ["db", "rest", "auth", "storage"] as const;

type ServiceName = (typeof REQUIRED_SERVICES)[number];
type ServiceLevel = "healthy" | "critical" | "unknown";

interface ManagementHealthRow {
  name?: string;
  status?: string;
}

function projectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  return url.match(/^https:\/\/([^.]+)\./)?.[1] ?? null;
}

function combineLevel(metricLevel: HealthLevel, services: Array<{ level: ServiceLevel }>): HealthLevel {
  if (services.some((service) => service.level === "critical") || metricLevel === "critical") return "critical";
  if (metricLevel === "warning") return "warning";
  if (metricLevel === "unknown" && services.every((service) => service.level === "unknown")) return "unknown";
  if (metricLevel === "unknown" || services.some((service) => service.level === "unknown")) return "warning";
  return "healthy";
}

async function fetchMetricsText(ref: string) {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRole) throw new Error("SUPABASE_SERVICE_ROLE_KEY 미설정");
  const auth = Buffer.from(`service_role:${serviceRole}`).toString("base64");
  const response = await fetch(`https://${ref}.supabase.co/customer/v1/privileged/metrics`, {
    headers: { Authorization: `Basic ${auth}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
  return response.text();
}

/**
 * 메트릭 요약 + 저장 baseline 기반 즉시 CPU% (2026-08-21, 삼순 NO-GO 반영 v2).
 * Supabase scrape가 ~60초 주기라 브라우저 단독으로는 첫 ~60초간 "측정 중"이 된다.
 * 1분 cron이 Vercel Edge Config(감시 대상 Supabase 밖)에 적재해둔 스냅샷과의
 * delta로 첫 응답부터 값을 채운다.
 * 계약: 이 경로는 읽기 전용(write 없음)·bounded timeout. 저장소 실패는 즉시값만
 * 비활성(null)하고 기존 클라이언트 60초 경로는 그대로 동작한다.
 * freshness: rate 종료 시각(sampleEndedAt) 기준 90초 상한(computeInstantCpuFromStore) —
 * counter가 멈추거나 오래된 평균이면 현재값으로 표시하지 않는다(삼순 2차 NO-GO 반영).
 */
async function fetchMetrics(ref: string) {
  const [text, stored] = await Promise.all([fetchMetricsText(ref), loadRecentCpuSnapshots()]);
  const summary = summarizeSystemMetrics(text);
  const counter = summary.cpuCounter;
  if (!counter) return summary;
  if (summary.cpuUsedPercent === null && stored !== null) {
    const instant = computeInstantCpuFromStore(stored, counter, Date.now());
    if (instant) {
      summary.cpuUsedPercent = Math.round(instant.usedPercent * 10) / 10;
      summary.cpuSampleSeconds = Math.round(instant.windowSeconds * 10) / 10;
      summary.cpuSampleEndedAt = new Date(instant.sampleEndedAtMs).toISOString();
    }
  }
  return summary;
}

async function fetchServices(ref: string) {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!token) throw new Error("SUPABASE_MANAGEMENT_TOKEN 미설정");
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/health?services=${REQUIRED_SERVICES.join(",")}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) throw new Error(`Management Health HTTP ${response.status}`);
  const rows = (await response.json()) as ManagementHealthRow[];
  return REQUIRED_SERVICES.map((name: ServiceName) => {
    const row = rows.find((candidate) => candidate.name === name);
    const level: ServiceLevel = !row ? "unknown" : row.status === "ACTIVE_HEALTHY" ? "healthy" : "critical";
    return { name, status: row?.status ?? "UNKNOWN", level };
  });
}

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ref = projectRef();
  if (!ref) return NextResponse.json({ error: "Supabase project ref unavailable" }, { status: 503 });

  const [metricsResult, servicesResult] = await Promise.allSettled([fetchMetrics(ref), fetchServices(ref)]);
  const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
  const services =
    servicesResult.status === "fulfilled"
      ? servicesResult.value
      : REQUIRED_SERVICES.map((name) => ({ name, status: "UNKNOWN", level: "unknown" as const }));
  const sourceErrors = {
    metrics: metricsResult.status === "rejected" ? metricsResult.reason instanceof Error ? metricsResult.reason.message : "Metrics unavailable" : null,
    management: servicesResult.status === "rejected" ? servicesResult.reason instanceof Error ? servicesResult.reason.message : "Management unavailable" : null,
  };

  return NextResponse.json(
    {
      level: combineLevel(metrics?.level ?? "unknown", services),
      metrics,
      services,
      sourceErrors,
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "private, no-store", Vary: "Cookie, x-admin-pin" } },
  );
}
