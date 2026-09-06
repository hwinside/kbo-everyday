import { BlockList, isIP } from "node:net";

type IpRequest = { headers: Headers; url: string };
type IpOptions = { fallback?: string; allowRealIp?: boolean };

// Cloudflare's published proxy ranges, checked 2026-09-06. Recheck before cutover.
// https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
] as const;
let cloudflarePeers: BlockList | undefined;

function isSingleIp(ip: string): boolean {
  // node:net accepts IPv6 zone identifiers; they are not public client identities.
  return !ip.includes("%") && isIP(ip) !== 0;
}

function isCloudflarePeer(ip: string): boolean {
  const family = isIP(ip);
  if (!isSingleIp(ip)) return false; // No lists, ports or malformed headers.
  if (!cloudflarePeers) {
    cloudflarePeers = new BlockList();
    for (const range of CLOUDFLARE_RANGES) {
      const [address, prefix] = range.split("/");
      cloudflarePeers.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
    }
  }
  return cloudflarePeers.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Default OFF: preserve each caller's existing XFF / optional real-IP fallback.
 * Never trust cf-connecting-ip merely because that header is present.
 *
 * Opt-in relies on Vercel's platform-owned x-vercel-forwarded-for peer address,
 * NOT caller-controlled XFF or cf-ray. Direct/preview/non-Vercel requests cannot
 * opt in. Verify overwritten-header behavior on the deployment before enabling.
 * https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
 */
export function getClientIp(request: IpRequest, options: IpOptions = {}): string {
  const legacy = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || (options.allowRealIp ? request.headers.get("x-real-ip") : null)
    || (options.fallback ?? "unknown");

  if (process.env.CLOUDFLARE_TRUST_CLIENT_IP !== "1" || process.env.VERCEL !== "1") {
    return legacy;
  }
  const peer = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  const trustedFallback = isSingleIp(peer) ? peer : (options.fallback ?? "unknown");
  const hostname = new URL(request.url).hostname;
  if (hostname !== "keubo.fan" && hostname !== "www.keubo.fan") return trustedFallback;
  if (!isCloudflarePeer(peer)) return trustedFallback;
  const client = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  return isSingleIp(client) ? client : trustedFallback;
}
