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

// 크관 자동 포커싱 토글 (PR #1291) — 삼순 4·5차: workflow 결속이 빠지면 RED가 되도록 assertion.
// pull_request·push 양쪽 paths 모두에 있어야 하므로 등장 횟수 >= 2 강제(삼순 5차).
for (const autofocusPath of [
  "src/hooks/useKgwanAutoFocus.ts",
  "src/app/qa/kgwan-autofocus/**",
  "scripts/qa/kgwan-autofocus-gate.mjs",
  "src/components/game/LivePitchByPitch.tsx",
]) {
  const occurrences = workflow.split(autofocusPath).length - 1;
  assert.ok(
    occurrences >= 2,
    `${autofocusPath} must be listed in both pull_request and push paths (found ${occurrences})`,
  );
}
assert.match(workflow, /npm run qa:kgwan-autofocus && npm run qa:kgwan-autofocus:selftest/, "required workflow must run autofocus gate + selftest");
assert.match(
  workflow,
  /npx eslint --quiet[^\n]*src\/hooks\/useKgwanAutoFocus\.ts[^\n]*src\/app\/qa\/kgwan-autofocus[^\n]*scripts\/qa\/kgwan-autofocus-gate\.mjs/,
  "focused lint must cover autofocus hook, fixture dir, and gate",
);
assert.ok(
  (pkg.scripts["qa:live-multiplex:ci"] ?? "").includes("--ci"),
  "qa:live-multiplex:ci must pass --ci (ambient VERCEL=1이 CI 실판정을 SKIP시키면 안 된다)",
);
assert.ok(
  gateTiers.gates.some((g) => g.name === "qa:kgwan-autofocus"),
  "autofocus pure gate must be registered in gate-tiers manifest",
);
assert.ok(
  gateTiers.gates.some((g) => g.name === "qa:kgwan-autofocus:selftest"),
  "autofocus selftest must be registered in gate-tiers manifest",
);
assert.ok(
  gateTiers.gates.some((g) => g.name === "qa:live-multiplex:ci" && g.tier === "ci"),
  "live-multiplex 실판정이 base 확보 가능한 CI 티어에 등재되어야 한다(Vercel은 base 불가 → SKIP)",
);
assert.match(browser, /자동 포커싱 끄기/, "browser gate must exercise autofocus toggle");
assert.match(browser, /setItem blocked/, "browser gate must exercise localStorage.setItem throw actual");
assert.match(browser, /document\.body\.classList\.contains\("kbd-open"\)/, "browser gate must assert keyboard focus cleanup");
assert.match(browser, /다른 계정 설정은 영향 없어야 한다/, "auth actual must assert account isolation");
assert.match(browser, /PUT 실패 시 ON rollback/, "auth actual must assert failed-save rollback");
assert.match(browser, /profile postcondition/, "auth actual cleanup must fail-close with postcondition");

console.log("game-chat-visibility-smoke: PASS (render 4/4 + required/auth wiring)");
