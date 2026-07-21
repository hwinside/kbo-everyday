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
import { createHash } from "crypto";

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

/** 원본 path → 최적화본 path (같은 버킷, transcoded/ 프리픽스, .mp4 강제)
 *  확장자만 다른 동명 파일(same.mp4/same.mov)이 .mp4 로 고정되며 충돌하지 않도록
 *  원본 path 해시를 파일명에 포함. 같은 원본은 항상 같은 path → upsert 멱등 유지. */
function optimizedPath(origPath) {
  const name = basename(origPath).replace(/\.[^.]+$/, "");
  const dir = origPath.slice(0, origPath.length - basename(origPath).length);
  const h = createHash("sha1").update(origPath).digest("hex").slice(0, 8);
  return `transcoded/${dir}${name}-${h}.mp4`;
}

// ── 직관 라이브(venue_stories) 헬퍼 ──
let HAS_FFPROBE = true;
const VENUE_MAX_DURATION_MS = 16000; // 15초 + 여유
const VENUE_MAX_BYTES = 60 * 1024 * 1024;

/** ffprobe 로 duration(ms)/해상도 추출 */
function probeVideoMeta(input) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-show_entries", "format=duration",
    "-of", "json", input,
  ]).toString();
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  const dur = parseFloat((j.format && j.format.duration) || "0");
  return {
    durationMs: Math.round((isNaN(dur) ? 0 : dur) * 1000),
    width: s.width || null,
    height: s.height || null,
  };
}

