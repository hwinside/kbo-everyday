import crypto from "node:crypto";

// Google Play install stats — daily user installs from the Play Console
// statistics exports (Cloud Storage). Google exposes install counts only as
// monthly CSV reports in a per-developer GCS bucket, not via a query API.
// Server-only. Credentials come from env (never bundled):
//   PLAY_SERVICE_ACCOUNT — service-account JSON (same account as publishing)
//   PLAY_STATS_BUCKET    — "gs://pubsite_prod_..." URI or bare bucket name
const SA_JSON = process.env.PLAY_SERVICE_ACCOUNT || "";
const BUCKET = (process.env.PLAY_STATS_BUCKET || "").replace(/^gs:\/\//, "").replace(/\/+$/, "");

const PACKAGE_NAME = "fan.keubo.app";

export function playStatsConfigured(): boolean {
  return Boolean(SA_JSON && BUCKET);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** OAuth access token for the stats bucket (read-only scope). */
async function makeToken(): Promise<string> {
  const sa = JSON.parse(SA_JSON) as { client_email: string; private_key: string; token_uri: string };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_only",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), sa.private_key);
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signingInput}.${b64url(sig)}`,
  });
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`Play stats token exchange failed (${res.status})`);
  return json.access_token;
}

/** Play stats CSVs are UTF-16LE with a BOM. */
function decodeCsv(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}

/**
 * Fetch daily user-install counts for the given dates (YYYY-MM-DD). Reads each
 * month's installs overview CSV once; dates missing from the reports (Google
 * publishes these CSVs 3–7 days after the fact) are simply absent from the
 * result so callers can skip them — callers should request a lookback window
 * wide enough to cover that lag or late-published days are dropped forever.
 */
export async function fetchAndroidDownloads(dates: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (dates.length === 0) return out;
  const token = await makeToken();
  const months = [...new Set(dates.map((d) => d.slice(0, 7).replace("-", "")))];

  for (const month of months) {
    const object = `stats/installs/installs_${PACKAGE_NAME}_${month}_overview.csv`;
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(object)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) continue; // month report not generated yet
    if (!res.ok) {
      throw new Error(`Play stats CSV ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const csv = decodeCsv(Buffer.from(await res.arrayBuffer()));
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    const headers = lines[0].split(",").map((h) => h.trim());
    const dateIdx = headers.indexOf("Date");
    const unitsIdx = headers.indexOf("Daily User Installs");
    if (dateIdx < 0 || unitsIdx < 0) {
      throw new Error(`Play stats CSV: unexpected headers "${lines[0].slice(0, 200)}"`);
    }

    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const date = (cols[dateIdx] || "").trim();
      if (!dates.includes(date)) continue;
      const units = Number((cols[unitsIdx] || "").trim());
      if (Number.isFinite(units)) out.set(date, units);
    }
  }
  return out;
}
