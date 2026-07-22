interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableState {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}

interface Env {
  INCIDENT_COORDINATOR: DurableNamespace;
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
  alerts?: GrafanaAlert[];
}

export interface IncidentState {
  fingerprint: string;
  episodeId: string;
  status: "firing" | "resolved";
  sourceStartedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  acknowledgedAt?: number;
  ackSlackDeliveredAt?: number;
  escalatedAt?: number;
  escalationSlackDeliveredAt?: number;
  escalationTelegramDeliveredAt?: number;
  slackThreadTs?: string;
  slackDeliveredAt?: number;
  telegramDeliveredAt?: number;
  recoverySlackDeliveredAt?: number;
  recoveryTelegramDeliveredAt?: number;
  summary: string;
  severity: string;
}

export interface IncidentStore {
  get(): Promise<IncidentState | null>;
  put(incident: IncidentState): Promise<void>;
}

const SIGNATURE_HEADER = "x-grafana-alerting-signature";
const TIMESTAMP_HEADER = "x-grafana-alerting-signature-timestamp";
const STATE_KEY = "incident";
const REPLAY_WINDOW_SECONDS = 300;
const ACK_DEADLINE_MS = 3 * 60 * 1000;
const ESCALATION_RETRY_MS = 60 * 1000;
const MAX_ALERTS_PER_WEBHOOK = 40;

class DurableIncidentStore implements IncidentStore {
  constructor(private readonly storage: DurableStorage) {}

  async get(): Promise<IncidentState | null> {
    return (await this.storage.get<IncidentState>(STATE_KEY)) ?? null;
  }

  async put(incident: IncidentState): Promise<void> {
    await this.storage.put(STATE_KEY, incident);
  }
}

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

function cleanText(value: string | undefined, maxLength = 400): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, maxLength) || undefined;
}

function alertSummary(alert: GrafanaAlert): string {
  const alertName = alert.labels?.alertname || "Supabase alert";
  return cleanText(alert.annotations?.summary || alert.annotations?.description || alertName) || alertName;
}

function alertSeverity(alert: GrafanaAlert): string {
  const severity = alert.labels?.severity?.toLowerCase();
  return severity === "critical" || severity === "warning" ? severity : "warning";
}

function alertFingerprint(alert: GrafanaAlert): string {
  return alert.fingerprint || `${alert.labels?.alertname || "unknown"}:${alert.startsAt || "unknown"}`;
}

