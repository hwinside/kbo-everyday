#!/usr/bin/env node
// scripts/hero/fetch-source-photo.mjs
//
// 단일 kboId의 원본 사진(JPG)을 수급한다.
// 우선순위:
//   1. public/players/{kboId}.jpg (커밋된 자산)
//   2. KBO 네이버 CDN: https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle/{season}/{kboId}.jpg
//      — current → previous → previous-2 시즌 fallback
// 검증: HTTP 200 + image/* MIME + JPEG magic bytes (0xFF 0xD8)
//
// 사용:
//   node scripts/hero/fetch-source-photo.mjs <kboId>
//   node scripts/hero/fetch-source-photo.mjs <kboId> --out-dir=/tmp/hero-source
//   node scripts/hero/fetch-source-photo.mjs <kboId> --seasons=2026,2025,2024
//   node scripts/hero/fetch-source-photo.mjs <kboId> --dry-run     # 다운로드 안 함, HEAD만
//
// 출력 (stdout JSON):
//   {
//     kboId, status: "committed" | "fetched" | "no_src",
//     source?: "committed" | "cdn",
//     path?: string,
//     attempted: [{ url, httpStatus, ok, reason? }]
//   }
//
// exit code:
//   0: status="committed" or "fetched"
//   2: status="no_src"
//   64: usage error

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
const kboId = args.find((a) => !a.startsWith("--"));
if (!kboId) {
  console.error(
    "usage: node scripts/hero/fetch-source-photo.mjs <kboId> [--out-dir=path] [--seasons=2026,2025,2024] [--dry-run]",
  );
  process.exit(64);
}

const dryRun = args.includes("--dry-run");
const outDirArg = args.find((a) => a.startsWith("--out-dir="));
const outDir = outDirArg ? outDirArg.split("=")[1] : resolve(ROOT, "public/players");
const seasonsArg = args.find((a) => a.startsWith("--seasons="));
const currentYear = new Date().getFullYear();
const seasons = seasonsArg
  ? seasonsArg.split("=")[1].split(",").map((s) => s.trim())
  : [String(currentYear), String(currentYear - 1), String(currentYear - 2)];

const result = {
  kboId,
  status: null,
  source: null,
  path: null,
  attempted: [],
};

const committedPath = resolve(ROOT, "public/players", `${kboId}.jpg`);
if (existsSync(committedPath)) {
  result.status = "committed";
  result.source = "committed";
  result.path = committedPath;
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

const CDN_BASE = "https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/person/middle";
const ua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

for (const season of seasons) {
  const url = `${CDN_BASE}/${season}/${kboId}.jpg`;
  let ok = false;
  let httpStatus = null;
  let reason = null;
  try {
    const res = await fetch(url, {
      method: dryRun ? "HEAD" : "GET",
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(8000),
    });
    httpStatus = res.status;
    if (!res.ok) {
      reason = `http_${res.status}`;
    } else {
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.startsWith("image/")) {
        reason = `bad_mime:${ct}`;
      } else if (dryRun) {
        ok = true;
        result.status = "fetched";
        result.source = "cdn";
        result.path = `(dry-run) ${url}`;
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
          reason = "not_jpeg_magic";
        } else {
          mkdirSync(outDir, { recursive: true });
          const target = join(outDir, `${kboId}.jpg`);
          writeFileSync(target, buf);
          result.status = "fetched";
          result.source = "cdn";
          result.path = target;
          ok = true;
        }
      }
    }
  } catch (e) {
    reason = `error:${(e && e.name) || "unknown"}`;
  }

  result.attempted.push({ url, httpStatus, ok, reason });
  if (ok) {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  }
}

result.status = "no_src";
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(2);
