import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canRenderGameChat } from "../../src/lib/game-chat-visibility";

assert.equal(canRenderGameChat({ status: "ready", visible: true }), true);
assert.equal(canRenderGameChat({ status: "ready", visible: false }), false);
assert.equal(canRenderGameChat({ status: "loading", visible: false }), false);
assert.equal(canRenderGameChat({ status: "error", visible: false }), false);

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
const workflow = readFileSync(".github/workflows/game-chat-visibility-gate.yml", "utf8");
const browser = readFileSync("scripts/qa/ui-smoke-game-chat-visibility.mjs", "utf8");
const gateTiers = JSON.parse(readFileSync("scripts/qa/gate-tiers.json", "utf8")) as {
  gates: Array<{ name: string; tier: string }>;
};
assert.ok(
  gateTiers.gates.some((g) => g.name === "qa:game-chat-visibility"),
  "pure gate must be registered in gate-tiers manifest",
);
assert.match(workflow, /npm run qa:game-chat-visibility/, "required workflow must run pure gate");
assert.match(workflow, /npm run qa:ui:game-chat-visibility/, "required workflow must run browser gate");
assert.match(browser, /document\.body\.classList\.contains\("kbd-open"\)/, "browser gate must assert keyboard focus cleanup");
assert.match(browser, /다른 계정 설정은 영향 없어야 한다/, "auth actual must assert account isolation");
assert.match(browser, /PUT 실패 시 ON rollback/, "auth actual must assert failed-save rollback");
assert.match(browser, /profile postcondition/, "auth actual cleanup must fail-close with postcondition");

console.log("game-chat-visibility-smoke: PASS (render 4/4 + required/auth wiring)");
