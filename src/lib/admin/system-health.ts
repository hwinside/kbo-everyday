export type HealthLevel = "healthy" | "warning" | "critical" | "unknown";

export interface CpuCounterSnapshot {
  totalSeconds: number;
  idleSeconds: number;
  seriesFingerprint: string;
}

export interface SystemMetricSummary {
  cpuUsedPercent: number | null;
  cpuSampleSeconds: number | null;
  /** cpuUsedPercent가 기반한 rate의 종료 시각(ISO). 소비처는 이 시각으로 freshness를 판정한다. */
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

function minValue(samples: PrometheusSample[], name: string): number | null {
  const found = values(samples, name).map((sample) => sample.value);
  return found.length > 0 ? Math.min(...found) : null;
}

function percent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.min(100, Math.max(0, (numerator / denominator) * 100));
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function cpuCounterSnapshot(samples: PrometheusSample[]) {
  const cpu = values(samples, "node_cpu_seconds_total");
  if (cpu.length === 0) return null;
  const seriesFingerprint = cpu
    .map((sample) =>
      Object.entries(sample.labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join("|"),
    )
    .sort()
    .join(";");
  const totalSeconds = cpu.reduce((sum, sample) => sum + sample.value, 0);
  const idleSeconds = cpu
    .filter((sample) => sample.labels.mode === "idle")
    .reduce((sum, sample) => sum + sample.value, 0);
  return { totalSeconds, idleSeconds, seriesFingerprint };
}

/** Prometheus 텍스트에서 CPU counter 스냅샷만 추출 (cron/route 공용). */
export function extractCpuCounterSnapshot(text: string): CpuCounterSnapshot | null {
  return cpuCounterSnapshot(parsePrometheusText(text));
}

export interface StoredCpuSnapshot extends CpuCounterSnapshot {
  capturedAtMs: number;
}

export interface InstantCpuResult {
  usedPercent: number;
  windowSeconds: number;
  /** 이 rate가 끝난 시각(최신 쪽 스냅샷의 시각). freshness 판정은 이 값 기준. */
  sampleEndedAtMs: number;
}

/** freshness 상한: rate 종료 시각이 이보다 오래되면 현재값으로 표시 금지 (삼순 게이트 ≤90초). */
export const CPU_SAMPLE_MAX_AGE_SECONDS = 90;
/** delta 창 상한: cron 1분 주기 + 지터. 초과는 장기 평균이라 순간값으로 부적합. */
export const CPU_SAMPLE_MAX_WINDOW_SECONDS = 150;

/**
 * 저장 스냅샷 + 현재 counter로 즉시 CPU%를 계산한다 (삼순 2차 NO-GO 반영).
 *
 * freshness는 baseline 나이가 아니라 **rate가 끝난 시각(sampleEndedAt)** 기준이다:
 * - 현재 counter가 최신 저장분보다 전진 → (현재, stored[0]) 쌍, endedAt = now.
 * - 현재가 최신 저장분과 동일(같은 scrape tick) → (stored[0], stored[1]) 쌍,
 *   endedAt = stored[0] 시각. ← "최신 C=-31초·직전 B=-91초"에서도 C 기준 신선도로
 *   값을 유지해 주기마다 "측정 중" 공백이 생기던 blocker 1을 닫는다.
 * 공통 검증: fingerprint 일치·counter 전진(역전/리셋 거부), 창 ≤ maxWindow,
 * 나이(now-endedAt) ≤ maxAge. 미충족은 null (fail-close — counter가 멈추면
 * endedAt이 공진하므로 오래된 값이 현재값으로 위장되지 않는다).
 */
export function computeInstantCpuFromStore(
  stored: StoredCpuSnapshot[],
  current: CpuCounterSnapshot,
  nowMs: number,
  maxAgeSeconds = CPU_SAMPLE_MAX_AGE_SECONDS,
  maxWindowSeconds = CPU_SAMPLE_MAX_WINDOW_SECONDS,
): InstantCpuResult | null {
  const rows = [...stored]
    .filter((row) => Number.isFinite(row.capturedAtMs) && row.capturedAtMs <= nowMs)
    .sort((left, right) => right.capturedAtMs - left.capturedAtMs);

  const latest = rows[0];
  if (!latest) return null;

  const sameCounter = (left: CpuCounterSnapshot, right: CpuCounterSnapshot) =>
    left.seriesFingerprint === right.seriesFingerprint &&
    left.totalSeconds === right.totalSeconds &&
    left.idleSeconds === right.idleSeconds;

  const evaluate = (
    newer: CpuCounterSnapshot,
    newerAtMs: number,
    older: StoredCpuSnapshot,
  ): InstantCpuResult | null => {
    const usedPercent = cpuUsedPercentFromSnapshots(newer, older);
    if (usedPercent === null) return null; // 동일 tick·역전·fingerprint 불일치
    const windowSeconds = (newerAtMs - older.capturedAtMs) / 1_000;
    if (windowSeconds <= 0 || windowSeconds > maxWindowSeconds) return null;
    const ageSeconds = (nowMs - newerAtMs) / 1_000;
    if (ageSeconds > maxAgeSeconds) return null;
    return { usedPercent, windowSeconds, sampleEndedAtMs: newerAtMs };
  };

  if (sameCounter(current, latest)) {
    // 현재 counter가 최신 저장분과 **정확히 동일**한 경우에만 과거 쌍(latest, prev)으로 대체한다.
    // (삼순 3차 P0-1: 첫 쌍이 실패했다고 무조건 fallback 하면 current 리셋·fingerprint
    //  변경 상황에서 과거 rate를 실시간처럼 보여준다.)
    const previous = rows[1];
    if (!previous) return null;
    return evaluate(latest, latest.capturedAtMs, previous);
  }

  // current ↔ stored[0] 경로: 현재 scrape 시각을 모르므로 baseline 신선도를 별도로 제한한다.
  // (삼순 3차 P0-2: C가 정지해도 sampleEndedAt=now로 매번 찍혀 90초 freshness를
  //  150초 window까지 우회하는 경로 차단.)
  const baselineAgeSeconds = (nowMs - latest.capturedAtMs) / 1_000;
  if (baselineAgeSeconds > maxAgeSeconds) return null;
  return evaluate(current, nowMs, latest);
}

export function cpuUsedPercentFromSnapshots(
  current: CpuCounterSnapshot,
  previous: CpuCounterSnapshot,
): number | null {
  if (current.seriesFingerprint !== previous.seriesFingerprint) return null;
  const totalDelta = current.totalSeconds - previous.totalSeconds;
  const idleDelta = current.idleSeconds - previous.idleSeconds;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return percent(totalDelta - idleDelta, totalDelta);
}

function cpuUsedPercentFromCounters(
  currentSamples: PrometheusSample[],
  previousSamples: PrometheusSample[] | null,
): number | null {
  if (!previousSamples) return null;

  const current = values(currentSamples, "node_cpu_seconds_total");
  const previous = values(previousSamples, "node_cpu_seconds_total");
  if (current.length === 0 || current.length !== previous.length) return null;

  const seriesKey = (sample: PrometheusSample) =>
    Object.entries(sample.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join("|");
  const previousByKey = new Map(previous.map((sample) => [seriesKey(sample), sample.value]));
  let totalDelta = 0;
  let idleDelta = 0;
  for (const sample of current) {
    const key = seriesKey(sample);
    const before = previousByKey.get(key);
    if (before === undefined) return null;
    const delta = sample.value - before;
    if (!Number.isFinite(delta) || delta < 0) return null;
    totalDelta += delta;
    if (sample.labels.mode === "idle") idleDelta += delta;
  }
  if (totalDelta <= 0) return null;
  return percent(totalDelta - idleDelta, totalDelta);
}

export function summarizeSystemMetrics(
  text: string,
  previousText?: string,
  cpuSampleSeconds?: number,
): SystemMetricSummary {
  const samples = parsePrometheusText(text);
  const previousSamples = previousText === undefined ? null : parsePrometheusText(previousText);
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
  const load1PerCore = load1 !== null && cpuCores ? load1 / cpuCores : null;
  const cpuCounter = cpuCounterSnapshot(samples);
  const cpuUsedPercent = cpuUsedPercentFromCounters(samples, previousSamples);

  // Multiple exporters/instances may emit these gauges. Any explicit down sample
  // must fail closed instead of being hidden by a healthy sibling sample.
  const pgUpValue = minValue(samples, "pg_up");
  const poolerUpValue = minValue(samples, "pgbouncer_up");
  const postgresConnections = sumValues(samples, "pg_stat_database_num_backends");
  const poolActiveConnections = sumValues(samples, "pgbouncer_pools_client_active_connections");
  const poolWaitingConnections = sumValues(samples, "pgbouncer_pools_client_waiting_connections");
  const oldestTransactionSeconds = maxValue(samples, "pg_stat_activity_xact_runtime");

  const reasons: string[] = [];
  let level: HealthLevel = "healthy";
  let hasCritical = false;
  const warn = (reason: string) => {
    reasons.push(reason);
    if (level === "healthy") level = "warning";
  };
  const critical = (reason: string) => {
    reasons.push(reason);
    hasCritical = true;
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
  // The CPU value is a one-second point-in-time sample. Keep it informational:
  // production alerts require sustained 70%/5m or 85%/3m, so applying those
  // thresholds here would recreate "dashboard critical, no alert" contradictions.
  const missingCoreMetrics = [
    memoryUsedPercent === null ? "메모리" : null,
    diskUsedPercent === null ? "디스크" : null,
    pgUpValue === null ? "PostgreSQL" : null,
    poolerUpValue === null ? "PgBouncer" : null,
  ].filter((name): name is string => name !== null);

  if (missingCoreMetrics.length === 4) {
    reasons.push("핵심 메트릭 없음");
    if (!hasCritical) level = "unknown";
  } else if (missingCoreMetrics.length > 0) {
    warn(`핵심 메트릭 누락: ${missingCoreMetrics.join(", ")}`);
  }

  return {
    cpuUsedPercent: round(cpuUsedPercent),
    cpuSampleSeconds:
      cpuUsedPercent === null || cpuSampleSeconds === undefined || !Number.isFinite(cpuSampleSeconds)
        ? null
        : round(cpuSampleSeconds),
    cpuSampleEndedAt: null,
    cpuCounter,
    cpuCores,
    load1: round(load1),
    load1PerCore: round(load1PerCore),
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