/** 원본 media_path → 같은 폴더의 720p 최적화본 path */
function venueOptimizedPath(mediaPath) {
  const name = basename(mediaPath).replace(/\.[^.]+$/, "");
  const dir = mediaPath.slice(0, mediaPath.length - basename(mediaPath).length);
  return `${dir}${name}-720p.mp4`;
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
  // update 에러를 삼키면 상태 기록 실패해도 성공처럼 보이고 다음 실행에서 재처리됨 → throw 로 surface.
  const { error } = await supabase
    .from("video_transcode_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("original_url", originalUrl);
  if (error) throw new Error(`job 상태 기록 실패 (${originalUrl}): ${error.message}`);
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
        // 실패 경로의 상태 기록까지 throw 하면 전체 루프가 죽으므로 best-effort.
        // (기록 실패해도 다음 실행에서 재처리되므로 안전 — done 경로 silent 성공만 막으면 됨)
        try {
          await markJob(job.original_url, { status, attempts, error: String(e.message || e).slice(0, 500) });
        } catch (markErr) {
          console.log(`  ⚠️  job 상태 기록도 실패 (post ${job.post_id}): ${markErr.message}`);
        }
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

// ── 직관 라이브(venue_stories) 처리 — **복구 전용**(B+①, 삼순 09:44 #1) ──
// 즉시 경로(업로드 API 인라인 ffprobe)가 정상 동작하면 pending 은 여기 오지 않는다.
//  - pending(즉시 경로 fault 잔여): private staging 에서 다운로드 → ffprobe 재검증
//    → 통과: 720p 인코딩 후 공개 videos 버킷 게시 + **CAS(status='pending' 조건)** 로 active 승격
//    → 거부: CAS 로 removed. CAS 패배 = 즉시 경로가 먼저 처리(중복 claim 방지) → skip.
//  - active+needs_transcode(이미 공개된 원본): 720p 백그라운드 최적화만(실패해도 노출 유지).
async function processVenueStories() {
  if (!HAS_FFPROBE) {
    // ffprobe 부재 = 서버 권위 duration 검증 전면 skip → pending 영상이 방치되므로 green 으로 넘기지 않고 관제
    const { count: pendingCount } = await supabase
      .from("venue_stories")
      .select("id", { count: "exact", head: true })
      .eq("media_type", "video")
      .eq("status", "pending");
    console.error(
      `❌ ffprobe 부재 — 직관 라이브 영상 duration 검증 불가. pending ${pendingCount ?? "?"}건 미처리.`,
    );
    return { done: 0, removed: 0, failed: (pendingCount ?? 0) > 0 ? (pendingCount ?? 1) : 0, updateErrors: 0, ffprobeMissing: true };
  }
  // pending(즉시 경로 fault 잔여, staging 원본) + active·needs_transcode(720p 대기) 동시 스캔
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, status, media_url, media_bucket, media_path, transcode_attempts")
    .eq("media_type", "video")
    .or("and(status.eq.active,needs_transcode.eq.true),status.eq.pending")
    .lt("transcode_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(LIMIT);
  if (error) throw new Error(`venue_stories 조회 실패: ${error.message}`);
  if (!rows || rows.length === 0) { console.log("직관 라이브 최적화 대기 영상 없음."); return; }

  const PUBLIC_VIDEO_BUCKET = "videos";
  const work = mkdtempSync(join(tmpdir(), "kbo-venue-"));
  let done = 0, removed = 0, failed = 0, updateErrors = 0, claimedElsewhere = 0;
  try {
    for (const row of rows) {
      const isPending = row.status === "pending";
      const inPath = join(work, "in" + (basename(row.media_path).match(/\.[^.]+$/)?.[0] || ".mp4"));
      const outPath = join(work, "out.mp4");
      try {
        let inBytes;
        if (isPending) {
          // pending 원본은 private staging — 공개 URL 이 없으므로 storage API 로 다운로드
          const { data: blob, error: dlErr } = await supabase.storage
            .from(row.media_bucket)
            .download(row.media_path);
          if (dlErr || !blob) throw new Error(`staging download 실패: ${dlErr?.message || "empty"}`);
          const buf = Buffer.from(await blob.arrayBuffer());
          writeFileSync(inPath, buf);
          inBytes = buf.length;
        } else {
          inBytes = await downloadTo(row.media_url, inPath);
        }
        const meta = probeVideoMeta(inPath);
        // duration/크기 서버 권위 검증 — 초과 시 노출 없이 removed(정리 cron 이 storage 제거)
        if (meta.durationMs > VENUE_MAX_DURATION_MS || inBytes > VENUE_MAX_BYTES) {
          let rmQuery = supabase
            .from("venue_stories")
            .update({ status: "removed", transcode_attempts: row.transcode_attempts + 1 })
            .eq("id", row.id);
          if (isPending) rmQuery = rmQuery.eq("status", "pending"); // CAS — 즉시 경로와 중복 claim 방지
          const { data: rmRows, error: rmErr } = await rmQuery.select("id");
          if (rmErr) { updateErrors++; throw new Error(`removed 갱신 실패: ${rmErr.message}`); } // pending 잔류 방지 — catch 에서 재시도
          if (isPending && (rmRows ?? []).length === 0) { claimedElsewhere++; continue; }
          console.log(`  🚫 venue ${row.id} 검증실패(dur ${meta.durationMs}ms/${fmtMB(inBytes)}) → removed`);
          removed++;
          continue;
        }
        transcode(inPath, outPath);
        const outBytes = statSync(outPath).size;
        const targetBucket = isPending ? PUBLIC_VIDEO_BUCKET : row.media_bucket;
        const newPath = venueOptimizedPath(row.media_path);
        const buf = readFileSync(outPath);
        const { error: upErr } = await supabase.storage
          .from(targetBucket)
          .upload(newPath, buf, { contentType: "video/mp4", upsert: true });
        if (upErr) throw new Error(`upload 실패: ${upErr.message}`);
        const { data: pub } = supabase.storage.from(targetBucket).getPublicUrl(newPath);
        let updQuery = supabase
          .from("venue_stories")
          .update({
            media_url: pub.publicUrl,
            media_bucket: targetBucket,
            media_path: newPath,
            width: meta.width,
            height: meta.height,
            duration_ms: meta.durationMs,
            // active 경로는 status 재기록 금지 — 처리 중 신고/어드민이 removed로 내린 상태 보존
            // (불변식: worker 최적화 update는 removed 영상을 절대 되살리지 않는다)
            ...(isPending ? { status: "active" } : {}),
            needs_transcode: false,
            transcode_attempts: row.transcode_attempts + 1,
          })
          .eq("id", row.id)
          .eq("needs_transcode", true); // CAS: 이미 완료됐거나 재처리 불필요 행 방지
        // CAS: 기대 status 일치 시만 갱신(active 경로는 removed 보존, pending 경로는 즉시경로 경합 방지)
        if (isPending) updQuery = updQuery.eq("status", "pending");
        else updQuery = updQuery.eq("status", "active");
        const { data: updRows, error: updErr } = await updQuery.select("id");
        if (updErr) throw new Error(`row 갱신 실패: ${updErr.message}`);
        if ((updRows ?? []).length === 0) {
          // 0-row: status 변경됨(신고/어드민 내림 등) 또는 이미 처리 완료 → resurrect 금지
          claimedElsewhere++;
          console.log(`  ⏭️  venue ${row.id} 상태 변경됨(skip) — ${isPending ? "즉시경로 선점" : "관리자 내림 등"}`);
          continue;
        }
        // 교체 완료 — 원본 제거(pending 이면 staging 원본, active 면 공개 원본)
        if (row.media_path !== newPath) {
          try { await supabase.storage.from(row.media_bucket).remove([row.media_path]); } catch {}
        }
        console.log(`  ✅ venue ${row.id} ${fmtMB(inBytes)}→${fmtMB(outBytes)} active${isPending ? "(복구승격)" : ""}`);
        done++;
      } catch (e) {
        const attempts = row.transcode_attempts + 1;
        // DB 갱신 실패는 명시 로그(성공처럼 넘기지 않음) — 다음 실행이 재시도
        let failQuery;
        let catchStatus;
        if (isPending) {
          // pending 경로: 재시도 소진 시 removed, 아니면 pending 유지 — 즉시경로가 승격한 행 건드리지 않음
          catchStatus = attempts >= MAX_ATTEMPTS ? "removed" : "pending";
          failQuery = supabase
            .from("venue_stories")
            .update({ transcode_attempts: attempts, status: catchStatus })
            .eq("id", row.id)
            .eq("status", "pending"); // CAS: 즉시경로가 이미 active로 승격했으면 0-row skip
        } else {
          // active 경로: status 재기록 절대 금지 — 처리 중 신고/어드민이 removed로 내린 상태 보존
          // (불변식: worker catch 도 removed 영상을 active로 되살리지 않는다)
          catchStatus = "active"; // 로그 출력용(실제 DB 기록 아님)
          failQuery = supabase
            .from("venue_stories")
            .update({ transcode_attempts: attempts }) // status 제외 — CAS 미일치 행 보존
            .eq("id", row.id)
            .eq("status", "active")       // CAS: removed 된 행이면 0-row → skip
            .eq("needs_transcode", true);  // CAS: 다른 worker가 이미 완료했으면 skip
        }
        const { data: failRows, error: updErr } = await failQuery.select("id");
        if (updErr) {
          updateErrors++;
          console.log(`  ⚠️ venue ${row.id} 상태갱신 실패(다음 실행 재시도): ${updErr.message}`);
        } else if ((failRows ?? []).length === 0) {
          // 0-row: 처리 중 removed/완료됨 → skip(resurrect 금지) — 성공 경로와 동일 카운팅
          claimedElsewhere++;
          console.log(`  ⏭️  venue ${row.id} catch-skip — ${isPending ? "즉시경로 선점" : "관리자 내림 등"} (${e.message || e})`);
        } else {
          console.log(`  ❌ venue ${row.id} ${catchStatus} (${attempts}/${MAX_ATTEMPTS}): ${e.message || e}`);
          failed++;
        }
      } finally {
        for (const f of [inPath, outPath]) { try { rmSync(f); } catch {} }
      }
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
  console.log(`직관 라이브 처리: ✅${done} 🚫${removed} ❌${failed} ⏭️${claimedElsewhere} (상태갱신오류 ${updateErrors})`);
  // 실패 건/상태기록 실패가 있으면 지속 pending/removed 실패 관제를 위해 비정상 종료 시그널을 올린다.
  return { done, removed, failed, updateErrors };
}

// ── main ──
(async () => {
  // ffmpeg 존재 확인
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { console.error("❌ ffmpeg 없음 — brew install ffmpeg"); process.exit(1); }
  try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); }
  catch { HAS_FFPROBE = false; console.warn("⚠️  ffprobe 없음 — 직관 라이브 영상 duration 검증 불가"); }

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

  console.log("\n── 직관 라이브(venue_stories) 영상 처리 ──");
  const venueRes = (await processVenueStories()) || { failed: 0, updateErrors: 0 };
  if ((venueRes.failed || 0) > 0 || (venueRes.updateErrors || 0) > 0 || venueRes.ffprobeMissing) {
    console.error(
      `❌ 직관 라이브 처리 이상 — 실패 ${venueRes.failed} / 상태기록오류 ${venueRes.updateErrors}${venueRes.ffprobeMissing ? " / ffprobe 부재" : ""} — 관제 non-zero 종료`,
    );
    process.exit(1);
  }
})().catch((e) => { console.error("❌", e); process.exit(1); });
