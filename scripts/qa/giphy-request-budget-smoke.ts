import assert from "node:assert/strict";
import {
  GIPHY_DEFAULT_COOLDOWN_MS, GIPHY_MIN_QUERY_LENGTH, GIPHY_SEARCH_DEBOUNCE_MS,
  getGiphyApiKey, getGiphyRequestConfig, getGiphyCooldownRemainingMs,
  normalizeGiphyQuery, parseRetryAfterMs, resetGiphyCooldownsForTest, startGiphyCooldown,
  type GiphyPlatform, type GiphyRequestContext,
} from "../../src/lib/community/giphy-request";

assert.equal(GIPHY_SEARCH_DEBOUNCE_MS, 700);
assert.equal(GIPHY_MIN_QUERY_LENGTH, 2);
assert.equal(normalizeGiphyQuery("  승리  "), "승리");
assert.equal(parseRetryAfterMs("12", 1_000), 12_000);
assert.equal(parseRetryAfterMs("invalid", 1_000), null);
assert.equal(parseRetryAfterMs(" ", 1_000), null);
assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT", 60_000), 60_000);
assert.equal(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:00 GMT", 60_000), 0);

const platforms: GiphyPlatform[] = ["web", "ios", "android"];
const contexts: GiphyRequestContext[] = ["community_gif", "game_chat_gif", "editor_sticker"];
const sections = ["COMMUNITY", "GAME_CHAT", "STICKERS"];
// Isolate from local/CI production configuration; these are non-production fixtures.
for (const name of Object.keys(process.env)) if (name.startsWith("NEXT_PUBLIC_GIPHY_")) delete process.env[name];
for (const platform of platforms) {
  for (const [i, context] of contexts.entries()) {
    const value = `fixture-${platform}-${context}`;
    process.env[`NEXT_PUBLIC_GIPHY_${platform.toUpperCase()}_${sections[i]}_API_KEY`] = value;
    const config = getGiphyRequestConfig(context, platform);
    assert.equal(config.apiKey, value);
    assert.equal(config.platform, platform);
    assert.equal(config.keySlot, `${platform}:${context}`);
    assert.equal(config.keySource, "platform");
    assert.equal(getGiphyApiKey(context, platform), value);
  }
}

const storage = new Map<string, string>();
Object.assign(globalThis, { window: { localStorage: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
} } });
const chat = getGiphyRequestConfig("game_chat_gif", "ios");
const community = getGiphyRequestConfig("community_gif", "ios");
const now = 10_000;
assert.equal(startGiphyCooldown(chat, null, now), GIPHY_DEFAULT_COOLDOWN_MS);
assert.equal(GIPHY_DEFAULT_COOLDOWN_MS, 300_000);
assert.equal(getGiphyCooldownRemainingMs(chat, now + 1_000), 299_000);
assert.equal(getGiphyCooldownRemainingMs(community, now + 1_000), 0);
resetGiphyCooldownsForTest(); // simulate fresh module after page reload
assert.equal(getGiphyCooldownRemainingMs(chat, now + 1_000), 299_000);
assert.equal(startGiphyCooldown(chat, "0", now + 2_000), 298_000, "later short responses cannot shorten cooldown");
assert.equal(startGiphyCooldown(chat, "900", now), 900_000);
assert.equal(getGiphyCooldownRemainingMs(chat, now + 900_000), 0);
assert.ok([...storage.keys()].every((key) => !key.includes("fixture-")), "storage keys contain no credential values");
assert.ok([...storage.values()].every((value) => /^\d+$/.test(value)), "only retry deadlines are stored");

// All unconfigured web contexts share the same fallback quota, not three pools.
for (const section of sections) delete process.env[`NEXT_PUBLIC_GIPHY_WEB_${section}_API_KEY`];
process.env.NEXT_PUBLIC_GIPHY_API_KEY = "fixture-legacy";
const webChat = getGiphyRequestConfig("game_chat_gif", "web");
const webCommunity = getGiphyRequestConfig("community_gif", "web");
assert.equal(webChat.keySource, "legacy_fallback");
startGiphyCooldown(webChat, "600", now);
assert.equal(getGiphyCooldownRemainingMs(webCommunity, now), 600_000, "same fallback key shares cooldown across surfaces");
assert.equal(getGiphyCooldownRemainingMs(getGiphyRequestConfig("editor_sticker", "web"), now), 600_000);
// Aliased primary variables containing the same key also share the limiter.
process.env.NEXT_PUBLIC_GIPHY_WEB_COMMUNITY_API_KEY = "fixture-legacy";
assert.equal(getGiphyRequestConfig("community_gif", "web").keySource, "platform");
assert.equal(getGiphyCooldownRemainingMs(getGiphyRequestConfig("community_gif", "web"), now), 600_000);
process.env.NEXT_PUBLIC_GIPHY_WEB_COMMUNITY_API_KEY = "   ";
assert.equal(getGiphyRequestConfig("community_gif", "web").keySource, "legacy_fallback");
// Storage denial must never break in-memory rate protection.
Object.assign(globalThis, { window: { get localStorage() { throw new Error("denied"); } } });
resetGiphyCooldownsForTest();
assert.equal(startGiphyCooldown(chat, "0", now), 60_000);
assert.equal(getGiphyCooldownRemainingMs(chat, now + 1), 59_999);
console.log("PASS GIPHY 9-slot routing, same-key cooldown, reload, Retry-After and storage denial");


async function checkPopularIds() {
  const { normalizePopularGiphyIds, loadPopularGiphyIds } = await import("../../src/lib/community/giphy");
  assert.deepEqual(normalizePopularGiphyIds(["a", "a", "b", "https://media.giphy.com/a.gif", "", null, "x".repeat(79)]), ["a", "b"]);
  assert.equal(normalizePopularGiphyIds(Array.from({ length: 100 }, (_, n) => `id${n}`)).length, 24);
  assert.deepEqual(normalizePopularGiphyIds({ ids: ["a"] }), []);
  const abortedLookup = new AbortController();
  abortedLookup.abort();
  const originalFetch = globalThis.fetch;
  let catalogFetches = 0;
  globalThis.fetch = async () => { catalogFetches++; throw new Error("aborted lookup must not fetch"); };
  try {
    assert.deepEqual(await loadPopularGiphyIds(abortedLookup.signal), []);
    assert.equal(catalogFetches, 0);
  } finally { globalThis.fetch = originalFetch; }
  console.log("PASS own popular-ID validation and pre-aborted lookup");
}
void checkPopularIds();
