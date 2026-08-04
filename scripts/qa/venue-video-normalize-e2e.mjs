/**
 * 직관 스토리 영상 "업로드 전 720p + faststart 정규화" 실브라우저 E2E (Playwright chromium).
 * 실행: npm run qa:venue-video-normalize (로컬 전용 — ffmpeg + chromium 필요)
 *
 * 왜 필요한가(2026-08-04 실측):
 *   실제 업로드본 5건을 ffprobe + MP4 박스 오프셋으로 뜬 결과 원본이 1920x1440~1080x1920,
 *   13~24Mbps, 6.8~14.3초에 16.8~38.6MB 였고 **전부 50MiB 이하**라 기존 자동압축
 *   (shouldAutoCompressVideo = cap 초과분만)에 하나도 안 걸렸다. 게다가 5건 중 2건은
 *   moov 가 파일 끝(100%)이라 첫 재생에 사실상 전량 전송이 필요했다.
 *   → 용량과 무관하게 정규화하고, moov 를 앞으로 당긴다.
 *
 * 이 스모크가 실제로 확인하는 것(합성이 아니라 산출물 바이트를 직접 파싱):
 *   ① 정규화본이 원본보다 실질적으로 작다(첫 재생 전송량 감소의 직접 근거)
 *   ② 정규화본의 moov 가 mdat **앞**에 있다(faststart)
 *   ③ 긴 변이 720p(1280) 이하로 내려간다
 *   ④ 정규화 실패/deadline 초과 시 원본 그대로 fallback(회귀 없음)
 *
 * 한계: chromium 만 검증한다. WebKit(iOS)의 AudioEncoder 부재 경로는 코드상 오디오 패킷
 * 복사라 동일 로직이지만, 실기기 확인은 별도(BrowserStack 하네스)다.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const NORMALIZE_MAX_EDGE = 1280;
const tmp = mkdtempSync(join(tmpdir(), "venue-normalize-e2e-"));

/** ISO-BMFF 상위 박스 순서를 파싱해 [{type, offset, size}] 반환 (검증기 자체 구현 — 앱 코드와 독립). */
function topLevelBoxes(buf) {
  const boxes = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > buf.length) break;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      boxes.push({ type, offset: pos, size: buf.length - pos });
      break;
    }
    boxes.push({ type, offset: pos, size });
    if (size < header) break;
    pos += size;
  }
  return boxes;
}

function isFastStart(buf) {
  for (const b of topLevelBoxes(buf)) {
    if (b.type === "moov") return true;
    if (b.type === "mdat") return false;
  }
  return null;
}

