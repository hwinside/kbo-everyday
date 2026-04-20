import { NextRequest, NextResponse } from "next/server";

// Simple in-memory cache (per-instance, cleared on redeploy)
const cache = new Map<string, { data: OGData; ts: number }>();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

interface OGData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url parameter required" }, { status: 400 });
  }

  // Validate URL — SSRF protection
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return NextResponse.json({ error: "invalid protocol" }, { status: 400 });
    }
    if (isBlockedHost(parsed.hostname)) {
      return NextResponse.json({ error: "blocked host" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  // Check cache
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  }

  // YouTube shortcut — oEmbed API returns clean metadata without 1MB+ HTML fetch
  const ytId = extractYouTubeId(parsed);
  if (ytId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`;
      const r = await fetch(oembedUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)" },
      });
      clearTimeout(timeout);
      if (r.ok) {
        const json = await r.json() as { title?: string; author_name?: string; thumbnail_url?: string };
        const data: OGData = {
          title: json.title || null,
          description: json.author_name ? `YouTube · ${json.author_name}` : null,
          image: json.thumbnail_url || `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`,
          siteName: "YouTube",
          url,
        };
        cache.set(url, { data, ts: Date.now() });
        return NextResponse.json(data, {
          headers: { "Cache-Control": "public, max-age=3600" },
        });
      }
    } catch {
      // Fall through to generic path
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)",
        Accept: "text/html",
      },
      redirect: "manual", // Handle redirects manually for SSRF protection
    });
    clearTimeout(timeout);

    // Handle redirects manually (max 3 hops)
    let finalRes = res;
    let redirectCount = 0;
    while (finalRes.status >= 300 && finalRes.status < 400 && redirectCount < 3) {
      const location = finalRes.headers.get("location");
      if (!location) break;
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        break;
      }
      if (!["http:", "https:"].includes(redirectUrl.protocol) || isBlockedHost(redirectUrl.hostname)) {
        return NextResponse.json({ error: "blocked redirect" }, { status: 403 });
      }
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 5000);
      finalRes = await fetch(redirectUrl.href, {
        signal: controller2.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KeuboFanBot/1.0)",
          Accept: "text/html",
        },
        redirect: "manual",
      });
      clearTimeout(timeout2);
      redirectCount++;
    }

    if (!finalRes.ok && !(finalRes.status >= 300 && finalRes.status < 400)) {
      return NextResponse.json({ error: "fetch failed", status: finalRes.status }, { status: 502 });
    }

    const contentType = finalRes.headers.get("content-type") || "";

    // Response size guard — only read up to 1MB
    const contentLength = finalRes.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 1_000_000) {
      return NextResponse.json({ error: "response too large" }, { status: 502 });
    }

    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      // Not HTML/text — return minimal data
      const data: OGData = { title: null, description: null, image: null, siteName: parsed.hostname, url };
      return NextResponse.json(data);
    }

    // Stream body and stop at </head> or 500KB cap
    const html = await readHeadOnly(finalRes, 500_000);

    const data: OGData = {
      title: extractMeta(html, "og:title") || extractTag(html, "title"),
      description: extractMeta(html, "og:description") || extractMeta(html, "description"),
      image: extractMeta(html, "og:image"),
      siteName: extractMeta(html, "og:site_name") || parsed.hostname,
      url,
    };

    // Resolve relative image URLs
    if (data.image && !data.image.startsWith("http")) {
      try {
        data.image = new URL(data.image, url).href;
      } catch {
        data.image = null;
      }
    }

    // Cache result
    cache.set(url, { data, ts: Date.now() });

    // Limit cache size
    if (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: "fetch error", message: (e as Error).message },
      { status: 502 }
    );
  }
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
