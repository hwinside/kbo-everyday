import { Capacitor } from "@capacitor/core";
import { trackEvent } from "@/lib/analytics";

export const GIPHY_SEARCH_DEBOUNCE_MS = 700;
export const GIPHY_MIN_QUERY_LENGTH = 2;
// A missing Retry-After does not mean the hourly quota resets in a minute.
// This is a conservative manual-retry backoff, not a claimed reset time.
export const GIPHY_DEFAULT_COOLDOWN_MS = 5 * 60_000;
const GIPHY_MIN_COOLDOWN_MS = 60_000;
const COOLDOWN_STORAGE_PREFIX = "giphy-cooldown-v2:";

export type GiphyRequestContext = "community_gif" | "game_chat_gif" | "editor_sticker";
export type GiphyEndpoint = "trending" | "search" | "ids";
export type GiphyPlatform = "web" | "ios" | "android";

const cooldownUntilByKey = new Map<string, number>();

export interface GiphyRequestConfig {
  apiKey: string | undefined;
  context: GiphyRequestContext;
  platform: GiphyPlatform;
  keySource: "platform" | "section_fallback" | "legacy_fallback" | "missing";
  keySlot: string;
  // Non-secret canonical configuration label. Never persist the key itself.
  cooldownScope: string;
}

interface InjectedCapacitor {
  getPlatform?: () => string;
}

export function getGiphyPlatform(): GiphyPlatform {
  try {
    const corePlatform = Capacitor.getPlatform();
    if (corePlatform === "ios" || corePlatform === "android") return corePlatform;
  } catch {
    /* Fall through to the injected bridge used by the remote-loaded app. */
  }

  if (typeof window !== "undefined") {
    try {
      const injectedPlatform = (window as unknown as { Capacitor?: InjectedCapacitor })
        .Capacitor?.getPlatform?.();
      if (injectedPlatform === "ios" || injectedPlatform === "android") {
        return injectedPlatform;
      }
    } catch {
      /* Bridge failure is treated as web. */
    }
  }
  return "web";
}

export function getGiphyRequestConfig(
  context: GiphyRequestContext,
  platform = getGiphyPlatform(),
): GiphyRequestConfig {
  const platformKeys = {
    web: {
      community_gif: process.env.NEXT_PUBLIC_GIPHY_WEB_COMMUNITY_API_KEY,
      game_chat_gif: process.env.NEXT_PUBLIC_GIPHY_WEB_GAME_CHAT_API_KEY,
      editor_sticker: process.env.NEXT_PUBLIC_GIPHY_WEB_STICKERS_API_KEY,
    },
    ios: {
      community_gif: process.env.NEXT_PUBLIC_GIPHY_IOS_COMMUNITY_API_KEY,
      game_chat_gif: process.env.NEXT_PUBLIC_GIPHY_IOS_GAME_CHAT_API_KEY,
      editor_sticker: process.env.NEXT_PUBLIC_GIPHY_IOS_STICKERS_API_KEY,
    },
    android: {
      community_gif: process.env.NEXT_PUBLIC_GIPHY_ANDROID_COMMUNITY_API_KEY,
      game_chat_gif: process.env.NEXT_PUBLIC_GIPHY_ANDROID_GAME_CHAT_API_KEY,
      editor_sticker: process.env.NEXT_PUBLIC_GIPHY_ANDROID_STICKERS_API_KEY,
    },
  };

  const candidates: Array<[string, string | undefined, GiphyRequestConfig["keySource"]]> = [
    [`${platform}:${context}`, platformKeys[platform][context], "platform"],
    [context === "editor_sticker" ? "section:stickers" : "section:gifs",
      context === "editor_sticker"
        ? process.env.NEXT_PUBLIC_GIPHY_STICKERS_API_KEY
        : process.env.NEXT_PUBLIC_GIPHY_GIFS_API_KEY, "section_fallback"],
    ["legacy", process.env.NEXT_PUBLIC_GIPHY_API_KEY, "legacy_fallback"],
  ];
  const selected = candidates.find(([, value]) => value?.trim());
  const apiKey = selected?.[1]?.trim();
  const keySlot = selected?.[0] ?? "missing";
  // If several labels contain the same actual key, share its cooldown too.
  const allSlots: Array<[string, string | undefined]> = [
    ["legacy", process.env.NEXT_PUBLIC_GIPHY_API_KEY],
    ["section:gifs", process.env.NEXT_PUBLIC_GIPHY_GIFS_API_KEY],
    ["section:stickers", process.env.NEXT_PUBLIC_GIPHY_STICKERS_API_KEY],
    ...Object.entries(platformKeys).flatMap(([p, values]) =>
      Object.entries(values).map(([c, value]): [string, string | undefined] => [`${p}:${c}`, value])),
  ];
  const cooldownScope = apiKey
    ? allSlots.find(([, value]) => value?.trim() === apiKey)?.[0] ?? keySlot
    : "missing";
  return { apiKey, context, platform, keySource: selected?.[2] ?? "missing", keySlot, cooldownScope };
}

