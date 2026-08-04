/**
 * 직관 스토리 영상 "업로드 전 720p + faststart 정규화" **실 업로드 경로** E2E.
 * 실행: npm run qa:venue-video-normalize (ffmpeg + Playwright chromium 필요)
 *
 * 왜 필요한가(2026-08-04 실측):
 *   실제 업로드본 5건을 ffprobe + MP4 박스 오프셋으로 뜬 결과 원본이 1920x1440~1080x1920,
 *   13~24Mbps, 6.8~14.3초에 16.8~38.6MB 였고 **전부 50MiB 이하**라 기존 자동압축
 *   (shouldAutoCompressVideo = cap 초과분만)에 하나도 안 걸렸다. 5건 중 2건은 moov 가
 *   파일 끝(100%)이라 첫 재생에 사실상 전량 전송이 필요했다.
 *
 * 삼순 NO-GO ①/④ 반영 — 이 게이트는 헬퍼가 아니라 **실제 `prepareVenueStoryMedia()`**를 돌린다:
 *   - supabase client 만 esbuild 플러그인으로 스텁해 storage.upload 로 들어온 **실제 바이트**를 회수
 *   - 회수한 바이트를 ffprobe + 박스 파서로 검사(앱 코드의 주장에 의존하지 않음)
 *   - 따라서 upload.ts 의 정규화 호출을 지우거나 무력화하면 RED 가 난다
 *
 * fixture 3종(합성 1종 아님):
 *   ① h264-moov-last : 1920x1440 20Mbps, moov 파일 끝 (s847/s771 배열 재현)
 *   ② hevc           : 1080x1920 HEVC (s771 코덱 재현) — H.264 로 정규화되는지
 *   ③ rotated        : 1920x1080 + rotate 90 메타 — 회전 보존/치수 처리
 *
 * 한계: chromium 만 검증. iOS WebKit<26 realtime 강제 인코더 경로는 별도(BrowserStack).
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const NORMALIZE_MAX_EDGE = 1280;
const CAP_BYTES = 50 * 1024 * 1024;
const tmp = mkdtempSync(join(tmpdir(), "venue-normalize-e2e-"));

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

/** ISO-BMFF 상위 박스 순서 파서 — 앱 코드와 **독립 구현**(검증기가 피검증물을 재사용하지 않는다). */
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

function ffprobeJson(path) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      // start_time/duration 은 A/V sync drift 검증용, side_data 는 display matrix rotation 용
      "-show_entries", "stream=codec_name,codec_type,width,height,start_time,duration",
      "-show_entries", "stream_side_data=rotation",
      "-show_entries", "format=duration,size",
      "-of", "json",
      path,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

/** 스트림의 display matrix rotation(도). 없으면 null. */
function streamRotation(stream) {
  const sd = stream?.side_data_list;
  if (!Array.isArray(sd)) return null;
  for (const d of sd) {
    if (typeof d?.rotation === "number") return d.rotation;
  }
  return null;
}

/** 회전을 반영한 표시 치수(90/270이면 w↔h). */
function displayDims(stream) {
  const rot = streamRotation(stream) ?? 0;
  const swapped = Math.abs(rot) % 180 === 90;
  return swapped
    ? { width: stream.height, height: stream.width }
    : { width: stream.width, height: stream.height };
}

