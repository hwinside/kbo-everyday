import { SignJWT, importPKCS8 } from "jose";

/** GA4 Data API 공용 클라이언트 — 서버 전용. */
export async function getGa4AccessToken(): Promise<string> {
  let rawJson: string;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (b64) rawJson = Buffer.from(b64, "base64").toString("utf-8");
  else if (raw) rawJson = raw;
  else throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

  const creds = JSON.parse(rawJson) as { client_email: string; private_key: string };
  const privateKey = creds.private_key.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT({
    iss: creds.client_email,
    sub: creds.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function ga4Report(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("GA4_PROPERTY_ID not set");

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`GA4 API ${res.status}: ${await res.text()}`);
  return res.json();
}
