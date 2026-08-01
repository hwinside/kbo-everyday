import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  AUTH_ERROR_MESSAGES,
  KAKAO_EMAIL_UNVERIFIED_CODE,
  getUserFacingAuthError,
  getUserFacingAuthErrorFromUrl,
} from "../../src/lib/auth-error";

test("provider hook marker maps to the Kakao email guidance", () => {
  const params = new URLSearchParams({
    error: "server_error",
    error_description: "KAKAO_EMAIL_UNVERIFIED",
  });

  assert.equal(
    getUserFacingAuthError(params),
    KAKAO_EMAIL_UNVERIFIED_CODE,
  );
  assert.match(
    AUTH_ERROR_MESSAGES[KAKAO_EMAIL_UNVERIFIED_CODE],
    /카카오 계정.*이메일.*인증/,
  );
});

test("unrelated OAuth failures do not masquerade as the Kakao email error", () => {
  const params = new URLSearchParams({
    error: "access_denied",
    error_description: "The user cancelled the OAuth flow",
  });
  assert.equal(getUserFacingAuthError(params), null);
});

test("native callback recognizes the provider error in a URL fragment", () => {
  const url = new URL(
    "fan.keubo.app://auth/callback#error=server_error&error_description=KAKAO_EMAIL_UNVERIFIED",
  );
  assert.equal(
    getUserFacingAuthErrorFromUrl(url),
    KAKAO_EMAIL_UNVERIFIED_CODE,
  );
});

test("web callback preserves only the stable user-facing error code", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const { GET: authCallback } = await import(
    "../../src/app/auth/callback/route"
  );
  const response = await authCallback(
    new NextRequest(
      "https://keubo.fan/auth/callback?error=server_error&error_description=KAKAO_EMAIL_UNVERIFIED",
    ),
  );

  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin, "https://keubo.fan");
  assert.equal(
    location.searchParams.get("auth_error"),
    KAKAO_EMAIL_UNVERIFIED_CODE,
  );
  assert.equal(location.searchParams.has("error_description"), false);
});
