#!/usr/bin/env node
// scripts/hero/run-batch.mjs
//
// Phase 2 batch driver — detect-missing → fetch-source → generate-candidate → contact-sheet.
// 단일 진입점. GH Actions에서 그대로 호출 (Phase 3).
//
// 동작 (어드민 승인 큐 모델):
//   - reason=no_webp        → 신규 생성 (Nano Banana → remove.bg → face_detect → cwebp)
//   - reason=generated_unapproved → *재생성 안 함* (기존 webp/hero를 review_existing 항목으로 contact sheet 노출)
//   - --regenerate-existing 명시 시에만 generated_unapproved도 재생성 (admin 의식적 재시도)
//
// 사용 (`--key value` 와 `--key=value` 둘 다 지원):
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run --limit 5
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run --kbo-ids 50157,55502
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run --only-reason no_webp --limit 10
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run --reuse-existing --skip-nano
//   node scripts/hero/run-batch.mjs --out-dir /tmp/hero-run --regenerate-existing --kbo-ids 64004
//
// 출력:
//   <out-dir>/manifest.json    items + summary
//   <out-dir>/contact-sheet.jpg
//   <out-dir>/{raw,alpha,hero,webp,meta}/{kboId}.{png|webp|json}  (생성 항목만)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// `--key=value` 와 `--key value` 둘 다 지원. boolean flag는 다음 토큰이 또 다른 --key거나 끝일 때.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = args["out-dir"];
if (!outDir) {
  console.error(
    "usage: --out-dir <path> [--limit N] [--kbo-ids id,id] [--only-reason no_webp|generated_unapproved] " +
    "[--regenerate-existing] [--reuse-existing] [--skip-nano] [--skip-remove-bg]"
  );
  process.exit(64);
}
mkdirSync(outDir, { recursive: true });

const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
const limit = args["limit"] ? Number(args["limit"]) : null;
const onlyReason = args["only-reason"] || null;
const explicitIds = args["kbo-ids"] ? String(args["kbo-ids"]).split(",").map((s) => s.trim()).filter(Boolean) : null;
const regenerateExisting = args["regenerate-existing"] === true || args["regenerate-existing"] === "true";
const reuseExisting = args["reuse-existing"] === true || args["reuse-existing"] === "true";
const skipNano = args["skip-nano"] === true || args["skip-nano"] === "true";
const skipRemoveBg = args["skip-remove-bg"] === true || args["skip-remove-bg"] === "true";

// === 1) detect candidates ===
const detectArgs = ["scripts/hero/detect-missing-hero.mjs"];
if (onlyReason) detectArgs.push(`--only=${onlyReason}`);
const detectRaw = execFileSync("node", detectArgs, { cwd: ROOT }).toString();
const detect = JSON.parse(detectRaw);
let candidates = detect.candidates || [];
if (explicitIds) {
  const set = new Set(explicitIds);
  candidates = candidates.filter((c) => set.has(c.kboId));
  // 명시 ID가 detect 결과에 없으면 (예: 이미 approved) — 최소 정보로 보강
  const found = new Set(candidates.map((c) => c.kboId));
  for (const id of explicitIds) {
    if (!found.has(id)) candidates.push({ kboId: id, name: null, team: null, position: null, reason: "explicit" });
  }
}
if (limit && candidates.length > limit) candidates = candidates.slice(0, limit);

console.error(`[run-batch] runId=${runId} target=${candidates.length} (totalCandidates=${detect.candidatesCount}) regenExisting=${regenerateExisting}`);

