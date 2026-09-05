export const GIPHY_SEARCH_DEBOUNCE_MS = 700;
export const GIPHY_MIN_QUERY_LENGTH = 2;
export const GIPHY_DEFAULT_COOLDOWN_MS = 60_000;

export type GiphyRequestContext = "community_gif" | "editor_sticker";
export type GiphyEndpoint = "trending" | "search";

const cooldownUntilByContext = new Map<GiphyRequestContext, number>();

export function normalizeGiphyQuery(query: string): string {
  return query.trim();
}

export function getGiphyCooldownRemainingMs(
  context: GiphyRequestContext,
  now = Date.now(),
): number {
  return Math.max(0, (cooldownUntilByContext.get(context) ?? 0) - now);
}

export function startGiphyCooldown(
  context: GiphyRequestContext,
  retryAfter: string | null,
  now = Date.now(),
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfter, now);
  const durationMs = retryAfterMs ?? GIPHY_DEFAULT_COOLDOWN_MS;
  cooldownUntilByContext.set(context, now + durationMs);
  return durationMs;
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - now);
}

export async function hashGiphyQuery(query: string): Promise<string | undefined> {
  const normalized = normalizeGiphyQuery(query).toLocaleLowerCase("ko-KR");
  if (!normalized || typeof crypto === "undefined" || !crypto.subtle) return undefined;

  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Test-only reset. Do not use this to bypass a production cooldown. */
export function resetGiphyCooldownsForTest(): void {
  cooldownUntilByContext.clear();
}