try {
  // 1) 실측을 닮은 입력: 1920x1440, 고비트레이트 H.264 + AAC, **moov 를 파일 끝에**(faststart 아님)
  //    = s847/s771 이 실제로 그랬던 배열. cap(50MiB) 이하라 기존 자동압축엔 안 걸리는 크기.
  const videoPath = join(tmp, "src.mp4");
  // -movflags 미지정 = moov 가 mdat 뒤(faststart 아님) — s847/s771 실측 배열과 동일하게 둔다.
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1440:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "8",
      "-vf", "noise=alls=30:allf=t+u",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-b:v", "20M", "-maxrate", "20M", "-bufsize", "40M",
      "-c:a", "aac", "-b:a", "128k", "-shortest",
      videoPath,
    ],
    { stdio: "ignore" },
  );
  const inputSize = statSync(videoPath).size;
  const inputBuf = new Uint8Array(readFileSync(videoPath));
  const inputFastStart = isFastStart(inputBuf);
  if (inputSize > 50 * 1024 * 1024) {
    console.error(`❌ 합성 입력이 cap 초과(${inputSize}B) — 이 스모크는 'cap 이하인데 느린' 케이스를 봐야 한다`);
    process.exit(1);
  }

  // 2) video-compress.ts + mediabunny 단일 ESM 번들
  const bundlePath = join(tmp, "video-compress.bundle.mjs");
  execFileSync(
    join(process.cwd(), "node_modules", ".bin", "esbuild"),
    ["src/lib/venue-stories/video-compress.ts", "--bundle", "--format=esm", `--outfile=${bundlePath}`],
    { stdio: "inherit" },
  );
  writeFileSync(join(tmp, "index.html"), "<!doctype html><title>venue normalize e2e</title>");

  const server = createServer((req, res) => {
    const routes = {
      "/": ["index.html", "text/html"],
      "/bundle.mjs": ["video-compress.bundle.mjs", "text/javascript"],
      "/src.mp4": ["src.mp4", "video/mp4"],
    };
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": route[1] });
    res.end(readFileSync(join(tmp, route[0])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => console.log(`  [page] ${m.text()}`));
  await page.goto(`${base}/`);

  // 3) 실제 정규화 실행 — 결과 바이트를 그대로 받아와 이 스크립트가 직접 파싱한다
  const result = await page.evaluate(async () => {
    const mod = await import("/bundle.mjs");
    const blob = await (await fetch("/src.mp4")).blob();
    const file = new File([blob], "src.mp4", { type: "video/mp4" });
    const t0 = performance.now();
    const out = await mod.normalizeVenueVideo(file, {
      durationMs: 8_000,
      width: 1920,
      height: 1440,
      onProgress: () => {},
    });
    const bytes = out.normalized ? Array.from(new Uint8Array(await out.file.arrayBuffer())) : null;
    return {
      normalized: out.normalized,
      originalBytes: out.originalBytes,
      normalizedBytes: out.normalizedBytes,
      originalFastStart: out.originalFastStart,
      type: out.file.type,
      tookMs: Math.round(performance.now() - t0),
      bytes,
    };
  });

  // 4) deadline 초과 → 원본 그대로 fallback(회귀 없음). 기존 compress 경로와 동일 계약.
  const deadline = await page.evaluate(async () => {
    const mod = await import("/bundle.mjs");
    const blob = await (await fetch("/src.mp4")).blob();
    const file = new File([blob], "src.mp4", { type: "video/mp4" });
    const t0 = performance.now();
    const out = await mod.normalizeVenueVideo(file, {
      durationMs: 8_000,
      width: 1920,
      height: 1440,
      deadlineMs: 1,
    });
    return {
      normalized: out.normalized,
      sameFile: out.file.size === file.size,
      tookMs: Math.round(performance.now() - t0),
    };
  });

  // 5) 정규화본 해상도는 실제 재생기로 읽는다(메타 주장 아님)
  let outDims = null;
  if (result.bytes) {
    outDims = await page.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const dims = await new Promise((resolve) => {
        v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
        v.onerror = () => resolve(null);
        setTimeout(() => resolve(null), 15_000);
        v.src = url;
      });
      URL.revokeObjectURL(url);
      return dims;
    }, result.bytes);
  }

  await browser.close();
  server.close();

  let fail = 0;
  const ok = (name, cond) => {
    console.log(`  ${cond ? "✅" : "❌"} ${name}`);
    if (!cond) fail++;
  };

  console.log("[venue-video-normalize e2e]");
  console.log(
    `  입력: ${(inputSize / 1048576).toFixed(1)}MB (faststart=${inputFastStart}) → 정규화: ` +
      `${result.normalizedBytes == null ? "-" : (result.normalizedBytes / 1048576).toFixed(1) + "MB"} (${result.tookMs}ms)`,
  );

  ok("입력이 cap 이하 = 기존 자동압축 비대상(사고 조건 재현)", inputSize <= 50 * 1024 * 1024);
  ok("입력 moov 가 mdat 뒤 = faststart 아님(실측 s847/s771 배열 재현)", inputFastStart === false);
  ok("정규화 성공(트랙 드랍 없음 포함)", result.normalized === true);
  ok(
    `정규화본이 원본보다 작다 (${result.originalBytes} → ${result.normalizedBytes})`,
    result.normalized && result.normalizedBytes < result.originalBytes,
  );
  ok(
    "전송량이 최소 절반 이하로 감소(첫 재생 대기 감소의 직접 근거)",
    result.normalized && result.normalizedBytes <= result.originalBytes / 2,
  );
  ok("출력 mp4", result.type === "video/mp4");

  if (result.bytes) {
    const outBuf = new Uint8Array(result.bytes);
    const boxes = topLevelBoxes(outBuf).map((b) => b.type);
    console.log(`  출력 박스 순서: ${boxes.slice(0, 5).join(" → ")}`);
    ok("정규화본 moov 가 mdat 앞(faststart)", isFastStart(outBuf) === true);
  } else {
    ok("정규화본 바이트 확보", false);
  }

  ok(
    `정규화본 긴 변 ≤ ${NORMALIZE_MAX_EDGE}px (실제 재생기 판독: ${outDims ? `${outDims.w}x${outDims.h}` : "판독실패"})`,
    outDims != null && Math.max(outDims.w, outDims.h) <= NORMALIZE_MAX_EDGE,
  );
  ok(
    `정규화본 duration 보존 (${outDims ? outDims.d.toFixed(2) : "?"}s ≈ 8s)`,
    outDims != null && Math.abs(outDims.d - 8) < 1.0,
  );
  ok(
    `deadline 초과 → 원본 그대로 fallback (${deadline.tookMs}ms)`,
    deadline.normalized === false && deadline.sameFile === true && deadline.tookMs < 30_000,
  );

  console.log(`\n결과: ${fail === 0 ? "PASS" : `FAIL(${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
