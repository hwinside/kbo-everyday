import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  handlePasswordReset,
  POST,
} from "../../src/app/api/auth/reset-password/route";
import {
  guardEmailRecipient,
  guardMxRecipient,
} from "../../src/lib/email-domain-guard";

test("denylist is fail-closed", () => {
  assert.deepEqual(guardEmailRecipient("user@lycos.co.kr"), {
    allowed: false,
    email: "user@lycos.co.kr",
    domain: "lycos.co.kr",
    reason: "blocked_domain",
  });
  assert.equal(guardEmailRecipient("user@freechal.com").allowed, false);
});

test("major-domain typo exposes a correction", () => {
  const result = guardEmailRecipient("user@hanmaii.net");
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "possible_typo");
  assert.equal(result.suggestion, "hanmail.net");
  assert.equal(guardEmailRecipient("user@hanmli.net").suggestion, "hanmail.net");
  assert.equal(guardEmailRecipient("user@navr.com").suggestion, "naver.com");
});

test("known-good domains never false-positive", () => {
  for (const domain of [
    "hanmail.net",
    "naver.com",
    "gmail.com",
    "daum.net",
    "nate.com",
    "kakao.com",
  ]) {
    assert.equal(guardEmailRecipient(`user@${domain}`).allowed, true, domain);
  }
});

test("qa-* recipients at keubo.fan are blocked", () => {
  const result = guardEmailRecipient("QA-recovery@keubo.fan");
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "qa_recipient");
  assert.equal(guardEmailRecipient("member@keubo.fan").allowed, true);
});

test("MX timeout and lookup errors fail open while empty MX fails closed", async () => {
  assert.deepEqual(
    await guardMxRecipient("slow.example", () => new Promise(() => {}), 5),
    { allowed: true, reason: "lookup_timeout" },
  );
  assert.deepEqual(
    await guardMxRecipient("error.example", async () => {
      throw new Error("temporary DNS error");
    }),
    { allowed: true, reason: "lookup_failed" },
  );
  assert.deepEqual(
    await guardMxRecipient("empty.example", async () => []),
    { allowed: false, reason: "mx_missing" },
  );
  assert.deepEqual(
    await guardMxRecipient("missing.example", async () => {
      throw Object.assign(new Error("queryMx ENODATA"), { code: "ENODATA" });
    }),
    { allowed: false, reason: "mx_missing" },
  );
});

test("route binding rejects blocked recipients before Supabase mail dispatch", async () => {
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = (async () => {
    dispatches += 1;
    return Response.json({});
  }) as typeof fetch;
  try {
    const response = await POST(
      new NextRequest("http://localhost/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ email: "user@lycos.co.kr" }),
      }),
    );
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.code, "blocked_domain");
    assert.equal(dispatches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("route sends a valid recipient through Supabase recovery after MX passes", async () => {
  const originalEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  let dispatchedUrl = "";
  let dispatchedEmail = "";
  try {
    const response = await handlePasswordReset(
      new NextRequest("http://localhost/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ email: " Normal@Gmail.com " }),
      }),
      {
        lookupMx: async () => [{ exchange: "mx.gmail.com", priority: 1 }],
        dispatch: (async (input, init) => {
          dispatchedUrl = String(input);
          dispatchedEmail = JSON.parse(String(init?.body)).email;
          return Response.json({});
        }) as typeof fetch,
      },
    );
    assert.equal(response.status, 200);
    assert.match(dispatchedUrl, /\/auth\/v1\/recover\?/);
    assert.equal(dispatchedEmail, "normal@gmail.com");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("route-level MX timeout fails open and still reaches recovery", async () => {
  const originalEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  let dispatches = 0;
  try {
    const response = await handlePasswordReset(
      new NextRequest("http://localhost/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ email: "user@example.org" }),
      }),
      {
        lookupMx: () => new Promise(() => {}),
        mxTimeoutMs: 5,
        dispatch: (async () => {
          dispatches += 1;
          return Response.json({});
        }) as typeof fetch,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(dispatches, 1);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
