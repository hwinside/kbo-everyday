#!/usr/bin/env node
// scripts/hero/generate-candidate.mjs
//
// 단일 kboId의 hero candidate WEBP을 end-to-end 생성한다.
// Phase 2 of auto-hero-pipeline.
//
// 파이프라인:
//   1. source jpg 확보 (--source-jpg 또는 fetch-source-photo.mjs 결과)
//   2. Nano Banana Pro 2K (env: GEMINI_API_KEY, NANO_BANANA_CMD)
//   3. remove.bg HD (env: REMOVE_BG_API_KEY)
//   4. face_detect.py (Haar 3-stage + fail-closed)
//   5. cwebp lossless alpha
//
// 출력 디렉토리 구조 (--out-dir 기준):
//   raw/{kboId}.png           Nano Banana 2K opaque PNG
//   alpha/{kboId}.png         remove.bg HD RGBA PNG
//   hero/{kboId}.png          752x944 RGBA hero candidate
//   webp/{kboId}.webp         최종 webp (lossless alpha)
//   meta/{kboId}.json         step별 결과 + face metadata
//
// 사용:
//   node scripts/hero/generate-candidate.mjs \
//     --kbo-id 50157 --name "김윤식" --team "LG" --position "투수" \
//     --source-jpg public/players/50157.jpg \
//     --out-dir /tmp/hero-run-20260510
//
// 환경 변수:
//   GEMINI_API_KEY        Nano Banana Pro (필수)
//   REMOVE_BG_API_KEY     remove.bg (필수)
//   NANO_BANANA_CMD       선택. 없으면 ~/.openclaw/workspace/skills/nano-banana-pro/scripts/generate_image.py 시도
//
// exit code: 0 ok / 1 failure (failure_reason은 stdout JSON에 명시)

import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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

function fail(reason, details = {}) {
  const payload = { status: "failed", reason, ...details };
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const kboId = args["kbo-id"];
const name = args["name"] ?? "";
const team = args["team"] ?? "";
const position = args["position"] ?? "";
const sourceJpgArg = args["source-jpg"];
const outDir = args["out-dir"];
const skipNano = args["skip-nano"] === true || args["skip-nano"] === "true";
const skipRemoveBg = args["skip-remove-bg"] === true || args["skip-remove-bg"] === "true";
const reuseExisting = args["reuse-existing"] === true || args["reuse-existing"] === "true";

if (!kboId) fail("usage_kbo_id_required", { hint: "--kbo-id <id>" });
if (!outDir) fail("usage_out_dir_required", { hint: "--out-dir <path>" });

const dirs = {
  raw: join(outDir, "raw"),
  alpha: join(outDir, "alpha"),
  hero: join(outDir, "hero"),
  webp: join(outDir, "webp"),
  meta: join(outDir, "meta"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const paths = {
  raw: join(dirs.raw, `${kboId}.png`),
  alpha: join(dirs.alpha, `${kboId}.png`),
  hero: join(dirs.hero, `${kboId}.png`),
  webp: join(dirs.webp, `${kboId}.webp`),
  meta: join(dirs.meta, `${kboId}.json`),
};

const startedAt = Date.now();
const trace = { kboId, name, team, position, startedAt: new Date().toISOString(), steps: [] };

// === step 1: source JPG ===
let sourceJpg = sourceJpgArg;
if (!sourceJpg) {
  const committed = resolve(ROOT, "public/players", `${kboId}.jpg`);
  if (existsSync(committed)) sourceJpg = committed;
}
if (!sourceJpg || !existsSync(sourceJpg)) {
  fail("source_jpg_missing", {
    hint: "--source-jpg <path> 또는 public/players/<kboId>.jpg 필요",
    sourceJpgArg, kboId,
  });
}
trace.source_jpg = sourceJpg;
trace.steps.push({ step: "source", status: "ok", path: sourceJpg });

// === step 2: Nano Banana Pro 2K (raw png) ===
const reuseRaw = reuseExisting && existsSync(paths.raw) && statSync(paths.raw).size > 0;
if (skipNano) {
  if (!existsSync(paths.raw)) fail("skip_nano_but_raw_missing", { expected: paths.raw });
  trace.steps.push({ step: "nano_banana", status: "skipped" });
} else if (reuseRaw) {
  trace.steps.push({ step: "nano_banana", status: "reused", path: paths.raw, size: statSync(paths.raw).size });
} else {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) fail("missing_env_GEMINI_API_KEY");
  let nanoCmd = process.env.NANO_BANANA_CMD;
  let nanoArgs = [];
  if (!nanoCmd) {
    const fallback = join(homedir(), ".openclaw/workspace/skills/nano-banana-pro/scripts/generate_image.py");
    if (existsSync(fallback)) {
      nanoCmd = "uv";
      nanoArgs = ["run", fallback];
    } else {
      fail("nano_banana_cmd_unavailable", { hint: "set NANO_BANANA_CMD or install nano-banana-pro skill" });
    }
  }
  const teamYear = "2025"; // home uniform reference
  const prompt = `Official KBO baseball player portrait photograph. Upper body shot from head to chest, standing pose facing camera, wearing authentic KBO ${team} ${teamYear} home uniform with team logo clearly visible. Studio portrait style, soft professional lighting, neutral medium-gray background (#8a8a8a), sharp focus, high detail photography. The player is ${name}, a ${position} for ${team}. Preserve facial features and likeness from the reference photo exactly.`;
  const nanoStart = Date.now();
  const child = spawnSync(nanoCmd, [
    ...nanoArgs,
    "--prompt", prompt,
    "--filename", paths.raw,
    "--input-image", sourceJpg,
    "--resolution", "2K",
  ], {
    env: { ...process.env, GEMINI_API_KEY: apiKey },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  });
  const nanoMs = Date.now() - nanoStart;
  const nanoOk = !child.error && child.status === 0 && existsSync(paths.raw) && statSync(paths.raw).size > 0;
  if (!nanoOk) {
    fail("nano_banana_failed", {
      cmd: nanoCmd, status: child.status, signal: child.signal,
      stderr: child.stderr ? child.stderr.toString().slice(-2000) : null,
      duration_ms: nanoMs,
    });
  }
  trace.steps.push({ step: "nano_banana", status: "ok", path: paths.raw, duration_ms: nanoMs, size: statSync(paths.raw).size });
}

// === step 3: remove.bg HD (alpha png) ===
const reuseAlpha = reuseExisting && existsSync(paths.alpha) && statSync(paths.alpha).size > 0;
if (skipRemoveBg) {
  if (!existsSync(paths.alpha)) fail("skip_remove_bg_but_alpha_missing", { expected: paths.alpha });
  trace.steps.push({ step: "remove_bg", status: "skipped" });
} else if (reuseAlpha) {
  trace.steps.push({ step: "remove_bg", status: "reused", path: paths.alpha, size: statSync(paths.alpha).size });
} else {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) fail("missing_env_REMOVE_BG_API_KEY");
  const rbStart = Date.now();
  let httpStatus = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const form = new FormData();
      form.append("image_file", new Blob([readFileSync(paths.raw)]), `${kboId}.png`);
      form.append("size", "hd");
      form.append("format", "png");
      const res = await fetch("https://api.remove.bg/v1.0/removebg", {
        method: "POST",
        headers: { "X-Api-Key": apiKey },
        body: form,
        signal: AbortSignal.timeout(45_000),
      });
      httpStatus = res.status;
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(paths.alpha, buf);
        break;
      }
      lastErr = `http_${res.status}`;
      // 402 = no credit, 재시도 무의미 → 즉시 중단
      if (res.status === 402) break;
    } catch (e) {
      lastErr = `exc_${(e && e.name) || "unknown"}`;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const rbMs = Date.now() - rbStart;
  if (!existsSync(paths.alpha) || statSync(paths.alpha).size === 0) {
    fail("remove_bg_failed", { http_status: httpStatus, last_error: lastErr, duration_ms: rbMs });
  }
  trace.steps.push({ step: "remove_bg", status: "ok", path: paths.alpha, http_status: httpStatus, duration_ms: rbMs, size: statSync(paths.alpha).size });
}

