/**
 * Runtime feature switches (no redeploy).
 *
 * Why Redis and not an env var: a Vercel environment-variable change only takes
 * effect on the next deployment, so it cannot stop a feature during a live game.
 * The relay shared cache (#1578) already runs on Upstash, so the same store gives
 * an operator a switch that every running instance sees within SWITCH_TTL_MS.
 *
 * Fail-open by contract: an unreachable/garbled store must NOT silently disable a
 * feature, because that would turn a cache outage into a product outage. Only an
 * explicit "off" value disables. Disabling is the operator's deliberate act.
 *
 * Keys are namespaced per environment so Preview can never flip production.
 */
export type FeatureSwitch = "relay-events" | "game-summary";

/** Operators flip a switch between polls; instances converge within this window. */
export const SWITCH_TTL_MS = 10_000;
const SWITCH_TIMEOUT_MS = 400;

export type SwitchCommand = (args: (string | number)[], signal: AbortSignal) => Promise<unknown>;

type CacheEntry = { disabled: boolean; readAtMs: number };
const cache = new Map<string, CacheEntry>();

/** Test seam only: drops the in-process TTL cache. */
export function resetFeatureSwitchCache() {
  cache.clear();
}

function switchKey(name: FeatureSwitch): string {
  const environment = process.env.VERCEL_ENV ?? "development";
  return `kbo:switch:v1:${environment}:${name}`;
}

async function redisCommand(args: (string | number)[], signal: AbortSignal): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("feature switch store unavailable");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error("feature switch store HTTP error");
  const payload = await res.json();
  if (payload.error) throw new Error("feature switch command failed");
  return payload.result;
}

/** Only the exact strings "off"/"0"/"false"/"disabled" disable; anything else keeps the feature on. */
function parseSwitch(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "disabled";
}

/**
 * True when an operator has explicitly turned the feature off.
 * Never throws: store failures leave the feature enabled.
 */
export async function isFeatureDisabled(
  name: FeatureSwitch,
  opts: { command?: SwitchCommand; nowMs?: number } = {},
): Promise<boolean> {
  const key = switchKey(name);
  const now = opts.nowMs ?? Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.readAtMs >= 0 && now - hit.readAtMs < SWITCH_TTL_MS) return hit.disabled;
  const command = opts.command ?? redisCommand;
  try {
    const raw = await command(["GET", key], AbortSignal.timeout(SWITCH_TIMEOUT_MS));
    const disabled = parseSwitch(raw);
    cache.set(key, { disabled, readAtMs: now });
    return disabled;
  } catch {
    // Keep serving. A stale "disabled" reading is also not extended past its TTL.
    cache.set(key, { disabled: false, readAtMs: now });
    return false;
  }
}