try {
  // ── 1) fixture 생성 ────────────────────────────────────────────────
  const fixtures = [
    {
      name: "h264-moov-last",
      // -movflags 미지정 = moov 가 mdat 뒤. s847/s771 실측 배열과 동일.
      args: [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1440:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "8", "-vf", "noise=alls=30:allf=t+u",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", "20M", "-maxrate", "20M", "-bufsize", "40M",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
      ],
      durationMs: 8_000,
      width: 1920,
      height: 1440,
    },
    {
      name: "hevc",
      // s771 이 실제로 HEVC 였다 — H.264 로 정규화되어야 웹/구형 디코더에서 안전하다.
      args: [
        "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100",
        "-t", "6", "-vf", "noise=alls=25:allf=t+u",
        "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1",
        "-b:v", "12M", "-maxrate", "12M", "-bufsize", "24M",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
      ],
      durationMs: 6_000,
      width: 1080,
      height: 1920,
      expectSourceCodec: "hevc",
    },
    {
      name: "rotated",
      // 아이폰 세로 촬영은 display matrix rotation 으로 온다.
      //
      // ⚠️ 삼순 지적(2026-08-04): 처음에 `-metadata:s:v:0 rotate=90` 을 썼는데
      // 그건 **display matrix 를 전혀 만들지 않는다**(직접 재현해 ffprobe 확인: side_data 없음).
      // 즉 회전을 전혀 테스트하지 않는 fixture 였다. 생성 후 `-display_rotation` 으로
      // 메타를 입혀 실제 side_data rotation 을 만든다(아래 rotateArgs).
      args: [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=44100",
        "-t", "5", "-vf", "noise=alls=25:allf=t+u",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", "15M", "-maxrate", "15M", "-bufsize", "30M",
        "-c:a", "aac", "-b:a", "128k", "-shortest",
      ],
      // 2패스: 생성본에 display matrix 를 입힌다(재인코딩 없이 -c copy).
      applyDisplayRotation: 90,
      durationMs: 5_000,
      width: 1920,
      height: 1080,
      expectSourceRotation: 90,
    },
  ];

  for (const f of fixtures) {
    f.path = join(tmp, `${f.name}.mp4`);
    if (f.applyDisplayRotation != null) {
      const rawPath = join(tmp, `${f.name}.raw.mp4`);
      execFileSync("ffmpeg", ["-y", ...f.args, rawPath], { stdio: "ignore" });
      execFileSync(
        "ffmpeg",
        ["-y", "-display_rotation", String(f.applyDisplayRotation), "-i", rawPath, "-c", "copy", f.path],
        { stdio: "ignore" },
      );
    } else {
      execFileSync("ffmpeg", ["-y", ...f.args, f.path], { stdio: "ignore" });
    }
    f.bytes = statSync(f.path).size;
    f.head = new Uint8Array(readFileSync(f.path));
    f.probe = ffprobeJson(f.path);
  }

  // ── 2) 실제 upload.ts 를 번들 — supabase client 만 스텁 ─────────────
  // storage.upload 로 들어오는 **실제 업로드 바이트**를 회수해야 하므로
  // prepareVenueStoryMedia 자체는 손대지 않는다(호출 제거 시 RED 보장).
  const bundlePath = join(tmp, "upload.bundle.mjs");
  const stubPath = join(tmp, "supabase-stub.mjs");
  writeFileSync(
    stubPath,
    `
const uploads = [];
globalThis.__venueUploads = uploads;
export const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: "qa-user" } } }) },
  storage: {
    from: (bucket) => ({
      upload: async (path, data) => {
        uploads.push({ bucket, path, size: data.size, type: data.type, blob: data });
        return { error: null };
      },
      getPublicUrl: (path) => ({ data: { publicUrl: "https://stub.invalid/" + path } }),
    }),
  },
};
// token 없음 → shouldFallbackToSupabaseJs=true → supabase-js 경로(XHR 미사용)로 흐른다.
export const getSafeSession = async () => null;
`,
  );
  execFileSync(
    join(process.cwd(), "node_modules", ".bin", "esbuild"),
    [
      "src/lib/venue-stories/upload.ts",
      "--bundle",
      "--format=esm",
      `--outfile=${bundlePath}`,
      "--alias:@=./src",
      `--alias:@/lib/supabase/client=${stubPath}`,
    ],
    { stdio: "inherit" },
  );
  // fallback 계약 검증용 — 정규화 모듈 단독 번들(업로드 경로와 별개)
  const compressBundlePath = join(tmp, "compress.bundle.mjs");
  execFileSync(
    join(process.cwd(), "node_modules", ".bin", "esbuild"),
    [
      "src/lib/venue-stories/video-compress.ts",
      "--bundle",
      "--format=esm",
      `--outfile=${compressBundlePath}`,
      "--alias:@=./src",
    ],
    { stdio: "inherit" },
  );
  // Next 는 process.env.NEXT_PUBLIC_* 를 빌드 타임에 치환하지만 이 번들은 런타임 참조가 남는다.
  // 빈 값으로 두면 shouldFallbackToSupabaseJs=true → 스텁 supabase-js 경로로 흘러 바이트를 회수한다.
  writeFileSync(
    join(tmp, "index.html"),
    "<!doctype html><title>venue normalize e2e</title>" +
      "<script>window.process={env:{}};</script>",
  );

  const routes = {
    "/": ["index.html", "text/html"],
    "/bundle.mjs": ["upload.bundle.mjs", "text/javascript"],
    "/compress.mjs": ["compress.bundle.mjs", "text/javascript"],
  };
  for (const f of fixtures) routes[`/${f.name}.mp4`] = [`${f.name}.mp4`, "video/mp4"];

  const server = createServer((req, res) => {
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
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  await page.goto(`${base}/`);

  // 이 브라우저가 어떤 코덱을 실제로 디코딩할 수 있는지 먼저 묻는다.
  // headless chromium 은 보통 HEVC 를 못 다룬다 — 그런 환경에서는 "정규화된다"가 아니라
  // "안전하게 fallback 되고 서버 큐가 받는다"가 검증해야 할 계약이다.
  const codecSupport = await page.evaluate(async () => {
    const test = async (codec) => {
      if (typeof VideoDecoder === "undefined") return false;
      try {
        return (await VideoDecoder.isConfigSupported({ codec, codedWidth: 1080, codedHeight: 1920 }))
          .supported === true;
      } catch {
        return false;
      }
    };
    return {
      webcodecs: typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined",
      hevc: (await test("hvc1.1.6.L93.B0")) || (await test("hev1.1.6.L93.B0")),
      h264: await test("avc1.640028"),
    };
  });
  console.log(
    `  [env] WebCodecs=${codecSupport.webcodecs} h264=${codecSupport.h264} hevc=${codecSupport.hevc}`,
  );
  ok("WebCodecs 사용 가능(이 게이트의 전제)", codecSupport.webcodecs === true);
  ok("H.264 디코딩 가능(이 게이트의 전제)", codecSupport.h264 === true);

  // ── 3) 각 fixture 를 실제 prepareVenueStoryMedia 로 통과시키고 업로드 바이트 회수 ──
  console.log("[venue-video-normalize e2e — 실 업로드 경로]");
  for (const f of fixtures) {
    const res = await page.evaluate(async (name) => {
      const mod = await import("/bundle.mjs");
      globalThis.__venueUploads.length = 0;
      const blob = await (await fetch(`/${name}.mp4`)).blob();
      const file = new File([blob], `${name}.mp4`, { type: "video/mp4" });
      const t0 = performance.now();
      const prepared = await mod.prepareVenueStoryMedia(file, "20260804TEST0");
      const uploads = globalThis.__venueUploads;
      // 영상 본체 업로드 = video/mp4 content — 포스터(jpg)와 구분
      const videoUpload = uploads.find((u) => !u.path.endsWith(".jpg"));
      const bytes = videoUpload
        ? Array.from(new Uint8Array(await videoUpload.blob.arrayBuffer()))
        : null;
      return {
        prepared: prepared.error ? { error: prepared.error } : prepared,
        uploadCount: uploads.length,
        uploadPaths: uploads.map((u) => u.path),
        bytes,
        tookMs: Math.round(performance.now() - t0),
      };
    }, f.name);

    console.log(`\n  ── ${f.name} ──`);
    if (res.prepared.error) {
      ok(`${f.name}: prepareVenueStoryMedia 성공 (error=${res.prepared.error})`, false);
      continue;
    }
    if (!res.bytes) {
      ok(`${f.name}: 영상 본체가 업로드됨 (paths=${res.uploadPaths.join(",")})`, false);
      continue;
    }

    // 회수한 실제 업로드 바이트를 디스크에 쓰고 ffprobe 로 판독
    const outPath = join(tmp, `${f.name}.uploaded.mp4`);
    const outBuf = Buffer.from(res.bytes);
    writeFileSync(outPath, outBuf);
    const outProbe = ffprobeJson(outPath);
    const vStream = outProbe.streams.find((s) => s.codec_type === "video");
    const aStream = outProbe.streams.find((s) => s.codec_type === "audio");
    const outBytes = outBuf.length;
    const outEdge = vStream ? Math.max(vStream.width, vStream.height) : null;
    const outDur = parseFloat(outProbe.format.duration);
    const boxes = topLevelBoxes(new Uint8Array(outBuf)).map((b) => b.type);

    console.log(
      `  입력 ${(f.bytes / 1048576).toFixed(1)}MB → 업로드 ${(outBytes / 1048576).toFixed(1)}MB ` +
        `(${res.tookMs}ms) · ${vStream?.codec_name} ${vStream?.width}x${vStream?.height} · ` +
        `박스 ${boxes.slice(0, 4).join("→")}`,
    );

    // 사고 조건 재현 — 이 입력이 기존 경로에 안 걸린다는 사실 자체를 고정
    ok(`${f.name}: 입력이 cap 이하 = 기존 자동압축 비대상(사고 조건)`, f.bytes <= CAP_BYTES);
    if (f.name === "h264-moov-last") {
      ok(`${f.name}: 입력 moov 가 mdat 뒤 = faststart 아님(s847/s771 재현)`, isFastStart(f.head) === false);
    }
    if (f.expectSourceCodec) {
      const srcV = f.probe.streams.find((s) => s.codec_type === "video");
      ok(`${f.name}: 입력 코덱이 ${f.expectSourceCodec}`, srcV?.codec_name === f.expectSourceCodec);
    }
    // 회전 fixture 는 **입력이 정말 회전되었는지**를 먼저 고정한다.
    // 이걸 안 하면 회전 없는 fixture 로 회전 보존을 "검증했다"고 착각한다(삼순 지적, 2026-08-04).
    const srcVideo = f.probe.streams.find((s) => s.codec_type === "video");
    if (f.expectSourceRotation != null) {
      ok(
        `${f.name}: 입력에 display matrix rotation=${f.expectSourceRotation} 존재 (실제=${streamRotation(srcVideo)})`,
        Math.abs(streamRotation(srcVideo) ?? 0) === f.expectSourceRotation,
      );
    }

    // 이 환경이 이 fixture 를 디코딩할 수 있는가로 기대 계약이 갈린다.
    // headless chromium 은 HEVC 를 못 읽는다 → 그 경우는 "안전 fallback"이 계약이다.
    const decodable = f.expectSourceCodec === "hevc" ? codecSupport.hevc : codecSupport.h264;

    if (!decodable) {
      console.log(`  (이 브라우저가 ${f.expectSourceCodec ?? "h264"} 를 디코딩 못함 → fail-safe 계약 검증)`);
      // 정규화 불가 환경에서도 업로드 자체는 성공해야 하고(기존 동작 보존),
      // 원본이 무손 그대로 올라가야 한다. 느린 원본의 구제는 서버 needs_transcode 큐 책임이고
      // 그 판정은 qa:venue-validate 의 needsServerTranscode 계약이 담당한다.
      ok(`${f.name}: 디코딩 불가여도 업로드는 성공(기존 동작 보존)`, res.bytes != null);
      ok(`${f.name}: 원본이 변조 없이 그대로 올라간다 (${f.bytes} = ${outBytes})`, outBytes === f.bytes);
      ok(`${f.name}: 무단 무음화/트랙 유실 없음`, aStream != null);
      ok(`${f.name}: 포스터 썸네일도 업로드됨`, res.uploadPaths.some((p) => p.endsWith(".jpg")));
      continue;
    }

    // 실제 업로드된 바이트에 대한 계약
    ok(`${f.name}: 업로드본이 원본보다 작다 (${f.bytes} → ${outBytes})`, outBytes < f.bytes);
    ok(`${f.name}: 전송량 절반 이하로 감소`, outBytes <= f.bytes / 2);
    ok(`${f.name}: 업로드본 moov 가 mdat 앞(faststart)`, isFastStart(new Uint8Array(outBuf)) === true);
    ok(`${f.name}: 업로드본 비디오 코덱 h264 (실제=${vStream?.codec_name})`, vStream?.codec_name === "h264");
    ok(`${f.name}: 업로드본 긴 변 ≤ ${NORMALIZE_MAX_EDGE}px (실제=${outEdge})`, outEdge != null && outEdge <= NORMALIZE_MAX_EDGE);
    // ≤ 만 보면 target 을 1280→640 으로 낮추는 under-resolution 결함을 못 잡는다(삼순 독립 재현).
    // 이 PR 의 명시 계약은 "긴 변 1280 의 720p" 이므로 **source 기반 expected 를 독립 계산**해
    // exact 로 고정한다. 입력이 1280 보다 크면 리사이즈 후 긴 변은 정확히 1280 이어야 한다.
    {
      const srcDisp = displayDims(srcVideo);
      const srcEdge = Math.max(srcDisp.width, srcDisp.height);
      if (srcEdge > NORMALIZE_MAX_EDGE) {
        const scale = NORMALIZE_MAX_EDGE / srcEdge;
        const even = (v) => Math.max(2, Math.round((v * scale) / 2) * 2);
        const expected = { width: even(srcDisp.width), height: even(srcDisp.height) };
        const outDisp = displayDims(vStream);
        ok(
          `${f.name}: 표시 치수가 720p 계약 exact 일치 — expected ${expected.width}x${expected.height}, 실제 ${outDisp.width}x${outDisp.height}`,
          outDisp.width === expected.width && outDisp.height === expected.height,
        );
        ok(
          `${f.name}: 표시 긴 변이 정확히 ${NORMALIZE_MAX_EDGE}px (under-resolution 방지)`,
          Math.max(outDisp.width, outDisp.height) === NORMALIZE_MAX_EDGE,
        );
      }
    }
    ok(`${f.name}: 오디오 트랙 보존 (실제=${aStream?.codec_name ?? "없음"})`, aStream != null);
    ok(
      `${f.name}: duration 보존 (${outDur.toFixed(2)}s ≈ ${(f.durationMs / 1000).toFixed(1)}s)`,
      Math.abs(outDur - f.durationMs / 1000) < 1.0,
    );

    // ── 회전 보존 ──
    // 회전은 저장 방식이 둘이다: display matrix 를 그대로 옮기거나(rotation 유지),
    // 픽셀을 실제로 돌려 버리거나(rotation 0 + w/h 교체). 둘 다 유저가 보는 방향은 같다.
    // 그래서 "표시 방향(가로/세로)이 보존되는가"를 계약으로 잡는다.
    if (f.expectSourceRotation != null) {
      const srcDisp = displayDims(srcVideo);
      const outDisp = displayDims(vStream);
      const srcPortrait = srcDisp.height > srcDisp.width;
      const outPortrait = outDisp.height > outDisp.width;
      console.log(
        `  회전: 입력 ${srcVideo.width}x${srcVideo.height} rot=${streamRotation(srcVideo)} → 표시 ${srcDisp.width}x${srcDisp.height} / ` +
          `출력 ${vStream.width}x${vStream.height} rot=${streamRotation(vStream)} → 표시 ${outDisp.width}x${outDisp.height}`,
      );
      ok(
        `${f.name}: 표시 방향 보존 (입력 ${srcPortrait ? "세로" : "가로"} → 출력 ${outPortrait ? "세로" : "가로"})`,
        srcPortrait === outPortrait,
      );
      const srcAspect = srcDisp.width / srcDisp.height;
      const outAspect = outDisp.width / outDisp.height;
      ok(
        `${f.name}: 표시 종횡비 보존 (${srcAspect.toFixed(3)} ≈ ${outAspect.toFixed(3)})`,
        Math.abs(srcAspect - outAspect) < 0.05,
      );
      ok(
        `${f.name}: 표시 기준 긴 변 ≤ ${NORMALIZE_MAX_EDGE}px (실제=${Math.max(outDisp.width, outDisp.height)})`,
        Math.max(outDisp.width, outDisp.height) <= NORMALIZE_MAX_EDGE,
      );
      // 회전 fixture 는 expected 가 명확하다: 1920x1080 rot=90 → 표시 1080x1920 → 720p 로 720x1280.
      ok(
        `${f.name}: 회전 fixture 표시 치수 exact 720x1280 (실제 ${outDisp.width}x${outDisp.height})`,
        outDisp.width === 720 && outDisp.height === 1280,
      );
    }

    // ── A/V sync ──
    // "오디오 트랙이 있다 + 전체 duration 이 비슷하다"만으로는 싱크를 증명하지 못한다
    // (삼순 지적). 스트림별 start_time 정렬과 duration drift 를 따로 본다.
    {
      const vStart = parseFloat(vStream?.start_time ?? "NaN");
      const aStart = parseFloat(aStream?.start_time ?? "NaN");
      const vDur = parseFloat(vStream?.duration ?? outProbe.format.duration);
      const aDur = parseFloat(aStream?.duration ?? outProbe.format.duration);
      const startSkew = Math.abs(vStart - aStart);
      const durDrift = Math.abs(vDur - aDur);
      console.log(
        `  A/V: start v=${vStart.toFixed(3)} a=${aStart.toFixed(3)} (skew ${startSkew.toFixed(3)}s) · ` +
          `dur v=${vDur.toFixed(3)} a=${aDur.toFixed(3)} (drift ${durDrift.toFixed(3)}s)`,
      );
      ok(
        `${f.name}: A/V start_time 정렬 ≤ 50ms (실제 ${(startSkew * 1000).toFixed(0)}ms)`,
        Number.isFinite(startSkew) && startSkew <= 0.05,
      );
      ok(
        `${f.name}: A/V duration drift ≤ 150ms (실제 ${(durDrift * 1000).toFixed(0)}ms)`,
        Number.isFinite(durDrift) && durDrift <= 0.15,
      );
    }

    // prepared 메타가 실제 업로드본과 일치해야 서버 검증/뷰어 레이아웃이 어긋나지 않는다
    ok(
      `${f.name}: prepared 해상도가 실제 업로드본과 일치 (${res.prepared.width}x${res.prepared.height})`,
      res.prepared.width === vStream?.width && res.prepared.height === vStream?.height,
    );
    ok(`${f.name}: 포스터 썸네일도 업로드됨`, res.uploadPaths.some((p) => p.endsWith(".jpg")));
  }

  // ── 4) fallback 계약 — 정규화 실패해도 업로드는 성공하고 원본이 올라간다 ──
  console.log("\n  ── fallback (deadline 초과) ──");
  {
    const f = fixtures[0];
    const res = await page.evaluate(async (name) => {
      const mod = await import("/compress.mjs");
      const blob = await (await fetch(`/${name}.mp4`)).blob();
      const file = new File([blob], `${name}.mp4`, { type: "video/mp4" });
      const t0 = performance.now();
      const out = await mod.normalizeVenueVideo(file, {
        durationMs: 8_000,
        width: 1920,
        height: 1440,
        deadlineMs: 1,
      });
      return {
        normalized: out.normalized,
        reason: out.fallbackReason,
        sameSize: out.file.size === file.size,
        tookMs: Math.round(performance.now() - t0),
      };
    }, f.name);
    ok(`deadline 초과 → 원본 그대로 fallback (${res.tookMs}ms)`, res.normalized === false && res.sameSize === true);
    ok(`fallback 사유가 deadline 으로 기록됨 (실제=${res.reason})`, res.reason === "deadline");
  }

  await browser.close();
  server.close();

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