function alertSourceStartedAt(alert: GrafanaAlert): number | null {
  if (!alert.startsAt) return null;
  const parsed = Date.parse(alert.startsAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumericValue(values: Record<string, number> | undefined): string | undefined {
  if (!values) return undefined;
  const entry = Object.entries(values).find(([, value]) => Number.isFinite(value));
  return entry ? `${entry[0]}=${entry[1]}` : undefined;
}

function alertContext(alert: GrafanaAlert): string {
  const current = cleanText(alert.annotations?.current_value) || firstNumericValue(alert.values) || "unknown";
  const threshold = cleanText(alert.annotations?.threshold || alert.labels?.threshold) || "see rule";
  const deploySha = cleanText(alert.annotations?.deploy_sha || alert.labels?.deploy_sha, 64) || "unknown";
  const firstAction = cleanText(alert.annotations?.first_action, 240) || "Open the dashboard and follow the incident runbook.";
  const started = cleanText(alert.startsAt, 64) || new Date().toISOString();
  return `\nStarted: ${started}\nCurrent: ${current}\nThreshold: ${threshold}\nDeploy: ${deploySha}\nFirst action: ${firstAction}`;
}

async function signedAckUrl(env: Env, fingerprint: string, episodeId: string, nowMs: number): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + 24 * 3600;
  const token = await hmacHex(env.ACK_LINK_SECRET, `${fingerprint}:${episodeId}:${expires}`);
  const url = new URL(`/ack/${encodeURIComponent(fingerprint)}`, env.PUBLIC_BASE_URL);
  url.searchParams.set("episode", episodeId);
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
      unfurl_links: false,
      unfurl_media: false,
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

function newEpisode(alert: GrafanaAlert, nowMs: number): IncidentState {
  return {
    fingerprint: alertFingerprint(alert),
    episodeId: crypto.randomUUID(),
    status: "firing",
    sourceStartedAt: alertSourceStartedAt(alert) ?? nowMs,
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
    summary: alertSummary(alert),
    severity: alertSeverity(alert),
  };
}

export async function handleAlert(
  alert: GrafanaAlert,
  env: Env,
  store: IncidentStore,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<IncidentState> {
  const existing = await store.get();
  const incomingSourceStartedAt = alertSourceStartedAt(alert);
  if (existing) {
    if (incomingSourceStartedAt === null && alert.status === "resolved") return existing;
    if (incomingSourceStartedAt !== null && incomingSourceStartedAt < existing.sourceStartedAt) return existing;
    if (
      existing.status === "resolved" &&
      alert.status === "firing" &&
      incomingSourceStartedAt !== null &&
      incomingSourceStartedAt === existing.sourceStartedAt
    ) return existing;
    if (
      alert.status === "resolved" &&
      incomingSourceStartedAt !== null &&
      incomingSourceStartedAt !== existing.sourceStartedAt
    ) return existing;
  } else if (alert.status === "resolved") {
    return { ...newEpisode({ ...alert, status: "firing" }, nowMs), status: "resolved" };
  }
  const previousStatus = existing?.status;
  const status = alert.status;
  const isNewEpisode = status === "firing" && (
    !existing ||
    existing.status === "resolved" ||
    (incomingSourceStartedAt !== null && incomingSourceStartedAt > existing.sourceStartedAt)
  );
  const state = isNewEpisode ? newEpisode(alert, nowMs) : existing || newEpisode(alert, nowMs);

  state.status = status;
  state.lastSeenAt = nowMs;
  state.summary = alertSummary(alert);
  state.severity = alertSeverity(alert);
  await store.put(state);

  const deliveryErrors: Error[] = [];
  if (status === "firing" && (!state.slackDeliveredAt || !state.telegramDeliveredAt)) {
    const ackUrl = await signedAckUrl(env, state.fingerprint, state.episodeId, nowMs);
    const text = `🚨 [${state.severity.toUpperCase()}] ${state.summary}${alertContext(alert)}${alertLinks(alert)}\nACK: ${ackUrl}`;
    if (!state.slackDeliveredAt) {
      try {
        state.slackThreadTs = await sendSlack(env, text, undefined, fetchImpl);
        state.slackDeliveredAt = nowMs;
        await store.put(state);
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Slack delivery failed"));
      }
    }
    if (!state.telegramDeliveredAt) {
      try {
        await sendTelegram(env, text, fetchImpl);
        state.telegramDeliveredAt = nowMs;
        await store.put(state);
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Telegram delivery failed"));
      }
    }
  } else if (
    status === "resolved" &&
    existing &&
    (previousStatus !== "resolved" || !state.recoverySlackDeliveredAt || !state.recoveryTelegramDeliveredAt)
  ) {
    const text = `✅ [RECOVERED] ${state.summary}${alertContext(alert)}${alertLinks(alert)}`;
    if (!state.recoverySlackDeliveredAt) {
      try {
        await sendSlack(env, text, state.slackThreadTs, fetchImpl);
        state.recoverySlackDeliveredAt = nowMs;
        await store.put(state);
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Slack recovery delivery failed"));
      }
    }
    if (!state.recoveryTelegramDeliveredAt) {
      try {
        await sendTelegram(env, text, fetchImpl);
        state.recoveryTelegramDeliveredAt = nowMs;
        await store.put(state);
      } catch (error) {
        deliveryErrors.push(error instanceof Error ? error : new Error("Telegram recovery delivery failed"));
      }
    }
  }

  await store.put(state);
  if (deliveryErrors.length > 0) throw new AggregateError(deliveryErrors, "incident delivery incomplete");
  return state;
}

export async function escalateUnacknowledged(
  env: Env,
  store: IncidentStore,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const state = await store.get();
  if (
    !state ||
    state.status !== "firing" ||
    state.acknowledgedAt ||
    nowMs - state.firstSeenAt < ACK_DEADLINE_MS ||
    (state.escalationSlackDeliveredAt && state.escalationTelegramDeliveredAt)
  ) return 0;

  const text = `🆘 [UNACKNOWLEDGED] ${state.summary} — 3분 내 ACK 없음`;
  const deliveryErrors: Error[] = [];
  if (!state.escalationSlackDeliveredAt) {
    try {
      await sendSlack(env, text, state.slackThreadTs, fetchImpl);
      state.escalationSlackDeliveredAt = nowMs;
      await store.put(state);
    } catch (error) {
      deliveryErrors.push(error instanceof Error ? error : new Error("Slack escalation failed"));
    }
  }
  if (!state.escalationTelegramDeliveredAt) {
    try {
      await sendTelegram(env, text, fetchImpl);
      state.escalationTelegramDeliveredAt = nowMs;
      await store.put(state);
    } catch (error) {
      deliveryErrors.push(error instanceof Error ? error : new Error("Telegram escalation failed"));
    }
  }
  if (state.escalationSlackDeliveredAt && state.escalationTelegramDeliveredAt) state.escalatedAt = nowMs;
  await store.put(state);
  if (deliveryErrors.length > 0) throw new AggregateError(deliveryErrors, "escalation delivery incomplete");
  return 1;
}

async function recordAcknowledgement(
  env: Env,
  store: IncidentStore,
  episodeId: string,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<"ok" | "missing" | "stale"> {
  const state = await store.get();
  if (!state) return "missing";
  if (state.episodeId !== episodeId) return "stale";
  state.acknowledgedAt ||= nowMs;
  await store.put(state);
  if (state.slackThreadTs && !state.ackSlackDeliveredAt) {
    await sendSlack(env, "👀 ACK — 대응자가 확인했습니다.", state.slackThreadTs, fetchImpl);
    state.ackSlackDeliveredAt = nowMs;
    await store.put(state);
  }
  return "ok";
}

function needsEscalation(state: IncidentState | null): state is IncidentState {
  return Boolean(
    state &&
    state.status === "firing" &&
    !state.acknowledgedAt &&
    (!state.escalationSlackDeliveredAt || !state.escalationTelegramDeliveredAt),
  );
}

export class IncidentCoordinator {
  private readonly store: IncidentStore;

  constructor(
    private readonly state: DurableState,
    private readonly env: Env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new DurableIncidentStore(state.storage);
  }

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.state.blockConcurrencyWhile(() => this.handleRequest(request));
  }

  alarm(): Promise<void> {
    return this.state.blockConcurrencyWhile(async () => {
      try {
        await escalateUnacknowledged(this.env, this.store, Date.now(), this.fetchImpl);
      } finally {
        const incident = await this.store.get();
        if (needsEscalation(incident)) await this.state.storage.setAlarm(Date.now() + ESCALATION_RETRY_MS);
      }
    });
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/alert") {
      const alert = await request.json() as GrafanaAlert;
      let deliveryError: unknown;
      try {
        await handleAlert(alert, this.env, this.store, Date.now(), this.fetchImpl);
      } catch (error) {
        deliveryError = error;
      }
      const incident = await this.store.get();
      if (needsEscalation(incident)) {
        await this.state.storage.setAlarm(Math.max(Date.now() + 1000, incident.firstSeenAt + ACK_DEADLINE_MS));
      } else {
        await this.state.storage.deleteAlarm();
      }
      if (deliveryError) return new Response("delivery incomplete", { status: 502 });
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/exists") {
      const incident = await this.store.get();
      return new Response(incident ? "found" : "not found", { status: incident ? 200 : 404 });
    }

    if (request.method === "POST" && url.pathname === "/ack") {
      const payload = await request.json() as { episodeId?: string };
      if (!payload.episodeId) return new Response("invalid", { status: 400 });
      const result = await recordAcknowledgement(this.env, this.store, payload.episodeId, Date.now(), this.fetchImpl);
      if (result === "missing") return new Response("not found", { status: 404 });
      if (result === "stale") return new Response("stale episode", { status: 409 });
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}

function incidentStub(env: Env, fingerprint: string): DurableStub {
  return env.INCIDENT_COORDINATOR.get(env.INCIDENT_COORDINATOR.idFromName(fingerprint));
}

async function forwardAlert(alert: GrafanaAlert, env: Env): Promise<void> {
  const response = await incidentStub(env, alertFingerprint(alert)).fetch("https://incident.internal/alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alert),
  });
  if (!response.ok) throw new Error(`incident coordinator:${response.status}`);
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
  if (alerts.length > MAX_ALERTS_PER_WEBHOOK) {
    return Response.json({ ok: false, error: "too many alerts", max: MAX_ALERTS_PER_WEBHOOK }, { status: 413 });
  }
  await Promise.all(alerts.map((alert) => forwardAlert(alert, env)));
  return Response.json({ ok: true, accepted: alerts.length });
}

interface AckCapability {
  fingerprint: string;
  episodeId: string;
}

async function validateAckCapability(request: Request, env: Env): Promise<AckCapability | Response> {
  const url = new URL(request.url);
  const fingerprint = decodeURIComponent(url.pathname.slice("/ack/".length));
  const episodeId = url.searchParams.get("episode");
  const expires = url.searchParams.get("expires");
  const token = url.searchParams.get("token");
  if (!fingerprint || !episodeId || !expires || !token || !/^\d+$/.test(expires)) {
    return new Response("invalid", { status: 400 });
  }
  if (Number(expires) < Math.floor(Date.now() / 1000)) return new Response("expired", { status: 410 });
  const expected = await hmacHex(env.ACK_LINK_SECRET, `${fingerprint}:${episodeId}:${expires}`);
  if (!constantTimeEqual(expected, token.toLowerCase())) return new Response("unauthorized", { status: 401 });
  return { fingerprint, episodeId };
}

function ackConfirmationPage(request: Request): Response {
  const action = new URL(request.url);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Incident ACK</title></head><body><main><h1>Incident acknowledgement</h1><p>Press the button to confirm that a responder has taken ownership.</p><form method="post" action="${action.pathname}${action.search}"><button type="submit">Acknowledge incident</button></form></main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

async function handleAck(request: Request, env: Env): Promise<Response> {
  const capability = await validateAckCapability(request, env);
  if (capability instanceof Response) return capability;
  const stub = incidentStub(env, capability.fingerprint);
  if (request.method === "GET") {
    const exists = await stub.fetch("https://incident.internal/exists");
    return exists.ok ? ackConfirmationPage(request) : new Response("not found", { status: 404 });
  }
  const response = await stub.fetch("https://incident.internal/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ episodeId: capability.episodeId }),
  });
  if (!response.ok) return new Response(await response.text(), { status: response.status });
  return new Response("ACK recorded. You can close this page.", { status: 200 });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/grafana") return handleWebhook(request, env);
    if ((request.method === "GET" || request.method === "POST") && url.pathname.startsWith("/ack/")) {
      return handleAck(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
};

export default worker;
