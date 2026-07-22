export type HealthLevel = "healthy" | "warning" | "critical" | "unknown";

export interface SystemMetricSummary {
  cpuLoadPercent: number | null;
  cpuCores: number | null;
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
}

interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const SAMPLE_RE = new RegExp(`^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\\{([^}]*)\\})?\\s+(${NUMBER}|NaN|[+-]Inf)(?:\\s+\\d+)?$`);

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const labels: Record<string, string> = {};
  const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\\\.|[^"\\\\])*)"/g;
  for (const match of raw.matchAll(labelRe)) {
    labels[match[1]] = match[2]
      .replace(/\\\\n/g, "\n")
      .replace(/\\\\"/g, '"')
      .replace(/\\\\\\\\/g, "\\");
  }
  return labels;
}

export function parsePrometheusText(text: string): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(SAMPLE_RE);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return samples;
}

function values(samples: PrometheusSample[], name: string): PrometheusSample[] {
  return samples.filter((sample) => sample.name === name);
}

function firstValue(samples: PrometheusSample[], name: string): number | null {
  return values(samples, name)[0]?.value ?? null;
}

function sumValues(samples: PrometheusSample[], name: string): number | null {
  const found = values(samples, name);
  return found.length > 0 ? found.reduce((sum, sample) => sum + sample.value, 0) : null;
}

function maxValue(samples: PrometheusSample[], name: string): number | null {
  const found = values(samples, name).map((sample) => sample.value);
  return found.length > 0 ? Math.max(...found) : null;
}

function percent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.min(100, Math.max(0, (numerator / denominator) * 100));
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function summarizeSystemMetrics(text: string): SystemMetricSummary {
  const samples = parsePrometheusText(text);
  const totalMemory = firstValue(samples, "node_memory_MemTotal_bytes");
  const freeMemory = firstValue(samples, "node_memory_MemFree_bytes");
  const buffers = firstValue(samples, "node_memory_Buffers_bytes") ?? 0;
  const cached = firstValue(samples, "node_memory_Cached_bytes") ?? 0;
  const memoryUsedPercent =
    totalMemory !== null && freeMemory !== null
      ? percent(totalMemory - freeMemory - buffers - cached, totalMemory)
      : null;

  const rootAvailable = values(samples, "node_filesystem_avail_bytes").find(
    (sample) => sample.labels.mountpoint === "/" && sample.labels.fstype !== "rootfs",
  );
  const rootSize = values(samples, "node_filesystem_size_bytes").find(
    (sample) =>
      sample.labels.mountpoint === "/" &&
      sample.labels.fstype !== "rootfs" &&
      (!rootAvailable || sample.labels.device === rootAvailable.labels.device),
  );
  const diskUsedPercent =
    rootAvailable && rootSize ? percent(rootSize.value - rootAvailable.value, rootSize.value) : null;

  const cpuCoresSet = new Set(
    values(samples, "node_cpu_seconds_total")
      .map((sample) => sample.labels.cpu)
      .filter(Boolean),
  );
  const cpuCores = cpuCoresSet.size || null;
  const load1 = firstValue(samples, "node_load1");
  const cpuLoadPercent = load1 !== null && cpuCores ? percent(load1, cpuCores) : null;

  const pgUpValue = maxValue(samples, "pg_up");
  const poolerUpValue = maxValue(samples, "pgbouncer_up");
  const postgresConnections = sumValues(samples, "pg_stat_database_num_backends");
  const poolActiveConnections = sumValues(samples, "pgbouncer_pools_client_active_connections");
  const poolWaitingConnections = sumValues(samples, "pgbouncer_pools_client_waiting_connections");
  const oldestTransactionSeconds = maxValue(samples, "pg_stat_activity_xact_runtime");

  const reasons: string[] = [];
  let level: HealthLevel = "healthy";
  const warn = (reason: string) => {
    reasons.push(reason);
    if (level === "healthy") level = "warning";
  };
  const critical = (reason: string) => {
    reasons.push(reason);
    level = "critical";
  };

  if (pgUpValue !== null && pgUpValue < 1) critical("PostgreSQL 응답 없음");
  if (poolerUpValue !== null && poolerUpValue < 1) critical("PgBouncer 응답 없음");
  if (poolWaitingConnections !== null && poolWaitingConnections > 0) {
    critical(`DB 연결 대기 ${Math.round(poolWaitingConnections)}건`);
  }
  if (oldestTransactionSeconds !== null && oldestTransactionSeconds >= 60) {
    critical(`장기 트랜잭션 ${Math.round(oldestTransactionSeconds)}초`);
  }
  if (memoryUsedPercent !== null) {
    if (memoryUsedPercent >= 85) critical(`메모리 ${round(memoryUsedPercent)}%`);
    else if (memoryUsedPercent >= 75) warn(`메모리 ${round(memoryUsedPercent)}%`);
  }
  if (diskUsedPercent !== null) {
    if (diskUsedPercent >= 85) critical(`디스크 ${round(diskUsedPercent)}%`);
    else if (diskUsedPercent >= 75) warn(`디스크 ${round(diskUsedPercent)}%`);
  }
  if (cpuLoadPercent !== null) {
    if (cpuLoadPercent >= 85) critical(`CPU 부하 ${round(cpuLoadPercent)}%`);
    else if (cpuLoadPercent >= 70) warn(`CPU 부하 ${round(cpuLoadPercent)}%`);
  }

  if (samples.length === 0) {
    level = "unknown";
    reasons.push("메트릭 없음");
  }

  return {
    cpuLoadPercent: round(cpuLoadPercent),
    cpuCores,
    memoryUsedPercent: round(memoryUsedPercent),
    diskUsedPercent: round(diskUsedPercent),
    postgresUp: pgUpValue === null ? null : pgUpValue >= 1,
    poolerUp: poolerUpValue === null ? null : poolerUpValue >= 1,
    postgresConnections: round(postgresConnections),
    poolActiveConnections: round(poolActiveConnections),
    poolWaitingConnections: round(poolWaitingConnections),
    oldestTransactionSeconds: round(oldestTransactionSeconds),
    level,
    reasons,
  };
}
