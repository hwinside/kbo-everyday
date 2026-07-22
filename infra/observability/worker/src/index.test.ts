import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  IncidentCoordinator,
  type IncidentState,
  type IncidentStore,
  escalateUnacknowledged,
  handleAlert,
  verifyGrafanaSignature,
} from "./index";

class MemoryStore implements IncidentStore {
  value: IncidentState | null = null;

  async get() {
    return this.value ? structuredClone(this.value) : null;
  }

  async put(value: IncidentState) {
    this.value = structuredClone(value);
  }
}

class MemoryDurableStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp: number) {
    this.alarmAt = timestamp;
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }
}

class SerialDurableState {
  readonly storage = new MemoryDurableStorage();
  private tail: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class TestNamespace {
  readonly coordinators = new Map<string, IncidentCoordinator>();

  constructor(
    private readonly env: ReturnType<typeof makeEnv>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  idFromName(name: string) {
    return name;
  }

  get(id: unknown) {
    const name = String(id);
    let coordinator = this.coordinators.get(name);
    if (!coordinator) {
      coordinator = new IncidentCoordinator(new SerialDurableState(), this.env, this.fetchImpl);
      this.coordinators.set(name, coordinator);
    }
    return coordinator;
  }
}

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}:${body}`))).toString("hex");
}

function makeEnv() {
  return {
    INCIDENT_COORDINATOR: undefined as unknown as TestNamespace,
    GRAFANA_HMAC_SECRET: "grafana-test-secret",
    SLACK_BOT_TOKEN: "slack-test-token",
    SLACK_CHANNEL_ID: "C123",
    TELEGRAM_BOT_TOKEN: "telegram-test-token",
    TELEGRAM_CHAT_ID: "123",
    PUBLIC_BASE_URL: "https://alerts.example.test",
    ACK_LINK_SECRET: "ack-test-secret",
  };
}

function fakeFetch(calls: Array<{ url: string; body: string }>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body || "") });
    if (url.includes("slack.com")) return Response.json({ ok: true, ts: "123.456" });
    return Response.json({ ok: true });
  };
}

function failTelegramOnce(calls: Array<{ url: string; body: string }>) {
  let telegramFailures = 1;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body || "") });
    if (url.includes("slack.com")) return Response.json({ ok: true, ts: "123.456" });
    if (telegramFailures > 0) {
      telegramFailures -= 1;
      return new Response("failed", { status: 503 });
    }
    return Response.json({ ok: true });
  };
}

function firingAlert(fingerprint = "cpu-1") {
  return {
    status: "firing" as const,
    fingerprint,
    startsAt: "2026-07-22T12:00:00Z",
    labels: { alertname: "CPU critical", severity: "critical", threshold: "85% for 3m", deploy_sha: "abc123" },
    annotations: { summary: "CPU above 85%", first_action: "Check auth request volume." },
    values: { A: 91.2 },
    dashboardURL: "https://grafana.example.test/d/cpu",
  };
}

test("Grafana HMAC requires a current timestamp and exact body", async () => {
  const body = JSON.stringify({ status: "firing" });
  const timestamp = "2000";
  const signature = await sign("secret", timestamp, body);
  assert.equal(await verifyGrafanaSignature(body, signature, timestamp, "secret", 2000), true);
  assert.equal(await verifyGrafanaSignature(`${body}x`, signature, timestamp, "secret", 2000), false);
  assert.equal(await verifyGrafanaSignature(body, signature, timestamp, "secret", 2400), false);
});

test("webhook rejects unsigned requests", async () => {
  const response = await worker.fetch(
    new Request("https://alerts.example.test/webhooks/grafana", { method: "POST", body: "{}" }),
    makeEnv(),
  );
  assert.equal(response.status, 401);
});

test("incident notifications deduplicate and recovery replies to the same thread", async () => {
  const store = new MemoryStore();
  const env = makeEnv();
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  const firing = firingAlert();

  await handleAlert(firing, env, store, 1_000, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(store.value?.slackThreadTs, "123.456");
  const slackPayload = JSON.parse(calls[0].body) as { unfurl_links?: boolean; text?: string };
  assert.equal(slackPayload.unfurl_links, false);
  assert.match(slackPayload.text || "", /Current: A=91.2/);
  assert.match(slackPayload.text || "", /Deploy: abc123/);

  await handleAlert(firing, env, store, 2_000, fetchImpl);
  assert.equal(calls.length, 2, "duplicate firing alert must not notify again");

  await handleAlert({ ...firing, status: "resolved" }, env, store, 3_000, fetchImpl);
  assert.equal(calls.length, 4);
  const recoverySlack = JSON.parse(calls[2].body) as { thread_ts?: string };
  assert.equal(recoverySlack.thread_ts, "123.456");
});

test("resolved incident recurrence starts a fresh episode and notifies both channels", async () => {
  const store = new MemoryStore();
  const env = makeEnv();
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  const firing = firingAlert("stable-fingerprint");

  await handleAlert(firing, env, store, 1_000, fetchImpl);
  const firstEpisode = store.value?.episodeId;
  await handleAlert({ ...firing, status: "resolved" }, env, store, 2_000, fetchImpl);
  await handleAlert(firing, env, store, 3_000, fetchImpl);

  assert.equal(calls.length, 6);
  assert.notEqual(store.value?.episodeId, firstEpisode);
  assert.equal(store.value?.firstSeenAt, 3_000);
  assert.equal(store.value?.acknowledgedAt, undefined);
  assert.equal(store.value?.escalatedAt, undefined);
});

test("partial initial delivery retry sends only the missing channel", async () => {
  const store = new MemoryStore();
  const env = makeEnv();
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = failTelegramOnce(calls) as typeof fetch;
  const firing = firingAlert("disk-1");

  await assert.rejects(handleAlert(firing, env, store, 1_000, fetchImpl), /delivery incomplete/);
  await handleAlert(firing, env, store, 2_000, fetchImpl);
  assert.equal(calls.filter((call) => call.url.includes("slack.com")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("telegram.org")).length, 2);
});

test("Durable Object serializes concurrent webhook deliveries for one fingerprint", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const env = makeEnv();
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  const coordinator = new IncidentCoordinator(new SerialDurableState(), env, fetchImpl);
  const request = () => new Request("https://incident.internal/alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(firingAlert("concurrent-1")),
  });

  const responses = await Promise.all([coordinator.fetch(request()), coordinator.fetch(request())]);
  assert(responses.every((response) => response.ok));
  assert.equal(calls.filter((call) => call.url.includes("slack.com")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("telegram.org")).length, 1);
});

test("GET ACK is read-only and POST records acknowledgement", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const env = makeEnv();
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  const namespace = new TestNamespace(env, fetchImpl);
  env.INCIDENT_COORDINATOR = namespace;
  const alert = firingAlert("ack-1");
  await namespace.get("ack-1").fetch("https://incident.internal/alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alert),
  });
  const slackPayload = JSON.parse(calls[0].body) as { text: string };
  const ackUrl = slackPayload.text.match(/ACK: (https:\/\/\S+)/)?.[1];
  assert(ackUrl);

  const getResponse = await worker.fetch(new Request(ackUrl), env);
  assert.equal(getResponse.status, 200);
  assert.match(await getResponse.text(), /method="post"/);
  const coordinator = namespace.coordinators.get("ack-1");
  assert(coordinator);
  const stateBeforePost = await coordinator.fetch(new Request("https://incident.internal/exists"));
  assert.equal(stateBeforePost.status, 200);
  assert.equal(calls.filter((call) => call.body.includes("ACK —")).length, 0);

  const postResponse = await worker.fetch(new Request(ackUrl, { method: "POST" }), env);
  assert.equal(postResponse.status, 200);
  assert.equal(calls.filter((call) => call.body.includes("ACK —")).length, 1);

  await namespace.get("ack-1").fetch("https://incident.internal/alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...alert, status: "resolved" }),
  });
  await namespace.get("ack-1").fetch("https://incident.internal/alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alert),
  });
  const stalePost = await worker.fetch(new Request(ackUrl, { method: "POST" }), env);
  assert.equal(stalePost.status, 409, "an ACK capability from an older episode must not acknowledge a recurrence");
});

test("partial escalation persists channel ledger and retries only the failed channel", async () => {
  const store = new MemoryStore();
  store.value = {
    fingerprint: "abc",
    episodeId: "00000000-0000-4000-8000-000000000001",
    status: "firing",
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
    summary: "CPU critical",
    severity: "critical",
    slackThreadTs: "123.456",
  };
  const calls: Array<{ url: string; body: string }> = [];
  const env = makeEnv();
  const fetchImpl = failTelegramOnce(calls) as typeof fetch;
  const due = 1_000 + 3 * 60 * 1000;

  await assert.rejects(escalateUnacknowledged(env, store, due, fetchImpl), /escalation delivery incomplete/);
  assert(store.value?.escalationSlackDeliveredAt);
  assert.equal(store.value?.escalationTelegramDeliveredAt, undefined);
  assert.equal(await escalateUnacknowledged(env, store, due + 60_000, fetchImpl), 1);
  assert.equal(await escalateUnacknowledged(env, store, due + 120_000, fetchImpl), 0);
  assert.equal(calls.filter((call) => call.url.includes("slack.com")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("telegram.org")).length, 2);
});
