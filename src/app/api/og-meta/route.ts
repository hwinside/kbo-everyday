import { NextRequest, NextResponse } from "next/server";

type OGResolution =
  | { ok: true; data: OGData }
  | { ok: false; status: number; error: string; retryable: boolean };

interface CacheEntry {
  result: OGResolution;
  expiresAt: number;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OGResolution>>();
const circuits = new Map<string, CircuitState>();
const SUCCESS_TTL = 60 * 60 * 1000;
const FAILURE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 500;
const FETCH_TIMEOUT_MS = 5000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 1000;
const CIRCUIT_MAX = 200;
const BATCH_MAX = 10;
const BATCH_CONCURRENCY = 4;

// Client/edge HTTP caches stay disabled so old null responses cannot stick on devices.
// Success/failure TTL is enforced by the bounded server-instance cache above.
const CACHE_HEADER = "private, no-store, max-age=0, must-revalidate";

/** Treat as useful OG only if at least title or image is present. */
function hasUsefulOG(d: OGData): boolean {
  return !!(d.title || d.image);
}

interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

function cachedResolution(url: string): OGResolution | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(url);
    return null;
  }
  cache.delete(url);
  cache.set(url, entry);
  return entry.result;
}

function setCachedResolution(url: string, result: OGResolution): void {
  if (cache.size >= CACHE_MAX && !cache.has(url)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const ttl = result.ok && hasUsefulOG(result.data) ? SUCCESS_TTL : FAILURE_TTL;
  cache.set(url, { result, expiresAt: Date.now() + ttl });
}

function circuitIsOpen(host: string): boolean {
  const state = circuits.get(host);
  if (!state) return false;
  if (state.openUntil === 0) return false;
  if (state.openUntil <= Date.now()) {
    circuits.delete(host);
    return false;
  }
  return true;
}

function recordCircuitSuccess(host: string): void {
  circuits.delete(host);
}

function recordCircuitFailure(host: string): void {
  const previous = circuits.get(host);
  const failures = (previous?.failures ?? 0) + 1;
  if (!previous && circuits.size >= CIRCUIT_MAX) {
    const oldest = circuits.keys().next().value;
    if (oldest) circuits.delete(oldest);
  }
  circuits.delete(host);
  circuits.set(host, {
    failures,
    openUntil: failures >= CIRCUIT_FAILURE_THRESHOLD ? Date.now() + CIRCUIT_COOLDOWN_MS : 0,
  });
}

function validateUrl(rawUrl: string): { parsed: URL } | { result: OGResolution } {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { result: { ok: false, status: 400, error: "invalid protocol", retryable: false } };
    }
    if (isBlockedHost(parsed.hostname)) {
      return { result: { ok: false, status: 403, error: "blocked host", retryable: false } };
    }
    return { parsed };
  } catch {
    return { result: { ok: false, status: 400, error: "invalid url", retryable: false } };
  }
}

