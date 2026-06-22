#!/usr/bin/env node
/**
 * 커뮤니티 동영상 트랜스코딩 워커 (Mac mini 크론)
 *
 * 문제: 커뮤니티 영상(움짤콜렉터 photos 버킷 + 유저 업로드 videos 버킷)이 원본 무압축으로
 *       Supabase Storage 에서 그대로 서빙돼 로딩이 느리다. (사진은 업로드 시 클라 압축되지만
 *       영상은 압축 경로가 없었음.)
 *
 * 해법: posts.video_urls 의 영상을 720p(긴 변 ≤1280) H.264 + faststart 로 재인코딩 →
 *       최적화본 업로드 → video_urls 를 스왑. 신규 영상뿐 아니라 기존 라이브러리도 백필.
 *       Vercel 서버리스(움짤콜렉터 발행 경로)는 30초 제한 + ffmpeg 부재라 여기 Mac mini 로 분리.
 *
 * 멱등성: video_transcode_jobs(original_url UNIQUE) 로 추적. done/skipped/failed(한도) 는 재처리 안 함.
 *
 * Usage:
 *   node scripts/transcode-videos.mjs                  # dry-run: 대상/상태 카운트만 출력 (DB 무변경)
 *   node scripts/transcode-videos.mjs --probe [--limit 1]
 *                                                      # 최신 영상 N개 다운로드+인코딩, 용량 절감만 보고
 *                                                      #   (업로드/스왑/DB 쓰기 전혀 안 함 — 검증용)
 *   node scripts/transcode-videos.mjs --apply [--limit 20]
 *                                                      # 실제 처리: 발견→인코딩→업로드→video_urls 스왑
 *   node scripts/transcode-videos.mjs --apply --post 1234
 *                                                      # 특정 post 만 처리
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, rmSync, statSync, mkdtempSync } from "fs";
import { resolve, join, basename } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

// ── env (.env.local 수동 파싱, dotenv 의존성 없음 — award-event-badges.mjs 패턴) ──
try {
  const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {
  console.warn("⚠️  .env.local 못 읽음 — 환경변수가 이미 주입돼 있다고 가정");
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("❌ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── args ──
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PROBE = argv.includes("--probe");
const LIMIT = argv.includes("--limit")
  ? parseInt(argv[argv.indexOf("--limit") + 1], 10)
  : PROBE ? 1 : 20;
const ONLY_POST = argv.includes("--post")
  ? parseInt(argv[argv.indexOf("--post") + 1], 10)
  : null;

const MAX_ATTEMPTS = 3;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|qt)(\?|$)/i;
const PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

// ── helpers ──

/** Supabase public URL → { bucket, path } (없으면 null) */
function parsePublicUrl(url) {
  const m = url.match(PUBLIC_RE);
  if (!m) return null;
  return { bucket: m[1], path: decodeURIComponent(m[2].split("?")[0]) };
}

function isVideoUrl(url) {
  return typeof url === "string" && VIDEO_EXT.test(url);
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + "MB";
}

