import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { summarizeSystemMetrics, type HealthLevel } from "@/lib/admin/system-health";

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

async function fetchMetrics(ref: string) {
  return summarizeSystemMetrics(await fetchMetricsText(ref));
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