async function fetchOG(parsed: URL): Promise<OGResolution> {
  const url = parsed.href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // YouTube shortcut — oEmbed API returns clean metadata without 1MB+ HTML fetch.
    const ytId = extractYouTubeId(parsed);
    if (ytId) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`;
        const response = await fetch(oembedUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)" },
        });
        if (response.ok) {
          const json = await response.json() as { title?: string; author_name?: string; thumbnail_url?: string };
          return {
            ok: true,
            data: {
              title: json.title || null,
              description: json.author_name ? `YouTube · ${json.author_name}` : null,
              image: json.thumbnail_url || `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`,
              siteName: "YouTube",
              url,
            },
          };
        }
      } catch {
        if (controller.signal.aborted) throw new Error("timeout");
        // Fall through to the generic page fetch.
      }
    }

    let currentUrl = parsed;
    let finalRes = await fetch(currentUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)",
        Accept: "text/html",
      },
      redirect: "manual", // Handle redirects manually for SSRF protection
    });

    // Handle redirects manually (max 3 hops)
    let redirectCount = 0;
    while (finalRes.status >= 300 && finalRes.status < 400) {
      if (redirectCount >= 3) {
        return { ok: false, status: 502, error: "too many redirects", retryable: false };
      }
      const location = finalRes.headers.get("location");
      if (!location) {
        return { ok: false, status: 502, error: "invalid redirect", retryable: false };
      }
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, status: 502, error: "invalid redirect", retryable: false };
      }
      if (!["http:", "https:"].includes(redirectUrl.protocol) || isBlockedHost(redirectUrl.hostname)) {
        return { ok: false, status: 403, error: "blocked redirect", retryable: false };
      }
      currentUrl = redirectUrl;
      finalRes = await fetch(redirectUrl.href, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)",
          Accept: "text/html",
        },
        redirect: "manual",
      });
      redirectCount++;
    }

    if (!finalRes.ok) {
      const retryable = finalRes.status === 429 || finalRes.status >= 500;
      return { ok: false, status: 502, error: "upstream fetch failed", retryable };
    }

    const contentType = finalRes.headers.get("content-type") || "";

    // Response size guard — only read up to 1MB
    const contentLength = finalRes.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 1_000_000) {
      return { ok: false, status: 502, error: "response too large", retryable: false };
    }

    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      // Not HTML/text — return minimal data
      return {
        ok: true,
        data: { title: null, description: null, image: null, siteName: currentUrl.hostname, url },
      };
    }

    // Stream body and stop at </head> or 500KB cap
    const html = await readHeadOnly(finalRes, 500_000);

    const data: OGData = {
      title: extractMeta(html, "og:title") || extractTag(html, "title"),
      description: extractMeta(html, "og:description") || extractMeta(html, "description"),
      image: extractMeta(html, "og:image"),
      siteName: extractMeta(html, "og:site_name") || currentUrl.hostname,
      url,
    };

    // Resolve relative image URLs
    if (data.image) {
      try {
        const imageUrl = new URL(data.image, currentUrl);
        data.image = ["http:", "https:"].includes(imageUrl.protocol) && !isBlockedHost(imageUrl.hostname)
          ? imageUrl.href
          : null;
      } catch {
        data.image = null;
      }
    }

    return { ok: true, data };
  } catch {
    return controller.signal.aborted
      ? { ok: false, status: 504, error: "upstream timeout", retryable: true }
      : { ok: false, status: 502, error: "upstream fetch error", retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveOG(rawUrl: string): Promise<OGResolution> {
  const validated = validateUrl(rawUrl);
  if ("result" in validated) return validated.result;

  const url = validated.parsed.href;
  const cached = cachedResolution(url);
  if (cached) return cached;

  const existing = inFlight.get(url);
  if (existing) return existing;

  const host = validated.parsed.hostname.toLowerCase();
  if (circuitIsOpen(host)) {
    return { ok: false, status: 503, error: "upstream circuit open", retryable: true };
  }

  const pending = fetchOG(validated.parsed)
    .then((result) => {
      if (result.ok) recordCircuitSuccess(host);
      else if (result.retryable) recordCircuitFailure(host);
      setCachedResolution(url, result);
      return result;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, pending);
  return pending;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url parameter required" }, { status: 400 });
  }

  const result = await resolveOG(url);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: { "Cache-Control": CACHE_HEADER } },
    );
  }
  return NextResponse.json(result.data, {
    headers: { "Cache-Control": CACHE_HEADER },
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const urls = (body as { urls?: unknown })?.urls;
  if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string")) {
    return NextResponse.json({ error: "urls must be a string array" }, { status: 400 });
  }
  if (urls.length > BATCH_MAX) {
    return NextResponse.json({ error: `maximum ${BATCH_MAX} urls` }, { status: 400 });
  }

  const uniqueUrls = Array.from(new Set(urls as string[]));
  const resolutions = await mapWithConcurrency(uniqueUrls, BATCH_CONCURRENCY, resolveOG);
  const items: Record<string, OGData | null> = {};
  uniqueUrls.forEach((url, index) => {
    const resolution = resolutions[index];
    items[url] = resolution.ok ? resolution.data : null;
  });

  return NextResponse.json({ items }, {
    headers: { "Cache-Control": CACHE_HEADER },
  });
}

/** Extract YouTube video id from youtu.be/VIDEO_ID, youtube.com/watch?v=, /embed/, /shorts/ */
function extractYouTubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const embed = u.pathname.match(/^\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (embed?.[1]) return embed[1];
  }
  return null;
}

/** Stream response body, stop at </head> or byteCap, whichever comes first. */
async function readHeadOnly(res: Response, byteCap: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, byteCap);
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      // Stop as soon as </head> shows up — OG/meta tags live inside <head>
      // Case-insensitive match for robust handling of </HEAD>, </Head>, etc.
      if (html.toLowerCase().includes("</head>")) break;
      if (bytes >= byteCap) break;
    }
    html += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return html;
}

function extractMeta(html: string, property: string): string | null {
  // Match og: properties (property="og:xxx" or name="xxx")
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegex(property)}["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return null;
}

function extractTag(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** SSRF protection — block localhost, loopback, and private network ranges */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Localhost / loopback
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "0.0.0.0" || lower === "::1" || lower === "[::1]") {
    return true;
  }

  // IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
  }

  // Metadata endpoints (cloud)
  if (lower === "metadata.google.internal" || lower.endsWith(".internal")) {
    return true;
  }

  return false;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#x0*2F;/gi, "/")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
