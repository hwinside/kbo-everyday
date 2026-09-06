/** Offline security/cache contract. Execution and QA verdict belong to the reviewer. */
import assert from "node:assert/strict";
import { getClientIp } from "../../src/lib/http/client-ip";
import { withCloudflarePublicCache } from "../../src/lib/http/cloudflare-cache";

const envNames = ["VERCEL", "CLOUDFLARE_TRUST_CLIENT_IP", "CLOUDFLARE_PUBLIC_API_CACHE"] as const;
const previous = envNames.map((name) => process.env[name]);
let passed = 0;
function check(name: string, run: () => void) {
  run(); passed++; console.log(`PASS ${name}`);
}
function request(headers: Record<string, string> = {}, path = "/api/stats", method = "GET", host = "keubo.fan") {
  return new Request(`https://${host}${path}`, { method, headers });
}
function json(cache = "public, s-maxage=60", status = 200, headers: Record<string, string> = {}) {
  return Response.json({ counts: { article: 2 } }, { status, headers: { "Cache-Control": cache, ...headers } });
}
const cfHeaders = {
  "x-vercel-forwarded-for": "173.245.48.1",
  "x-forwarded-for": "198.51.100.99",
  "cf-connecting-ip": "203.0.113.7",
};

try {
  for (const name of envNames) delete process.env[name];
  process.env.VERCEL = "1"; // OFF must hold on the production platform too.
  check("OFF preserves legacy first XFF, real-IP opt-in and empty watch fallback", () => {
    assert.equal(getClientIp(request({ ...cfHeaders, "x-forwarded-for": " 198.51.100.2, 192.0.2.2" })), "198.51.100.2");
    assert.equal(getClientIp(request({ "x-real-ip": "192.0.2.8" })), "unknown");
    assert.equal(getClientIp(request({ "x-real-ip": "192.0.2.8" }), { allowRealIp: true }), "192.0.2.8");
    assert.equal(getClientIp(request(), { fallback: "" }), "");
  });
  check("OFF leaves response object, status and every header unchanged", () => {
    for (const flag of [undefined, "0", "false"]) {
      if (flag === undefined) delete process.env.CLOUDFLARE_PUBLIC_API_CACHE;
      else process.env.CLOUDFLARE_PUBLIC_API_CACHE = flag;
      for (const headers of [{}, { cookie: "fixture=1" }] as Record<string, string>[]) {
        const response = json("public, s-maxage=60", 200, {
          "CDN-Cache-Control": "public, s-maxage=45",
          "Vercel-CDN-Cache-Control": "public, s-maxage=30",
          "Cloudflare-CDN-Cache-Control": "public, max-age=15",
        });
        const before = [...response.headers];
        assert.equal(withCloudflarePublicCache(request(headers), response), response);
        assert.deepEqual([...response.headers], before);
        assert.equal(response.status, 200);
      }
    }
    delete process.env.CLOUDFLARE_PUBLIC_API_CACHE;
  });
  process.env.CLOUDFLARE_TRUST_CLIENT_IP = "1";
  delete process.env.VERCEL;
  check("non-Vercel origin cannot trust a forged platform/CF header", () => {
    assert.equal(getClientIp(request(cfHeaders)), "198.51.100.99");
  });
  process.env.VERCEL = "1";
  check("trusted IPv4 and IPv6 ingress accepts a single client IP", () => {
    assert.equal(getClientIp(request(cfHeaders)), "203.0.113.7");
    assert.equal(getClientIp(request({ ...cfHeaders, "x-vercel-forwarded-for": "2606:4700::1", "cf-connecting-ip": "2001:db8::7" })), "2001:db8::7");
  });
  check("direct and preview origins ignore forged CF and XFF values", () => {
    assert.equal(getClientIp(request({ ...cfHeaders, "x-vercel-forwarded-for": "192.0.2.1" })), "192.0.2.1");
    assert.equal(getClientIp(request(cfHeaders, "/api/stats", "GET", "preview.vercel.app")), "173.245.48.1");
  });
  check("missing, malformed or multi-valued platform peer fails closed", () => {
    for (const peer of ["", "bad", "173.245.48.1, 192.0.2.1", "173.245.48.1:443", "2606:4700::1%eth0"]) {
      assert.equal(getClientIp(request({ ...cfHeaders, "x-vercel-forwarded-for": peer })), "unknown");
    }
  });
  check("Cloudflare IPv4/IPv6 CIDR boundaries are not broad trust-all", () => {
    for (const peer of ["173.245.47.255", "173.245.64.0", "2606:46ff:ffff::1", "2606:4701::1"]) {
      assert.equal(getClientIp(request({ ...cfHeaders, "x-vercel-forwarded-for": peer })), peer);
    }
    assert.equal(getClientIp(request({ ...cfHeaders, "x-vercel-forwarded-for": "173.245.63.255" })), "203.0.113.7");
  });
  check("bad CF client values cannot select a rate-limit bucket", () => {
    for (const client of ["", "bad", "203.0.113.1, 203.0.113.2", "203.0.113.1:80", "2001:db8::1%eth0"]) {
      assert.equal(getClientIp(request({ ...cfHeaders, "cf-connecting-ip": client })), "173.245.48.1");
    }
  });

  process.env.CLOUDFLARE_PUBLIC_API_CACHE = "1";
  check("remaining TTL transfers to CF, inner CDN/browser cannot store", () => {
    for (const path of ["/api/stats?type=batting&full=1", "/api/news/discussion/counts?u=fixture"]) {
      for (const ttl of [1, 7, 60, 3600]) {
        const response = withCloudflarePublicCache(request({}, path), json(`public, s-maxage=${ttl}`));
        assert.equal(response.headers.get("Cloudflare-CDN-Cache-Control"), `public, max-age=${ttl}, must-revalidate`);
        assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), "no-store");
        assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
      }
    }
  });
  check("HEAD can use the same public lifetime", () => {
    assert.match(withCloudflarePublicCache(request({}, "/api/stats", "HEAD"), json()).headers.get("Cloudflare-CDN-Cache-Control")!, /max-age=60/);
  });
  function bypass(req: Request, response = json()) {
    const expectedHeaders = new Headers(response.headers);
    expectedHeaders.set("Cloudflare-CDN-Cache-Control", "no-store");
    const requestHeaders = [...req.headers];
    const body = response.body;
    const status = response.status;
    const result = withCloudflarePublicCache(req, response);
    assert.equal(result, response);
    assert.equal(result.body, body);
    assert.equal(result.bodyUsed, false);
    assert.equal(result.status, status);
    assert.equal(result.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
    assert.deepEqual([...result.headers], [...expectedHeaders], "only the CF-specific policy may change");
    assert.deepEqual([...req.headers], requestHeaders, "Cookie/Authorization must not be stripped");
  }
  check("Cookie/Authorization and every RSC discriminator bypass", () => {
    for (const name of ["cookie", "authorization", "rsc", "next-router-state-tree", "next-router-prefetch"]) {
      bypass(request({ [name]: "fixture" })); bypass(request({ [name]: "" }));
    }
    bypass(request({}, "/api/stats?_rsc=fixture"));
  });
  check("ineligible public/private cache policies keep every original downstream header", () => {
    const policies: Record<string, string>[] = [
      { "Cache-Control": "public, s-maxage=7" },
      { "Cache-Control": "private, no-store, max-age=0" },
      { "CDN-Cache-Control": "public, s-maxage=23" },
      { "Vercel-CDN-Cache-Control": "public, s-maxage=11" },
      { "Vercel-CDN-Cache-Control": "no-store", "CDN-Cache-Control": "public, s-maxage=19" },
      { "Vercel-CDN-Cache-Control": "public, s-maxage=13", "CDN-Cache-Control": "no-store" },
    ];
    for (const policy of policies) {
      for (const headers of [{ cookie: "fixture=1" }, { authorization: "fixture" }] as Record<string, string>[]) {
        bypass(request(headers), json("public, s-maxage=60", 200, {
          ...policy, "Cloudflare-CDN-Cache-Control": "public, max-age=300",
          ETag: '"fixture"', "X-Contract-Fixture": "unchanged",
        }));
      }
    }
  });
  check("ineligible response without a browser TTL does not acquire a Vercel policy", () => {
    const response = Response.json({ counts: {} });
    bypass(request({ cookie: "fixture=1" }), response);
    assert.equal(response.headers.has("Cache-Control"), false);
    assert.equal(response.headers.has("CDN-Cache-Control"), false);
    assert.equal(response.headers.has("Vercel-CDN-Cache-Control"), false);
  });
  check("non-allowlisted HTML, image, live, private API, POST and preview bypass", () => {
    for (const path of ["/", "/_next/image?url=fixture", "/api/game-live", "/api/admin/auth", "/api/stats/", "/api/stats.css"]) bypass(request({}, path));
    bypass(request({}, "/api/news/discussion/counts", "POST"));
    bypass(request({}, "/api/stats", "GET", "preview.vercel.app"));
  });
  check("all errors and personalized/non-JSON responses bypass", () => {
    for (const status of [201, 400, 401, 403, 429, 500, 503]) bypass(request(), json("public, s-maxage=60", status));
    for (const headers of [{ "Set-Cookie": "fixture=1" }, { Vary: "Accept" }, { "Content-Type": "text/html" }, { "Content-Type": "text/x-component" }]) {
      bypass(request(), json("public, s-maxage=60", 200, headers));
    }
  });
  check("degraded, stale, duplicate or invalid lifetimes fail closed", () => {
    for (const cache of ["no-store", "public", "private, s-maxage=60", "public, no-cache, s-maxage=60", "public, s-maxage=0", "public, s-maxage=-1", "public, s-maxage=1.5", "public, s-maxage=3601", "public, s-maxage=60, s-maxage=120", "public, s-maxage=60, s-maxage=invalid", "public, s-maxage=60, stale-while-revalidate=1", "public, s-maxage=60, stale-if-error=1"]) bypass(request(), json(cache));
  });
  console.log(`Cloudflare Phase 0 offline contracts: ${passed} PASS; live ingress/CDN/end-user QA NOT covered.`);
} finally {
  envNames.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
}
