import assert from "node:assert/strict";
import {
  parseCsDraftKind,
  storePlatformFromCsId,
  validateStoreDraftBody,
} from "../../src/lib/cs/store-review-draft";

assert.equal(parseCsDraftKind("store_review"), "store_review");
assert.equal(parseCsDraftKind("other"), "");
assert.equal(storePlatformFromCsId("store:apple:a-1:1234567890ab"), "apple");
assert.equal(storePlatformFromCsId("store:google:g-1:abcdef123456"), "google");
assert.equal(storePlatformFromCsId("dm:not-a-store-review"), null);
assert.equal(validateStoreDraftBody("store:google:g-1:abcdef123456", "가".repeat(350)), true);
assert.equal(validateStoreDraftBody("store:google:g-1:abcdef123456", "가".repeat(351)), false);
assert.equal(validateStoreDraftBody("store:apple:a-1:abcdef123456", "공개 답변"), true);
assert.equal(validateStoreDraftBody("store:apple:a-1:abcdef123456", "  "), false);

console.log("9/9 CS store draft smoke tests passed");
