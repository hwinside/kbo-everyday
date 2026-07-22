import assert from "node:assert/strict";
import test from "node:test";
import worker, { escalateUnacknowledged, handleAlert, verifyGrafanaSignature } from "./index";

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return { keys: [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) };
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

function makeEnv(kv = new MemoryKv()) {
  return {
    INCIDENTS: kv,
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

function flakyFetch(calls: Array<{ url: string; body: string }>) {
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
  const kv = new MemoryKv();
  const env = makeEnv(kv);
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  const firing = {
    status: "firing" as const,
    fingerprint: "cpu-1",
    labels: { alertname: "CPU critical", severity: "critical" },
    annotations: { summary: "CPU above 85%" },
    dashboardURL: "https://grafana.example.test/d/cpu",
  };

  await handleAlert(firing, env, 1_000, fetchImpl);
  assert.equal(calls.length, 2);
  const stored = JSON.parse((await kv.get("incident:cpu-1")) || "{}") as { slackThreadTs?: string };
  assert.equal(stored.slackThreadTs, "123.456");

  await handleAlert(firing, env, 2_000, fetchImpl);
  assert.equal(calls.length, 2, "duplicate firing alert must not notify again");

  await handleAlert({ ...firing, status: "resolved" }, env, 3_000, fetchImpl);
  assert.equal(calls.length, 4);
  const recoverySlack = JSON.parse(calls[2].body) as { thread_ts?: string };
  assert.equal(recoverySlack.thread_ts, "123.456");
});

test("partial delivery retry sends only the missing channel", async () => {
  const kv = new MemoryKv();
  const env = makeEnv(kv);
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = flakyFetch(calls) as typeof fetch;
  const firing = {
    status: "firing" as const,
    fingerprint: "disk-1",
    labels: { alertname: "Disk critical", severity: "critical" },
    annotations: { summary: "Disk above 80%" },
  };

  await assert.rejects(handleAlert(firing, env, 1_000, fetchImpl), /delivery incomplete/);
  assert.equal(calls.filter((call) => call.url.includes("slack.com")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("telegram.org")).length, 1);

  await handleAlert(firing, env, 2_000, fetchImpl);
  assert.equal(calls.filter((call) => call.url.includes("slack.com")).length, 1);
  assert.equal(calls.filter((call) => call.url.includes("telegram.org")).length, 2);
});

test("unacknowledged incidents escalate once", async () => {
  const kv = new MemoryKv();
  await kv.put("incident:abc", JSON.stringify({
    fingerprint: "abc",
    status: "firing",
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
    summary: "CPU critical",
    severity: "critical",
    slackThreadTs: "123.456",
  }));
  const calls: Array<{ url: string; body: string }> = [];
  const env = makeEnv(kv);
  const fetchImpl = fakeFetch(calls) as typeof fetch;
  assert.equal(await escalateUnacknowledged(env, 1_000 + 3 * 60 * 1000, fetchImpl), 1);
  assert.equal(await escalateUnacknowledged(env, 1_000 + 4 * 60 * 1000, fetchImpl), 0);
  assert.equal(calls.length, 2);
});
