#!/usr/bin/env node
/**
 * Real-device QA: 직관 스토리 cap 초과 영상 자동압축 — 실제 iPhone Safari(WebKit/WKWebView 동일 엔진).
 * 실행: npm run qa:ios-venue-compress
 *
 * 시나리오(삼순 #814 merge 조건): cap(50MiB) 초과 H.264+AAC 영상을 실기기에서
 *   선택(fetch-blob 주입) → compressVenueVideo 재인코딩(오디오 패킷 복사) → HTTP 업로드
 * 까지 수행하고, 업로드된 결과물을 로컬에서 ffprobe 로 검증한다(≤cap, h264+aac, ~10s).
 *
 * 한계(정직 고지): iOS Safari 실기기는 네이티브 파일 picker 를 프로그래매틱으로 조작할 수
 * 없어 "선택" 단계는 fetch → File 생성으로 대체한다(코드 경로는 픽 이후와 동일).
 *
 * 터널: cloudflared quick tunnel(https) — WebCodecs 는 secure context 필수라
 * BrowserStack Local(http://bs-local.com) 대신 https 공개 터널을 쓴다(랜덤 URL, 세션 동안만).
 *
 * Required env: BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY (+ PATH 상 cloudflared)
 * Optional env: BS_DEVICE='iPhone 15', BS_OS_VERSION='17'
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
if (!username || !accessKey) {
  console.error("Missing BROWSERSTACK_USERNAME/BROWSERSTACK_ACCESS_KEY");
  process.exit(2);
}

const MAX_BYTES = 50 * 1024 * 1024;
const hub = "https://hub-cloud.browserstack.com/wd/hub";
const auth = `Basic ${Buffer.from(`${username}:${accessKey}`).toString("base64")}`;
const tmp = mkdtempSync(join(tmpdir(), "venue-compress-bs-"));

async function wd(method, route, body, sessionId) {
  const res = await fetch(`${hub}${sessionId ? `/session/${sessionId}` : ""}${route}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json; charset=utf-8" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || json.value?.error) {
    throw new Error(`${method} ${route} failed: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json.value ?? json;
}

let tunnel = null;
let server = null;
let sessionId = null;

try {
  // 1) cap 초과 합성 영상 (10초 H.264 + AAC — e2e 와 동일 레시피, 터널 전송 고려해 ~55MB)
  const videoPath = join(tmp, "big.mp4");
  console.log("[1/6] ffmpeg 합성 영상 생성...");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "10", "-vf", "noise=alls=40:allf=t+u",
    "-c:v", "libx264", "-preset", "ultrafast",
    "-b:v", "44M", "-maxrate", "44M", "-bufsize", "88M",
    "-c:a", "aac", "-b:a", "128k", "-shortest", videoPath,
  ], { stdio: "ignore" });
  const inputSize = statSync(videoPath).size;
  if (inputSize <= MAX_BYTES) {
    console.error(`❌ 합성 영상이 cap 이하(${inputSize}B) — 전제 불충족`);
    process.exit(1);
  }
  console.log(`  입력 ${(inputSize / 1048576).toFixed(1)}MB (cap 초과 확인)`);

  // 2) video-compress.ts 번들 (실제 프로덕션 모듈 + mediabunny 그대로)
  console.log("[2/6] esbuild 번들...");
  const bundlePath = join(tmp, "bundle.mjs");
  execFileSync(join(process.cwd(), "node_modules", ".bin", "esbuild"), [
    "src/lib/venue-stories/video-compress.ts",
    "--bundle", "--format=esm", `--outfile=${bundlePath}`,
  ], { stdio: "ignore" });
  writeFileSync(join(tmp, "index.html"), "<!doctype html><title>venue compress ios smoke</title>");

  // 3) 로컬 서버 (page/bundle/영상 + 업로드 수신)
  const uploadedPath = join(tmp, "uploaded.mp4");
  let uploadedBytes = 0;
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/upload") {
      const out = createWriteStream(uploadedPath);
      req.pipe(out);
      req.on("data", (c) => { uploadedBytes += c.length; });
      out.on("finish", () => { res.writeHead(200).end("ok"); });
      req.on("error", () => res.writeHead(500).end());
      return;
    }
    const routes = {
      "/": ["index.html", "text/html"],
      "/bundle.mjs": ["bundle.mjs", "text/javascript"],
      "/big.mp4": ["big.mp4", "video/mp4"],
    };
    const route = routes[req.url];
    if (!route) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": route[1] });
    res.end(readFileSync(join(tmp, route[0])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // 4) cloudflared quick tunnel — https 공개 URL(WebCodecs secure context 필수)
  console.log("[3/6] cloudflared quick tunnel 시작...");
  tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared 시작 timeout")), 60_000);
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    tunnel.on("exit", (code) => reject(new Error(`cloudflared 조기 종료(${code})`)));
  });
  console.log(`  tunnel: ${baseUrl}`);

  console.log("[4/6] iPhone 실기기 세션 생성...");
  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "safari",
        "bstack:options": {
          projectName: "kbo-everyday",
          buildName: `venue-video-compress-${new Date().toISOString().slice(0, 10)}`,
          sessionName: "iOS real-device venue video autocompress smoke",
          deviceName: process.env.BS_DEVICE || "iPhone 15",
          osVersion: process.env.BS_OS_VERSION || "17",
          realMobile: "true",
          idleTimeout: 300,
          debug: "true",
          consoleLogs: "info",
        },
      },
    },
  });
  sessionId = created.sessionId;
  if (!sessionId) throw new Error(`No sessionId: ${JSON.stringify(created)}`);

  await wd("POST", "/timeouts", { script: 600_000, pageLoad: 120_000 }, sessionId);
  await wd("POST", "/url", { url: `${baseUrl}/` }, sessionId);

  // 6) 실기기에서: fetch-blob 선택 → 압축(오디오 패킷 복사) → 업로드.
  // Appium atom 실행은 120s 하드캡이라 execute/async 한 방이 아니라
  // 시작(sync) → window 상태 폴링(sync 반복) 패턴을 쓴다.
  console.log("[5/6] 실기기 압축+업로드 실행(수 분 소요 — 영상 터널 전송 포함)...");
  await wd("POST", "/execute/sync", {
    script: `
      window.__smoke = { status: "running", step: "start" };
      (async () => {
        const s = window.__smoke;
        const mod = await import("/bundle.mjs");
        if (!mod.isVideoCompressSupported()) { Object.assign(s, { status: "done", ok: false, step: "support", ua: navigator.userAgent }); return; }
        s.step = "fetch";
        const blob = await (await fetch("/big.mp4")).blob();
        const file = new File([blob], "big.mp4", { type: "video/mp4" });
        s.step = "compress";
        const t0 = Date.now();
        const out = await mod.compressVenueVideo(file, { durationMs: 10000, width: 1080, height: 1920,
          onProgress: (r) => { s.progress = Math.round(r * 100); } });
        if (!out) { Object.assign(s, { status: "done", ok: false, step: "compress", ua: navigator.userAgent }); return; }
        s.step = "upload";
        const up = await fetch("/upload", { method: "POST", headers: { "content-type": "video/mp4" }, body: out });
        Object.assign(s, { status: "done", ok: up.ok, step: "uploaded", inputSize: file.size,
          outputSize: out.size, tookMs: Date.now() - t0, ua: navigator.userAgent });
      })().catch((e) => Object.assign(window.__smoke, { status: "done", ok: false, step: "error", message: String(e && e.stack || e) }));
      return "started";
    `,
    args: [],
  }, sessionId);
  const deadline = Date.now() + 10 * 60_000;
  let result = null;
  let lastLog = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const state = await wd("POST", "/execute/sync", {
      script: "return JSON.stringify(window.__smoke || {});",
      args: [],
    }, sessionId);
    const parsed = JSON.parse(state || "{}");
    const line = `${parsed.step}${parsed.progress != null ? ` ${parsed.progress}%` : ""}`;
    if (line !== lastLog) { console.log(`  device: ${line}`); lastLog = line; }
    if (parsed.status === "done") { result = parsed; break; }
  }
  if (!result) throw new Error("실기기 smoke 10분 초과 — timeout");
  console.log(`  device result: ${JSON.stringify(result)}`);

  // 7) 업로드 결과물 서버측 ffprobe 검증 (오디오 보존 + duration + cap)
  console.log("[6/6] 업로드 결과물 ffprobe 검증...");
  let fail = 0;
  const ok = (name, cond) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); if (!cond) fail++; };
  ok(`실기기 압축+업로드 성공 (${result?.step})`, result?.ok === true);
  if (result?.ok) {
    ok(`출력 ≤ 50MiB cap (${result.outputSize}B)`, result.outputSize <= MAX_BYTES);
    ok(`업로드 수신 바이트 일치 (${uploadedBytes}B)`, uploadedBytes === result.outputSize);
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", uploadedPath,
    ]).toString());
    const streams = probe.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    ok(`업로드본 video 스트림 h264 (${v?.codec_name})`, v?.codec_name === "h264");
    ok(`업로드본 audio 스트림 aac 보존 (${a?.codec_name})`, a?.codec_name === "aac");
    const dur = parseFloat(probe.format?.duration ?? "0");
    ok(`업로드본 duration ~10s (${dur.toFixed(2)}s)`, dur > 9 && dur < 11.5);
    // 참고 지표(게이트 아님): realtime 모드 프레임 드랍 가시화 — 입력 300프레임(30fps×10s) 대비
    console.log(`  참고: video nb_frames=${v?.nb_frames ?? "?"}, avg_frame_rate=${v?.avg_frame_rate ?? "?"}`);
    console.log(`  UA: ${result.ua}`);
    console.log(`  입력 ${(result.inputSize / 1048576).toFixed(1)}MB → 출력 ${(result.outputSize / 1048576).toFixed(1)}MB, ${result.tookMs}ms`);
  }

  await wd("POST", "/execute/sync", {
    script: `browserstack_executor: ${JSON.stringify({
      action: "setSessionStatus",
      arguments: { status: fail === 0 ? "passed" : "failed", reason: "venue video autocompress smoke" },
    })}`,
    args: [],
  }, sessionId).catch(() => {});

  console.log(`\n결과: ${fail === 0 ? "PASS" : `FAIL(${fail})`}  (BrowserStack session: ${sessionId})`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  if (sessionId) await wd("DELETE", "", undefined, sessionId).catch(() => {});
  if (server) server.close();
  if (tunnel) tunnel.kill();
  rmSync(tmp, { recursive: true, force: true });
}
