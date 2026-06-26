import crypto from "node:crypto";
import zlib from "node:zlib";

// App Store Connect Sales & Trends — daily first-time download counts (App Units).
// Server-only. Credentials come from env (never bundled):
//   ASC_ISSUER_ID, ASC_KEY_ID, ASC_VENDOR_NUMBER, ASC_PRIVATE_KEY (the .p8 PEM).

const ISSUER = process.env.ASC_ISSUER_ID || "";
const KEY_ID = process.env.ASC_KEY_ID || "";
const VENDOR = process.env.ASC_VENDOR_NUMBER || "";
// Vercel env strips newlines from multiline values when pasted; accept either
// real newlines or literal "\n" escapes in the stored PEM.
const PRIVATE_KEY = (process.env.ASC_PRIVATE_KEY || "").replace(/\\n/g, "\n");

export function ascConfigured(): boolean {
  return Boolean(ISSUER && KEY_ID && VENDOR && PRIVATE_KEY);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Short-lived ES256 JWT for the App Store Connect API. */
function makeToken(): string {
  const header = { alg: "ES256", kid: KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, iat: now, exp: now + 60 * 18, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // ES256 JOSE signatures must be raw R||S (ieee-p1363), not DER.
  const sig = crypto.sign("sha256", Buffer.from(signingInput), {
    key: PRIVATE_KEY,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(sig)}`;
}

// First-time download product-type identifiers (App Units). Updates ("7*") and
// re-downloads ("3*") are excluded so we count installs, not re-installs.
function isDownloadType(typeId: string): boolean {
  return typeId.startsWith("1") || typeId === "F1" || typeId === "FF1";
}

/**
 * Fetch the daily SALES SUMMARY report for one date and return total iOS
 * first-time downloads. Returns null when Apple has no report yet for that date
 * (HTTP 404 — reports lag ~1–2 days), so callers can skip rather than fail.
 */
export async function fetchIosDownloads(date: string): Promise<number | null> {
  const params = new URLSearchParams({
    "filter[frequency]": "DAILY",
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": VENDOR,
    "filter[reportDate]": date,
  });
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${makeToken()}`, Accept: "application/a-gzip" },
  });
  if (res.status === 404) return null; // no report for this date yet
  if (!res.ok) {
    throw new Error(`ASC salesReports ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const tsv = zlib.gunzipSync(gz).toString("utf8");
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return 0;

  const headers = lines[0].split("\t");
  const unitsIdx = headers.indexOf("Units");
  const typeIdx = headers.indexOf("Product Type Identifier");
  if (unitsIdx < 0 || typeIdx < 0) return 0;

  let total = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    if (isDownloadType((cols[typeIdx] || "").trim())) {
      total += Number(cols[unitsIdx] || 0) || 0;
    }
  }
  return total;
}
