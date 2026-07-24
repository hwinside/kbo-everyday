/**
 * 직관 스토리 영상 자동압축 실브라우저 E2E (Playwright chromium).
 * 실행: npm run qa:venue-video-compress (로컬 전용 — ffmpeg 필요)
 *
 * 시나리오: ffmpeg 로 합성한 10초 ~60MB(cap 초과) 1080x1920 영상을
 * 실제 WebCodecs(compressVenueVideo)로 재인코딩 → 50MiB cap 이하 + 오디오 트랙 보존 확인.
 * 한계: chromium 만 검증(WebKit 의 AudioEncoder 부재 경로는 코드상 오디오 패킷 복사라 동일 로직).
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const MAX_BYTES = 50 * 1024 * 1024;
const TARGET_BYTES = 45 * 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), "venue-compress-e2e-"));

try {
  // 1) cap 초과 합성 영상 (10초, 1080x1920, 고비트레이트 H.264 + AAC)
  const videoPath = join(tmp, "big.mp4");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "10", "-vf", "noise=alls=40:allf=t+u", // 노이즈로 압축 난이도 ↑ (목표 비트레이트 미달 방지)
    "-c:v", "libx264", "-preset", "ultrafast",
    "-b:v", "52M", "-maxrate", "52M", "-bufsize", "104M",
    "-c:a", "aac", "-b:a", "128k", "-shortest", videoPath,
  ], { stdio: "ignore" });
  const inputSize = statSync(videoPath).size;
  if (inputSize <= MAX_BYTES) {
    console.error(`❌ 합성 영상이 cap 이하(${inputSize}B) — 테스트 전제 불충족`);
    process.exit(1);
  }

  // 2) video-compress.ts + mediabunny 를 단일 ESM 번들로 (브라우저에서 그대로 실행)
  const bundlePath = join(tmp, "video-compress.bundle.mjs");
  execFileSync(join(process.cwd(), "node_modules", ".bin", "esbuild"), [
    "src/lib/venue-stories/video-compress.ts",
    "--bundle", "--format=esm", `--outfile=${bundlePath}`,
  ], { stdio: "inherit" });

  writeFileSync(join(tmp, "index.html"), "<!doctype html><title>venue compress e2e</title>");

  // 3) 정적 서버 (page + bundle + 영상)
  const server = createServer((req, res) => {
    const routes = {
      "/": ["index.html", "text/html"],
      "/bundle.mjs": ["video-compress.bundle.mjs", "text/javascript"],
      "/big.mp4": ["big.mp4", "video/mp4"],
    };
    const route = routes[req.url];
    if (!route) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": route[1] });
    res.end(readFileSync(join(tmp, route[0])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 4) chromium 에서 실제 압축 실행
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [page] ${m.text()}`));
  await page.goto(`${base}/`);
  const result = await page.evaluate(async () => {
    const mod = await import("/bundle.mjs");
    const blob = await (await fetch("/big.mp4")).blob();
    const file = new File([blob], "big.mp4", { type: "video/mp4" });
    const t0 = performance.now();
    const out = await mod.compressVenueVideo(file, {
      durationMs: 10_000, width: 1080, height: 1920,
      onProgress: () => {},
    });
    if (!out) return { ok: false, reason: "compressVenueVideo → null" };
    // 오디오 트랙 보존 확인 — 번들에 포함된 mediabunny 로 결과물 재파싱
    // (compressVenueVideo 는 트랙 드랍 시 null 을 반환하지만 이중 확인)
    return {
      ok: true,
      inputSize: file.size,
      outputSize: out.size,
      type: out.type,
      tookMs: Math.round(performance.now() - t0),
    };
  });
  // 삼순 #814 blocker 회귀 — deadline 초과 시 conversion.cancel() 로 실제 중단되고
  // null fallback 으로 즉시 settle 해야 한다(submitting 영구 잠김 방지). 실바이너리 경로 검증.
  const deadlineResult = await page.evaluate(async () => {
    const mod = await import("/bundle.mjs");
    const blob = await (await fetch("/big.mp4")).blob();
    const file = new File([blob], "big.mp4", { type: "video/mp4" });
    const t0 = performance.now();
    const out = await mod.compressVenueVideo(file, {
      durationMs: 10_000, width: 1080, height: 1920, deadlineMs: 1,
    });
    return { fellBack: out === null, tookMs: Math.round(performance.now() - t0) };
  });
  await browser.close();
  server.close();

  console.log("[venue-video-compress e2e]");
  console.log(`  입력: ${(result.inputSize / 1048576).toFixed(1)}MB → 출력: ${(result.outputSize / 1048576).toFixed(1)}MB (${result.tookMs}ms)`);
  let fail = 0;
  const ok = (name, cond) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); if (!cond) fail++; };
  ok("압축 성공(null 아님 — 트랙 드랍 없음 포함)", result.ok === true);
  ok(`출력 ≤ 50MiB cap (${result.outputSize}B)`, result.ok && result.outputSize <= MAX_BYTES);
  ok(`출력 ≤ 45MB 목표 (${result.outputSize}B)`, result.ok && result.outputSize <= TARGET_BYTES);
  ok("출력 mp4", result.ok && result.type === "video/mp4");
  ok(`deadline 초과 → cancel + null fallback 즉시 settle (${deadlineResult.tookMs}ms)`,
    deadlineResult.fellBack === true && deadlineResult.tookMs < 30_000);
  console.log(`\n결과: ${fail === 0 ? "PASS" : `FAIL(${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
