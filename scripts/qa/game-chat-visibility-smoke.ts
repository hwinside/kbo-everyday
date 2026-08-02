import assert from "node:assert/strict";
import { canRenderGameChat } from "../../src/lib/game-chat-visibility";

assert.equal(canRenderGameChat({ status: "ready", visible: true }), true);
assert.equal(canRenderGameChat({ status: "ready", visible: false }), false);
assert.equal(canRenderGameChat({ status: "loading", visible: false }), false);
assert.equal(canRenderGameChat({ status: "error", visible: false }), false);

console.log("game-chat-visibility-smoke: PASS (4/4)");