const items = [];
for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  const t0 = Date.now();
  const reviewOnly = c.reason === "generated_unapproved" && !regenerateExisting;
  const tag = reviewOnly ? "review-only" : "generate";
  console.error(`[${i + 1}/${candidates.length}] ${c.kboId} ${c.team || ""} ${c.name || ""} (${tag})`);

  // === 2) source jpg lookup ===
  // 신규 생성/재생성: fetch-source-photo.mjs로 CDN까지 fallback
  // review-only: committed `public/players/{id}.jpg` 만 (CDN HEAD 비용 절약)
  let sourceJpg = null;
  if (reviewOnly) {
    const committed = resolve(ROOT, "public/players", `${c.kboId}.jpg`);
    if (existsSync(committed)) sourceJpg = committed;
  } else {
    const fetchOut = join(outDir, "source");
    mkdirSync(fetchOut, { recursive: true });
    const fetchChild = spawnSync("node", [
      "scripts/hero/fetch-source-photo.mjs",
      c.kboId,
      `--out-dir=${fetchOut}`,
    ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let fetchData = null;
    try { fetchData = JSON.parse(fetchChild.stdout.toString().trim().split("\n").pop()); } catch { /* ignore */ }
    if (fetchChild.status !== 0 || !fetchData || fetchData.status === "no_src") {
      items.push({
        kboId: c.kboId, name: c.name, team: c.team, position: c.position,
        reason: c.reason,
        status: "failed", failure_reason: "no_src_jpg",
        attempted: fetchData ? fetchData.attempted : null,
        duration_ms: Date.now() - t0,
      });
      continue;
    }
    sourceJpg = fetchData.path;
  }

  // === 3) review-only path (no Nano Banana / remove.bg cost) ===
  if (reviewOnly) {
    const existingHeroPng = resolve(ROOT, "public/players-hero-v2/png", `${c.kboId}.png`);
    const existingWebp = resolve(ROOT, "public/players-hero-v2/webp", `${c.kboId}.webp`);
    items.push({
      kboId: c.kboId, name: c.name, team: c.team, position: c.position,
      reason: c.reason,
      source_jpg: sourceJpg,
      hero_png: existsSync(existingHeroPng) ? existingHeroPng : null,
      hero_webp: existsSync(existingWebp) ? existingWebp : null,
      status: "review_existing",
      duration_ms: Date.now() - t0,
    });
    continue;
  }

  // === 4) generate candidate ===
  const genArgs = [
    "scripts/hero/generate-candidate.mjs",
    `--kbo-id=${c.kboId}`,
    `--name=${c.name || ""}`,
    `--team=${c.team || ""}`,
    `--position=${c.position || ""}`,
    `--source-jpg=${sourceJpg}`,
    `--out-dir=${outDir}`,
  ];
  if (reuseExisting) genArgs.push("--reuse-existing");
  if (skipNano) genArgs.push("--skip-nano");
  if (skipRemoveBg) genArgs.push("--skip-remove-bg");

  const genChild = spawnSync("node", genArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let genData = null;
  try { genData = JSON.parse(genChild.stdout.toString().trim().split("\n").pop()); } catch { /* ignore */ }

  if (genChild.status !== 0 || !genData || genData.status !== "ok") {
    items.push({
      kboId: c.kboId, name: c.name, team: c.team, position: c.position,
      reason: c.reason,
      source_jpg: sourceJpg,
      status: "failed",
      failure_reason: genData ? genData.reason : "generate_unknown_error",
      stderr: genChild.stderr ? genChild.stderr.toString().slice(-1500) : null,
      duration_ms: Date.now() - t0,
    });
    continue;
  }
  items.push({
    kboId: c.kboId, name: c.name, team: c.team, position: c.position,
    reason: c.reason,
    source_jpg: sourceJpg,
    raw_png: genData.outputs.raw,
    alpha_png: genData.outputs.alpha,
    hero_png: genData.outputs.hero,
    hero_webp: genData.outputs.webp,
    face: genData.face,
    status: "ok",
    duration_ms: genData.duration_ms,
  });
}

// === 5) manifest ===
const summary = {
  target: candidates.length,
  ok: items.filter((i) => i.status === "ok").length,
  review_existing: items.filter((i) => i.status === "review_existing").length,
  failed: items.filter((i) => i.status === "failed").length,
  by_failure_reason: items.reduce((acc, i) => {
    if (i.status !== "failed") return acc;
    const r = i.failure_reason || "unknown";
    acc[r] = (acc[r] || 0) + 1;
    return acc;
  }, {}),
};
const manifest = {
  runId,
  generatedAt: new Date().toISOString(),
  outDir,
  flags: { regenerateExisting, reuseExisting, skipNano, skipRemoveBg },
  detectSummary: {
    totalRoster: detect.totalRoster,
    candidatesCount: detect.candidatesCount,
    reasons: detect.reasons,
  },
  items,
  summary,
};
const manifestPath = join(outDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// === 6) contact sheet ===
const sheetPath = join(outDir, "contact-sheet.jpg");
const sheetChild = spawnSync("python3", [
  resolve(__dirname, "contact_sheet.py"),
  "--manifest", manifestPath,
  "--out", sheetPath,
], { stdio: ["ignore", "pipe", "pipe"] });
const sheetOk = sheetChild.status === 0 && existsSync(sheetPath);

console.error(`[run-batch] done ok=${summary.ok} review-only=${summary.review_existing} failed=${summary.failed} (target=${summary.target})`);
console.error(`[run-batch] manifest: ${manifestPath}`);
console.error(`[run-batch] contact-sheet: ${sheetOk ? sheetPath : "FAILED"}`);
if (!sheetOk) console.error(sheetChild.stderr ? sheetChild.stderr.toString() : "");

process.stdout.write(JSON.stringify({
  runId,
  manifest: manifestPath,
  contact_sheet: sheetOk ? sheetPath : null,
  summary,
}) + "\n");