// === step 4: face_detect.py ===
const fdStart = Date.now();
const faceMeta = join(dirs.meta, `${kboId}.face.json`);
const fdChild = spawnSync("python3", [
  resolve(__dirname, "face_detect.py"),
  "--raw-png", paths.raw,
  "--alpha-png", paths.alpha,
  "--out-png", paths.hero,
  "--meta-json", faceMeta,
], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const fdMs = Date.now() - fdStart;
let faceData = null;
if (existsSync(faceMeta)) {
  try { faceData = JSON.parse(readFileSync(faceMeta, "utf8")); } catch { /* ignore */ }
}
if (fdChild.status !== 0 || !existsSync(paths.hero)) {
  fail("face_detect_failed", {
    exit_code: fdChild.status,
    duration_ms: fdMs,
    face_meta: faceData,
    stderr: fdChild.stderr ? fdChild.stderr.toString().slice(-2000) : null,
  });
}
trace.steps.push({ step: "face_detect", status: "ok", duration_ms: fdMs, face: faceData });

// === step 5: cwebp lossless alpha ===
const cwebpStart = Date.now();
const cwebpChild = spawnSync("cwebp", [
  "-quiet", "-q", "85", "-alpha_q", "100", "-exact", "-metadata", "none",
  paths.hero, "-o", paths.webp,
], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
const cwebpMs = Date.now() - cwebpStart;
if (cwebpChild.status !== 0 || !existsSync(paths.webp) || statSync(paths.webp).size === 0) {
  fail("cwebp_failed", {
    exit_code: cwebpChild.status,
    stderr: cwebpChild.stderr ? cwebpChild.stderr.toString().slice(-1000) : null,
  });
}
trace.steps.push({ step: "cwebp", status: "ok", path: paths.webp, duration_ms: cwebpMs, size: statSync(paths.webp).size });

trace.status = "ok";
trace.duration_ms = Date.now() - startedAt;
trace.outputs = paths;
writeFileSync(paths.meta, JSON.stringify(trace, null, 2));
process.stdout.write(JSON.stringify({ status: "ok", kboId, outputs: paths, duration_ms: trace.duration_ms, face: faceData }) + "\n");