export function getGiphyApiKey(context: GiphyRequestContext, platform = getGiphyPlatform()): string | undefined {
  return getGiphyRequestConfig(context, platform).apiKey;
}

/** Captures the same platform/key selection used by this request; no key or query URL leaves this helper. */
export function trackGiphyEvent(
  event: "giphy_api_request" | "giphy_api_result",
  config: GiphyRequestConfig,
  detail: { endpoint: GiphyEndpoint; offset: number; status?: number; latency_ms?: number; query_hash?: string },
): void {
  try {
    const properties = {
      ...detail,
      context: config.context,
      giphy_platform: config.platform,
      key_source: config.keySource,
      key_slot: config.keySlot,
    };
    trackEvent(event, properties);
    // Countable via standard eventName without waiting for custom dimensions.
    if (event === "giphy_api_result" && detail.status === 429) {
      trackEvent("giphy_api_rate_limited", properties);
    }
  } catch { /* Analytics must never interrupt GIF requests or generate retries. */ }
}

export function normalizeGiphyQuery(query: string): string {
  return query.trim();
}

function cooldownScope(input: GiphyRequestContext | GiphyRequestConfig): string {
  return typeof input === "string" ? getGiphyRequestConfig(input).cooldownScope : input.cooldownScope;
}

export function getGiphyCooldownRemainingMs(
  input: GiphyRequestContext | GiphyRequestConfig,
  now = Date.now(),
): number {
  const scope = cooldownScope(input);
  let until = cooldownUntilByKey.get(scope) ?? 0;
  try {
    if (typeof window !== "undefined") {
      const stored = Number(window.localStorage.getItem(COOLDOWN_STORAGE_PREFIX + scope));
      if (Number.isFinite(stored)) until = Math.max(until, stored);
    }
  } catch { /* Private mode/storage denial: retain the in-memory guard. */ }
  if (until > now) cooldownUntilByKey.set(scope, until);
  return Math.max(0, until - now);
}

export function startGiphyCooldown(
  input: GiphyRequestContext | GiphyRequestConfig,
  retryAfter: string | null,
  now = Date.now(),
): number {
  const scope = cooldownScope(input);
  const retryAfterMs = parseRetryAfterMs(retryAfter, now);
  const durationMs = Math.max(
    GIPHY_MIN_COOLDOWN_MS,
    retryAfterMs ?? GIPHY_DEFAULT_COOLDOWN_MS,
    getGiphyCooldownRemainingMs(input, now),
  );
  const until = now + durationMs;
  cooldownUntilByKey.set(scope, until);
  try {
    // Only a retry timestamp + non-secret slot label, never responses/media/credentials.
    if (typeof window !== "undefined") window.localStorage.setItem(COOLDOWN_STORAGE_PREFIX + scope, String(until));
  } catch { /* In-memory guard remains active. */ }
  return durationMs;
}

export function giphyCooldownMessage(remainingMs: number): string {
  return `GIF 요청 한도에 도달했어요. 약 ${Math.max(1, Math.ceil(remainingMs / 60_000))}분 뒤 다시 시도해 주세요`;
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1_000)) {
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
  cooldownUntilByKey.clear();
}
