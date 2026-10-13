const PUBLIC_API_PATHS = new Set(["/api/stats", "/api/news/discussion/counts"]);

/**
 * Default OFF: no response/header changes. This does not enable Cloudflare rules.
 *
 * With opt-in, move (do not copy) the EXISTING remaining shared-cache lifetime
 * from Vercel to Cloudflare for eligible responses only. Those responses disable
 * the inner cache and browser storage. Ineligible responses retain their existing
 * browser/Vercel cache contract and deny storage only at Cloudflare.
 * Thus an old Vercel HIT cannot be cached again
 * for a fresh full TTL. Redeploy/purge old entries before activating the rules.
 *
 * Cloudflare lookup-time Cookie/Authorization/HTML/RSC/image bypass rules are
 * still required: a cached response does not execute this function again.
 */
export function withCloudflarePublicCache<T extends Response>(request: Request, response: T): T {
  if (process.env.CLOUDFLARE_PUBLIC_API_CACHE !== "1") return response;

  const original = response.headers.get("Cache-Control") ?? "";
  const url = new URL(request.url);
  const sharedTtls = original.split(",").map((part) => part.trim()).filter((part) => /^s-maxage\b/i.test(part));
  const lifetime = sharedTtls.length === 1 ? /^s-maxage=(\d+)$/i.exec(sharedTtls[0]) : null;
  const ttl = lifetime ? Number(lifetime[1]) : 0;
  const eligible = (url.hostname === "keubo.fan" || url.hostname === "www.keubo.fan")
    && PUBLIC_API_PATHS.has(url.pathname)
    && (request.method === "GET" || request.method === "HEAD")
    && !request.headers.has("authorization") && !request.headers.has("cookie")
    && !request.headers.has("rsc") && !request.headers.has("next-router-state-tree")
    && !request.headers.has("next-router-prefetch") && !url.searchParams.has("_rsc")
    && response.status === 200
    && response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json"
    && !response.headers.has("set-cookie") && !response.headers.has("vary")
    && /(?:^|,)\s*public\s*(?:,|$)/i.test(original)
    && !/(?:^|,)\s*(?:private|no-store|no-cache|stale-while-revalidate|stale-if-error)\b/i.test(original)
    && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 3600;

  if (!eligible) {
    // Do not turn Cookie/auth bypass into an unnecessary Vercel cache MISS.
    // A generic CDN-Cache-Control override would also affect Vercel: use CF only.
    response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    return response;
  }

  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Vercel-CDN-Cache-Control", "no-store");
  response.headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${ttl}, must-revalidate`);
  return response;
}
