import assert from "node:assert/strict";
import {
  GIPHY_DEFAULT_COOLDOWN_MS,
  GIPHY_MIN_QUERY_LENGTH,
  GIPHY_SEARCH_DEBOUNCE_MS,
  getGiphyApiKey,
  getGiphyCooldownRemainingMs,
  normalizeGiphyQuery,
  parseRetryAfterMs,
  resetGiphyCooldownsForTest,
  startGiphyCooldown,
} from "../../src/lib/community/giphy-request";

assert.equal(GIPHY_SEARCH_DEBOUNCE_MS, 700);
assert.equal(GIPHY_MIN_QUERY_LENGTH, 2);
assert.equal(normalizeGiphyQuery("  승리  "), "승리");
assert.equal(parseRetryAfterMs("12", 1_000), 12_000);
assert.equal(parseRetryAfterMs("invalid", 1_000), null);

process.env.NEXT_PUBLIC_GIPHY_WEB_COMMUNITY_API_KEY = "web-community";
process.env.NEXT_PUBLIC_GIPHY_IOS_GAME_CHAT_API_KEY = "ios-game-chat";
process.env.NEXT_PUBLIC_GIPHY_ANDROID_STICKERS_API_KEY = "android-stickers";
assert.equal(getGiphyApiKey("community_gif", "web"), "web-community");
assert.equal(getGiphyApiKey("game_chat_gif", "ios"), "ios-game-chat");
assert.equal(getGiphyApiKey("editor_sticker", "android"), "android-stickers");

resetGiphyCooldownsForTest();
const now = 10_000;
assert.equal(startGiphyCooldown("community_gif", null, now), GIPHY_DEFAULT_COOLDOWN_MS);
assert.equal(getGiphyCooldownRemainingMs("community_gif", now + 1_000), 59_000);
assert.equal(getGiphyCooldownRemainingMs("editor_sticker", now + 1_000), 0);

console.log("PASS giphy request budget helper");
