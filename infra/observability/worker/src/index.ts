interface KvListResult {
  keys: Array<{ name: string }>;
}

interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options?: { prefix?: string }): Promise<KvListResult>;
}

interface Env {
  INCIDENTS: KvStore;
  GRAFANA_HMAC_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  PUBLIC_BASE_URL: string;
  ACK_LINK_SECRET: string;
}

interface GrafanaAlert {
  status: "firing" | "resolved";
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  dashboardURL?: string;
  fingerprint?: string;
  values?: Record<string, number>;
}

interface GrafanaWebhook {
  status?: "firing" | "resolved";
  alerts?: GrafanaAlert[];
}

interface IncidentState {
  fingerprint: string;
  status: "firing" | "resolved";
  firstSeenAt: number;
  lastSeenAt: number;
  acknowledgedAt?: number;
  escalatedAt?: number;
  slackThreadTs?: string;
  slackDeliveredAt?: number;
  telegramDeliveredAt?: number;
  recoverySlackDeliveredAt?: number;
  recoveryTelegramDeliveredAt?: number;
  summary: string;
  severity: string;
}

const SIGNATURE_HEADER = "x-grafana-alerting-signature";
const TIMESTAMP_HEADER = "x-grafana-alerting-signature-timestamp";
const INCIDENT_PREFIX = "incident:";
const REPLAY_WINDOW_SECONDS = 300;
const ACK_DEADLINE_MS = 3 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function verifyGrafanaSignature(
  body: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signature || !timestamp || !secret || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > REPLAY_WINDOW_SECONDS) return false;
  const expected = await hmacHex(secret, `${timestamp}:${body}`);
  return constantTimeEqual(expected, signature.toLowerCase());
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function alertSummary(alert: GrafanaAlert): string {
  const alertName = alert.labels?.alertname || "Supabase alert";
  const summary = alert.annotations?.summary || alert.annotations?.description || alertName;
  return summary.replace(/[\r\n]+/g, " ").slice(0, 400);
}

function alertSeverity(alert: GrafanaAlert): string {
  const severity = alert.labels?.severity?.toLowerCase();
  return severity === "critical" || severity === "warning" ? severity : "warning";
}

function alertFingerprint(alert: GrafanaAlert): string {
  return alert.fingerprint || `${alert.labels?.alertname || "unknown"}:${alert.startsAt || "unknown"}`;
}

function incidentKey(fingerprint: string): string {
  return `${INCIDENT_PREFIX}${fingerprint}`;
}

async function readIncident(store: KvStore, fingerprint: string): Promise<IncidentState | null> {
  const raw = await store.get(incidentKey(fingerprint));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IncidentState;
  } catch {
    return null;
  }
}

async function writeIncident(store: KvStore, incident: IncidentState): Promise<void> {
  await store.put(incidentKey(incident.fingerprint), JSON.stringify(incident), { expirationTtl: 7 * 24 * 3600 });
}

async function signedAckUrl(env: Env, fingerprint: string, nowMs: number): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + 24 * 3600;
  const token = await hmacHex(env.ACK_LINK_SECRET, `${fingerprint}:${expires}`);
  const url = new URL(`/ack/${encodeURIComponent(fingerprint)}`, env.PUBLIC_BASE_URL);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendSlack(
  env: Env,
  text: string,
  threadTs?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL_ID,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const result = (await response.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!response.ok || !result.ok) throw new Error(`slack:${result.error || response.status}`);
  return result.ts;
}

async function sendTelegram(env: Env, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`telegram:${response.status}`);
}

function alertLinks(alert: GrafanaAlert): string {
  const dashboard = safeUrl(alert.dashboardURL);
  const source = safeUrl(alert.generatorURL);
  return dashboard ? `\nDashboard: ${dashboard}` : source ? `\nSource: ${source}` : "";
}

