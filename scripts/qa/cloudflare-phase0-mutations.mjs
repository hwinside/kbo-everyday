/** Reviewer runs baseline + real-module mutations; never edits the working tree. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reviewRoot = process.env.OPENCLAW_REVIEW_ROOT;
assert.ok(reviewRoot, "OPENCLAW_REVIEW_ROOT is required (no /tmp fallback)");
const scratch = mkdtempSync(join(reviewRoot, "cloudflare-mutations."));
const mutations = [
  ["IP flag OFF protection", "client-ip.ts", 'process.env.CLOUDFLARE_TRUST_CLIENT_IP !== "1"', "false"],
  ["Vercel-only trust", "client-ip.ts", ' || process.env.VERCEL !== "1"', ""],
  ["trusted ingress CIDR", "client-ip.ts", "if (!isCloudflarePeer(peer))", "if (false)"],
  ["single valid client IP", "client-ip.ts", "return isSingleIp(client) ? client", "return true ? client"],
  ["cache flag OFF protection", "cloudflare-cache.ts", 'if (process.env.CLOUDFLARE_PUBLIC_API_CACHE !== "1") return response;', "/* flag removed */"],
  ["Cookie bypass", "cloudflare-cache.ts", ' && !request.headers.has("cookie")', ""],
  ["single cache layer", "cloudflare-cache.ts", 'set("Vercel-CDN-Cache-Control", "no-store")', 'set("Vercel-CDN-Cache-Control", "public, s-maxage=60")'],
  ["remaining TTL not refreshed", "cloudflare-cache.ts", 'max-age=${ttl}', 'max-age=60'],
];

async function runCase(mutation, index) {
  let replaced = false;
  const outfile = join(scratch, `case-${index}.mjs`);
  await build({
    entryPoints: [join(root, "scripts/qa/cloudflare-phase0.ts")], outfile,
    bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: mutation ? [{
      name: "mutate-real-helper",
      setup(builder) {
        builder.onLoad({ filter: /src\/lib\/http\/(client-ip|cloudflare-cache)\.ts$/ }, (args) => {
          let contents = readFileSync(args.path, "utf8");
          if (args.path.endsWith(`/${mutation[1]}`)) {
            assert.equal(contents.split(mutation[2]).length - 1, 1, `unique anchor: ${mutation[0]}`);
            contents = contents.replace(mutation[2], mutation[3]); replaced = true;
          }
          return { contents, loader: "ts", resolveDir: dirname(args.path) };
        });
      },
    }] : [],
  });
  if (mutation) assert.ok(replaced, `mutation applied: ${mutation[0]}`);
  const result = spawnSync(process.execPath, [outfile], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  if (!mutation) {
    assert.equal(result.status, 0, `baseline failed:\n${result.stdout}\n${result.stderr}`);
    console.log("BASELINE PASS");
  } else {
    assert.notEqual(result.status, 0, `SURVIVED: ${mutation[0]}`);
    assert.match(result.stderr, /AssertionError/, `not a contract assertion: ${mutation[0]}`);
    console.log(`MUTATION RED: ${mutation[0]}`);
  }
}

try {
  await runCase(null, 0);
  for (let i = 0; i < mutations.length; i++) await runCase(mutations[i], i + 1);
  console.log(`${mutations.length}/${mutations.length} mutations rejected; live QA still required.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