/** 원본 path → 최적화본 path (같은 버킷, transcoded/ 프리픽스, .mp4 강제) */
function optimizedPath(origPath) {
  const name = basename(origPath).replace(/\.[^.]+$/, "");
  // 같은 원본을 또 처리해도 경로가 안정적이도록 원본 경로 구조 유지
  const dir = origPath.slice(0, origPath.length - basename(origPath).length);
  return `transcoded/${dir}${name}.mp4`;
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

/** ffmpeg 720p(긴 변 ≤1280) H.264 + faststart. 출력 파일 경로 반환. */
function transcode(input, output) {
  execFileSync(
    "ffmpeg",
    [
      "-y", "-i", input,
      // 1280x1280 박스에 맞춰 축소(확대 안 함) 후 짝수 보정 (libx264 yuv420p 요구)
      "-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "27",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  return output;
}

/** posts.video_urls 에서 origUrl → newUrl 스왑 (순서/다른 항목 보존). 최신값 재조회 후 갱신. */
async function swapVideoUrl(postId, origUrl, newUrl) {
  const { data: post, error } = await supabase
    .from("posts").select("video_urls").eq("id", postId).single();
  if (error || !post) throw new Error(`post ${postId} 조회 실패: ${error?.message}`);
  const urls = (post.video_urls ?? []).map((u) => (u === origUrl ? newUrl : u));
  const { error: upErr } = await supabase
    .from("posts").update({ video_urls: urls }).eq("id", postId);
  if (upErr) throw new Error(`post ${postId} 스왑 실패: ${upErr.message}`);
}

async function markJob(originalUrl, fields) {
  await supabase
    .from("video_transcode_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("original_url", originalUrl);
}

// ── 1) 발견: posts.video_urls 중 jobs 에 없는 영상 URL → pending 등록 ──
async function discover() {
  let q = supabase
    .from("posts")
    .select("id, video_urls")
    .order("id", { ascending: false });
  if (ONLY_POST) q = q.eq("id", ONLY_POST);
  const { data: posts, error } = await q;
  if (error) throw new Error(`posts 조회 실패: ${error.message}`);

  const pairs = []; // { postId, url }
  for (const p of posts ?? []) {
    for (const url of p.video_urls ?? []) {
      // 이미 최적화된(스왑된) URL 은 재처리 대상 아님 — 무한 재인코딩 방지
      if (isVideoUrl(url) && parsePublicUrl(url) && !url.includes("/transcoded/")) {
        pairs.push({ postId: p.id, url });
      }
    }
  }
  if (pairs.length === 0) return { discovered: 0, totalVideos: 0 };

  // 이미 jobs 에 있는 URL 제외
  const { data: existing } = await supabase
    .from("video_transcode_jobs").select("original_url");
  const known = new Set((existing ?? []).map((r) => r.original_url));
  const fresh = pairs.filter((x) => !known.has(x.url));

  if (APPLY && fresh.length > 0) {
    // 중복 URL 안전하게 한 번에 등록 (original_url UNIQUE → onConflict 무시)
    const rows = fresh.map((x) => ({ post_id: x.postId, original_url: x.url, status: "pending" }));
    const { error: insErr } = await supabase
      .from("video_transcode_jobs").upsert(rows, { onConflict: "original_url", ignoreDuplicates: true });
    if (insErr) throw new Error(`job 등록 실패: ${insErr.message}`);
  }
  return { discovered: fresh.length, totalVideos: pairs.length };
}

// ── 2) 처리: pending/재시도 job 을 최신 post 순으로 ──
async function processJobs() {
  let q = supabase
    .from("video_transcode_jobs")
    .select("id, post_id, original_url, attempts, status")
    .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`)
    .order("post_id", { ascending: false })
    .limit(LIMIT);
  if (ONLY_POST) q = q.eq("post_id", ONLY_POST);
  const { data: jobs, error } = await q;
  if (error) throw new Error(`jobs 조회 실패: ${error.message}`);
  if (!jobs || jobs.length === 0) {
    console.log("처리할 job 없음.");
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "kbo-transcode-"));
  let done = 0, skipped = 0, failed = 0;

  try {
    for (const job of jobs) {
      const parsed = parsePublicUrl(job.original_url);
      const inPath = join(work, "in" + (basename(parsed.path).match(/\.[^.]+$/)?.[0] || ".mp4"));
      const outPath = join(work, "out.mp4");
      try {
        const inBytes = await downloadTo(job.original_url, inPath);
        transcode(inPath, outPath);
        const outBytes = statSync(outPath).size;
        const ratio = ((1 - outBytes / inBytes) * 100).toFixed(0);

        if (outBytes >= inBytes * 0.95) {
          // 절감 미미 → 원본 유지
          console.log(`  ⏭️  post ${job.post_id} ${fmtMB(inBytes)}→${fmtMB(outBytes)} (절감 ${ratio}%) skip`);
          await markJob(job.original_url, { status: "skipped", original_bytes: inBytes, optimized_bytes: outBytes, attempts: job.attempts + 1 });
          skipped++;
          continue;
        }

        const newPath = optimizedPath(parsed.path);
        const buf = readFileSync(outPath);
        const { error: upErr } = await supabase.storage
          .from(parsed.bucket)
          .upload(newPath, buf, { contentType: "video/mp4", upsert: true });
        if (upErr) throw new Error(`upload 실패: ${upErr.message}`);
        const { data: pub } = supabase.storage.from(parsed.bucket).getPublicUrl(newPath);

        await swapVideoUrl(job.post_id, job.original_url, pub.publicUrl);
        await markJob(job.original_url, {
          status: "done", optimized_url: pub.publicUrl,
          original_bytes: inBytes, optimized_bytes: outBytes, attempts: job.attempts + 1, error: null,
        });
        console.log(`  ✅ post ${job.post_id} ${fmtMB(inBytes)}→${fmtMB(outBytes)} (절감 ${ratio}%)`);
        done++;
      } catch (e) {
        const attempts = job.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        await markJob(job.original_url, { status, attempts, error: String(e.message || e).slice(0, 500) });
        console.log(`  ❌ post ${job.post_id} ${status} (${attempts}/${MAX_ATTEMPTS}): ${e.message || e}`);
        failed++;
      } finally {
        for (const f of [inPath, outPath]) { try { rmSync(f); } catch {} }
      }
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n처리 완료: ✅${done} ⏭️${skipped} ❌${failed}`);
}

// ── probe: 최신 영상 N개 다운로드+인코딩, 용량 절감만 보고 (DB/스토리지 무변경) ──
async function probe() {
  let q = supabase
    .from("posts").select("id, video_urls").order("id", { ascending: false }).limit(500);
  if (ONLY_POST) q = q.eq("id", ONLY_POST);
  const { data: posts, error } = await q;
  if (error) throw new Error(`posts 조회 실패: ${error.message}`);
  const samples = [];
  for (const p of posts ?? []) {
    for (const url of p.video_urls ?? []) {
      if (isVideoUrl(url) && parsePublicUrl(url) && !url.includes("/transcoded/")) {
        samples.push({ postId: p.id, url });
      }
    }
    if (samples.length >= LIMIT) break;
  }
  if (samples.length === 0) { console.log("샘플 영상 없음."); return; }

  const work = mkdtempSync(join(tmpdir(), "kbo-probe-"));
  try {
    let totIn = 0, totOut = 0;
    for (const s of samples.slice(0, LIMIT)) {
      const inPath = join(work, "in.mp4"), outPath = join(work, "out.mp4");
      try {
        const inBytes = await downloadTo(s.url, inPath);
        transcode(inPath, outPath);
        const outBytes = statSync(outPath).size;
        totIn += inBytes; totOut += outBytes;
        console.log(`post ${s.postId}: ${fmtMB(inBytes)} → ${fmtMB(outBytes)} (절감 ${((1 - outBytes / inBytes) * 100).toFixed(0)}%)`);
      } catch (e) {
        console.log(`post ${s.postId}: ❌ ${e.message || e}`);
      } finally {
        for (const f of [inPath, outPath]) { try { rmSync(f); } catch {} }
      }
    }
    if (totIn > 0) console.log(`\n합계: ${fmtMB(totIn)} → ${fmtMB(totOut)} (절감 ${((1 - totOut / totIn) * 100).toFixed(0)}%)`);
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

// ── main ──
(async () => {
  // ffmpeg 존재 확인
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { console.error("❌ ffmpeg 없음 — brew install ffmpeg"); process.exit(1); }

  if (PROBE) {
    console.log(`🔍 probe (최신 ${LIMIT}개, DB/스토리지 무변경)\n`);
    await probe();
    return;
  }

  const { discovered, totalVideos } = await discover();
  console.log(`발견: 영상 URL ${totalVideos}개 중 신규 ${discovered}개${APPLY ? " (pending 등록)" : " (dry-run, 미등록)"}`);

  if (!APPLY) {
    const { count: pending } = await supabase
      .from("video_transcode_jobs").select("*", { count: "exact", head: true })
      .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`);
    console.log(`처리 대기(pending+재시도): ${pending ?? "?"}개`);
    console.log(`\n실제 처리하려면 --apply (검증은 --probe).`);
    return;
  }
  await processJobs();
})().catch((e) => { console.error("❌", e); process.exit(1); });