export async function handleAlert(
  alert: GrafanaAlert,
  env: Env,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const fingerprint = alertFingerprint(alert);
  const existing = await readIncident(env.INCIDENTS, fingerprint);
  const previousStatus = existing?.status;
  const status = alert.status;
  const summary = alertSummary(alert);
  const severity = alertSeverity(alert);
  const state: IncidentState = existing || {
    fingerprint,
    status,
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
    summary,
    severity,
  };
  state.status = status;
  state.lastSeenAt = nowMs;
  state.summary = summary;
  state.severity = severity;

  const deliveryErrors: Error[] = [];
  if (status === "firing" && (!state.slackDeliveredAt || !state.telegramDeliveredAt)) {
    const ackUrl = await signedAckUrl(env, fingerprint, nowMs);
    const text = `🚨 [${severity.toUpperCase()}] ${summary}${alertLinks(alert)}\nACK: ${ackUrl}`;
    if (!state.slackDeliveredAt) {
      try {
        state.slackThreadTs = await sendSlack(env, text, undefined, fetchImpl);
        state.slackDeliveredAt = nowMs;
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("slack delivery failed"));
      }
    }
    if (!state.telegramDeliveredAt) {
      try {
        await sendTelegram(env, text, fetchImpl);
        state.telegramDeliveredAt = nowMs;
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("telegram delivery failed"));
      }
    }
  } else if (
    status === "resolved" &&
    existing &&
    (previousStatus !== "resolved" || !state.recoverySlackDeliveredAt || !state.recoveryTelegramDeliveredAt)
  ) {
    const text = `✅ [RECOVERED] ${summary}${alertLinks(alert)}`;
    if (!state.recoverySlackDeliveredAt) {
      try {
        await sendSlack(env, text, existing.slackThreadTs, fetchImpl);
        state.recoverySlackDeliveredAt = nowMs;
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Slack recovery delivery failed"));
      }
    }
    if (!state.recoveryTelegramDeliveredAt) {
      try {
        await sendTelegram(env, text, fetchImpl);
        state.recoveryTelegramDeliveredAt = nowMs;
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Telegram recovery delivery failed"));
      }
    }
  }
  await writeIncident(env.INCIDENTS, state);
  if (deliveryErrors.length > 0) throw new AggregateError(deliveryErrors, "incident delivery incomplete");
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const verified = await verifyGrafanaSignature(
    body,
    request.headers.get(SIGNATURE_HEADER),
    request.headers.get(TIMESTAMP_HEADER),
    env.GRAFANA_HMAC_SECRET,
  );
  if (!verified) return new Response("unauthorized", { status: 401 });

  let payload: GrafanaWebhook;
  try {
    payload = JSON.parse(body) as GrafanaWebhook;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  if (alerts.length === 0) return new Response("no alerts", { status: 400 });
  await Promise.all(alerts.slice(0, 20).map((alert) => handleAlert(alert, env)));
  return Response.json({ ok: true, accepted: Math.min(alerts.length, 20) });
}

async function handleAck(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fingerprint = decodeURIComponent(url.pathname.slice("/ack/".length));
  const expires = url.searchParams.get("expires");
  const token = url.searchParams.get("token");
  if (!fingerprint || !expires || !token || !/^\d+$/.test(expires)) return new Response("invalid", { status: 400 });
  if (Number(expires) < Math.floor(Date.now() / 1000)) return new Response("expired", { status: 410 });
  const expected = await hmacHex(env.ACK_LINK_SECRET, `${fingerprint}:${expires}`);
  if (!constantTimeEqual(expected, token.toLowerCase())) return new Response("unauthorized", { status: 401 });
  const state = await readIncident(env.INCIDENTS, fingerprint);
  if (!state) return new Response("not found", { status: 404 });
  state.acknowledgedAt = Date.now();
  await writeIncident(env.INCIDENTS, state);
  if (state.slackThreadTs) await sendSlack(env, "👀 ACK — 대응자가 확인했습니다.", state.slackThreadTs);
  return new Response("ACK recorded. You can close this page.", { status: 200 });
}

export async function escalateUnacknowledged(
  env: Env,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const listed = await env.INCIDENTS.list({ prefix: INCIDENT_PREFIX });
  let escalated = 0;
  for (const key of listed.keys) {
    const raw = await env.INCIDENTS.get(key.name);
    if (!raw) continue;
    const state = JSON.parse(raw) as IncidentState;
    if (
      state.status !== "firing" ||
      state.acknowledgedAt ||
      state.escalatedAt ||
      nowMs - state.firstSeenAt < ACK_DEADLINE_MS
    ) continue;
    const text = `🆘 [UNACKNOWLEDGED] ${state.summary} — 3분 내 ACK 없음`;
    await Promise.all([
      sendSlack(env, text, state.slackThreadTs, fetchImpl),
      sendTelegram(env, text, fetchImpl),
    ]);
    state.escalatedAt = nowMs;
    await writeIncident(env.INCIDENTS, state);
    escalated += 1;
  }
  return escalated;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/grafana") return handleWebhook(request, env);
    if (request.method === "GET" && url.pathname.startsWith("/ack/")) return handleAck(request, env);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await escalateUnacknowledged(env);
  },
};

export default worker;
