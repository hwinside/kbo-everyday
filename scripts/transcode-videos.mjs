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
 *   node scripts/transcode-videos.mjs --reencode-probe [--limit 5]
 *                                                      # 재인코딩 백필 대상(status=done & 구 프로필)을
 *                                                      #   raw original_url 로 실측 — DB/스토리지 무변경
 *   node scripts/transcode-videos.mjs --apply --reencode [--limit 20]
 *                                                      # 백필 실행: 새 버전 경로 업로드 → posts 스왑 → 세대 마킹
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
import { processVenueJob } from "./venue-transcode-job.mjs";
import { processReencodeJob } from "./reencode-job.mjs";
import {
  VIDEO_PROFILES,
  buildTranscodeArgs,
  shouldReplaceWithReencode,
  COMMUNITY_PROFILE_VERSION,
  pickReencodeTargets,
  reencodeJobFields,
  isMissingProfileVersionColumn,
  optimizedPath,
} from "./video-profiles.mjs";

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
// 이미 done 인 job 을 새 인코딩 프로필로 다시 돌려 용량 백필(새 버전 URL 발행, --apply 필요).
const REENCODE = argv.includes("--reencode");
// 백필 대상을 reencode 와 같은 로직으로 골라 절감률만 실측(DB/스토리지 무변경).
const REENCODE_PROBE = argv.includes("--reencode-probe");
const LIMIT = argv.includes("--limit")
  ? parseInt(argv[argv.indexOf("--limit") + 1], 10)
  : PROBE ? 1 : REENCODE_PROBE ? 3 : 20;
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

// ── 직관 라이브(venue_stories) 헬퍼 ──
let HAS_FFPROBE = true;

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

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

/** ffmpeg H.264 + faststart 재인코딩. 출력 파일 경로 반환. */
function transcode(input, output, profile = VIDEO_PROFILES.community) {
  execFileSync("ffmpeg", buildTranscodeArgs(input, output, profile), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return output;
}

/** 직관 라이브 전용 — 기존 venue 프로필 유지(커뮤니티 압축 강화가 스토리 화질을 건드리지 않게 분리). */
function transcodeVenue(input, output) {
  return transcode(input, output, VIDEO_PROFILES.venue);
}

/** posts.video_urls 에서 origUrl → newUrl 스왑 (순서/다른 항목 보존). 최신값 재조회 후 갱신.
 *  실제 치환된 항목 수를 반환 — 0 이면 posts 가 그 URL 을 안 들고 있다는 뜻(재인코딩 경로 판별용). */
async function swapVideoUrl(postId, origUrl, newUrl) {
  const { data: post, error } = await supabase
    .from("posts").select("video_urls").eq("id", postId).single();
  if (error || !post) throw new Error(`post ${postId} 조회 실패: ${error?.message}`);
  const current = post.video_urls ?? [];
  const replaced = current.filter((u) => u === origUrl).length;
  const urls = current.map((u) => (u === origUrl ? newUrl : u));
  const { error: upErr } = await supabase
    .from("posts").update({ video_urls: urls }).eq("id", postId);
  if (upErr) throw new Error(`post ${postId} 스왑 실패: ${upErr.message}`);
  return replaced;
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

        // 신규 처리분도 현재 프로필 경로(-v2)로 발행하고 profile_version 을 찍는다
        // → 재인코딩 백필이 방금 만든 최신본을 다시 잡지 않는다.
        const newPath = optimizedPath(parsed.path, COMMUNITY_PROFILE_VERSION);
        const buf = readFileSync(outPath);
        const { error: upErr } = await supabase.storage
          .from(parsed.bucket)
          .upload(newPath, buf, { contentType: "video/mp4", upsert: true });
        if (upErr) throw new Error(`upload 실패: ${upErr.message}`);
        const { data: pub } = supabase.storage.from(parsed.bucket).getPublicUrl(newPath);

        await swapVideoUrl(job.post_id, job.original_url, pub.publicUrl);
        await markJob(job.original_url, {
          status: "done", optimized_url: pub.publicUrl, profile_version: COMMUNITY_PROFILE_VERSION,
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

// ── reencode: 이미 done 인 job 을 새 프로필로 재인코딩(용량 백필) ──
//
// 재인코딩 원본은 항상 original_url(보존된 raw) — 이미 압축된 결과물을 다시 압축하면
// 세대 손실(generation loss)이 쌓인다.
//
// 전진성(progress): 대상은 `status=done AND profile_version < COMMUNITY_PROFILE_VERSION`.
//   교체(replaced)든 절감 미미 유지(kept)든 처리한 행은 profile_version 을 현재값으로 마킹한다
//   → 다음 배치에서 다시 안 잡힌다 → 배치가 반복될수록 후보 집합이 단조 감소하고 결국 0이 된다.
//   실패 건만 미마킹 → 다음 실행에서 자연 재시도(무한 루프 방지는 후보 감소 + 운영 관측으로).
//
// CDN 안전(blocker 4): 운영 응답이 `Cache-Control: max-age=3600` + Cloudflare HIT 라
//   같은 public URL 에 다른 바이트를 upsert 하면 stale/mixed 응답이 생긴다.
//   → v2 이상은 **새 버전 경로(-v2)에 새 객체**를 올리고 posts.video_urls 를 교체한다.
//   순서: 업로드 성공 → posts 스왑 → job 마킹. 중간에 죽어도 기존 URL 이 계속 서빙되므로 노출 영향 0.
//   구 객체는 이 단계에서 삭제하지 않는다(롤백 여지 + CDN TTL 만료 대기).

/** 재인코딩 백필 후보 조회 — reencode() 와 --reencode-probe 가 **같은 선택 로직**을 쓴다.
 *  마이그레이션 미적용 환경에서는 profile_version 컬럼이 없으므로, 읽기 전용 probe 에 한해
 *  컬럼 없이 재조회하고 전 행을 세대 0(=전부 백필 대상)으로 간주한다. 쓰기 경로는 호출 전에 막는다. */
async function fetchReencodeTargets({ allowMissingColumn = false } = {}) {
  const COLS = "id, post_id, original_url, optimized_url, original_bytes, optimized_bytes, attempts, status";
  const build = (withVersion) => {
    // query-guard: bounded -- backfill batch drains a shrinking set: every processed row is stamped
    // with profile_version = COMMUNITY_PROFILE_VERSION (both replaced and kept), so this predicate
    // can never re-select it and the candidate set decreases monotonically to zero.
    let q = supabase
      .from("video_transcode_jobs")
      .select(withVersion ? `${COLS}, profile_version` : COLS)
      .eq("status", "done")
      .order("optimized_bytes", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(LIMIT);
    if (withVersion) q = q.lt("profile_version", COMMUNITY_PROFILE_VERSION);
    if (ONLY_POST) q = q.eq("post_id", ONLY_POST);
    return q;
  };

  let { data, error } = await build(true);
  if (error && allowMissingColumn && isMissingProfileVersionColumn(error)) {
    console.log("⚠️  profile_version 컬럼 없음(마이그레이션 미적용) — 전 행을 세대 0으로 보고 실측만 진행");
    ({ data, error } = await build(false));
  }
  if (error) throw new Error(`jobs 조회 실패: ${error.message}`);
  // 순수 선택 규칙(정렬·상한·세대 필터)을 회귀 테스트 가능한 모듈에 위임 — DB 쿼리와 동치.
  return pickReencodeTargets(data ?? [], LIMIT);
}

async function reencode() {
  // 쓰기 경로는 컬럼 없이 돌면 안 된다 — 세대 마킹이 불가능해 매 배치가 같은 행을 재선택한다(전진성 붕괴).
  const jobs = await fetchReencodeTargets();
  if (jobs.length === 0) { console.log("재인코딩 대상 없음."); return; }

  const work = mkdtempSync(join(tmpdir(), "kbo-reencode-"));
  let replaced = 0, kept = 0, failed = 0, totBefore = 0, totAfter = 0;
  try {
    for (const job of jobs) {
      const parsed = parsePublicUrl(job.original_url);
      if (!parsed) {
        // 원본 URL 을 못 읽으면 이 세대로는 영구히 처리 불가 → 마킹해 슬롯을 비운다(전진성 보장).
        console.log(`  ⚠️  post ${job.post_id} 원본 URL 파싱 불가 — skip(세대 마킹)`);
        await markJob(job.original_url, reencodeJobFields("kept"));
        kept++;
        continue;
      }
      const inPath = join(work, "in" + (basename(parsed.path).match(/\.[^.]+$/)?.[0] || ".mp4"));
      const outPath = join(work, "out.mp4");
      try {
        const res = await processReencodeJob(job, {
          storage: supabase.storage,
          runner: { transcode, downloadToFile: downloadTo },
          markJob, swapVideoUrl, parsed, inPath, outPath,
        });
        const served = res.servedBytes ?? res.inBytes;
        if (res.outcome === "replaced") {
          if (res.reusedExisting) console.log(`  ↩️  post ${job.post_id} 이전 실행 업로드본 재사용(중복) — 스왑/마킹만 이어감`);
          if (res.swapped === 0) console.log(`  ⚠️  post ${job.post_id} posts 에 기존 최적화 URL 없음(수정/삭제됨?) — 스왑 0건`);
          totBefore += served; totAfter += res.outBytes;
          console.log(`  ✅ post ${job.post_id} ${fmtMB(served)}→${fmtMB(res.outBytes)}`);
          replaced++;
        } else if (res.outcome === "kept") {
          console.log(`  ⏭️  post ${job.post_id} ${fmtMB(served)}→${fmtMB(res.outBytes)} 절감 미미 keep`);
          kept++;
        } else {
          console.log(`  ❌ post ${job.post_id} 재인코딩 실패(기존 서빙본 유지): ${res.error?.message || res.error}`);
          failed++;
        }
      } finally {
        for (const f of [inPath, outPath]) { try { rmSync(f); } catch {} }
      }
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n재인코딩: ✅${replaced} ⏭️${kept} ❌${failed}`);
  if (totBefore > 0) {
    console.log(`교체분 합계: ${fmtMB(totBefore)} → ${fmtMB(totAfter)} (절감 ${((1 - totAfter / totBefore) * 100).toFixed(0)}%)`);
  }
}

// ── reencode-probe: 백필 대상을 raw original_url 로 실측만(DB/스토리지 무변경) ──
// probe() 는 아직 job 이 없는 신규 영상만 본다(/transcoded/ 제외) → 이미 done 인 182건의
// 새 프로필 효과를 검증할 수 없다. 이 경로는 reencode() 와 **동일한 fetchReencodeTargets()** 로
// 대상을 고르고 인코딩까지만 수행해 절감률을 보고한다. 업로드/스왑/마킹을 전혀 하지 않는다.
async function reencodeProbe() {
  const jobs = await fetchReencodeTargets({ allowMissingColumn: true });
  if (jobs.length === 0) { console.log("재인코딩 대상 없음(백필 완료 상태)."); return; }

  const work = mkdtempSync(join(tmpdir(), "kbo-reencode-probe-"));
  let totServed = 0, totNew = 0, wouldReplace = 0, wouldKeep = 0, failed = 0;
  try {
    for (const job of jobs) {
      const parsed = parsePublicUrl(job.original_url);
      if (!parsed) { console.log(`post ${job.post_id}: ⚠️ 원본 URL 파싱 불가`); failed++; continue; }
      const inPath = join(work, "in" + (basename(parsed.path).match(/\.[^.]+$/)?.[0] || ".mp4"));
      const outPath = join(work, "out.mp4");
      try {
        const inBytes = await downloadTo(job.original_url, inPath);
        transcode(inPath, outPath);
        const outBytes = statSync(outPath).size;
        const servedBytes = job.optimized_bytes ?? inBytes;
        const replace = shouldReplaceWithReencode(outBytes, job.optimized_bytes ?? null, inBytes);
        if (replace) wouldReplace++; else wouldKeep++;
        totServed += servedBytes; totNew += outBytes;
        console.log(
          `post ${job.post_id}: 서빙 ${fmtMB(servedBytes)} → 신규 ${fmtMB(outBytes)} ` +
          `(절감 ${((1 - outBytes / servedBytes) * 100).toFixed(0)}%) ${replace ? "교체예정" : "유지"}`,
        );
      } catch (e) {
        console.log(`post ${job.post_id}: ❌ ${e.message || e}`);
        failed++;
      } finally {
        for (const f of [inPath, outPath]) { try { rmSync(f); } catch {} }
      }
    }
    if (totServed > 0) {
      console.log(`\n합계(서빙본 기준): ${fmtMB(totServed)} → ${fmtMB(totNew)} (절감 ${((1 - totNew / totServed) * 100).toFixed(0)}%)`);
    }
    console.log(`판정: 교체예정 ${wouldReplace} / 유지 ${wouldKeep} / 실패 ${failed} — DB·스토리지 무변경`);
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
  // query-guard: bounded -- 워커 1회당 고정 LIMIT 영상만 처리
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("id, status, media_url, media_bucket, media_path, transcode_attempts, attendance_source")
    .eq("media_type", "video")
    .or("and(status.eq.active,needs_transcode.eq.true),status.eq.pending")
    .lt("transcode_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(LIMIT);
  if (error) throw new Error(`venue_stories 조회 실패: ${error.message}`);
  if (!rows || rows.length === 0) { console.log("직관 라이브 최적화 대기 영상 없음."); return; }

  const work = mkdtempSync(join(tmpdir(), "kbo-venue-"));
  let done = 0, removed = 0, failed = 0, updateErrors = 0, claimedElsewhere = 0;
  try {
    for (const row of rows) {
      const inPath = join(work, "in" + (basename(row.media_path).match(/\.[^.]+$/)?.[0] || ".mp4"));
      const outPath = join(work, "out.mp4");
      try {
        const res = await processVenueJob(row, {
          db: supabase,
          storage: supabase.storage,
          runner: {
            probe: probeVideoMeta,
            // 직관 라이브는 기존 venue 프로필 유지 — 커뮤니티 압축 강화가 스토리 화질을 건드리지 않게 분리.
            transcode: transcodeVenue,
            downloadToFile: downloadTo,
          },
          inPath,
          outPath,
          maxAttempts: MAX_ATTEMPTS,
        });
        if (res.result === "done") done++;
        else if (res.result === "removed") removed++;
        else if (res.result === "claimedElsewhere") claimedElsewhere++;
        else if (res.result === "updateError") updateErrors++;
        else if (res.result === "failed") failed++;
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

  if (REENCODE_PROBE) {
    console.log(`🔍 reencode-probe (백필 대상 ${LIMIT}개, DB/스토리지 무변경)\n`);
    await reencodeProbe();
    return;
  }

  if (PROBE) {
    console.log(`🔍 probe (최신 ${LIMIT}개, DB/스토리지 무변경)\n`);
    await probe();
    return;
  }

  if (REENCODE) {
    if (!APPLY) {
      console.log("--reencode 는 --apply 와 함께 써야 합니다(실제 교체 수행). 검증은 --reencode-probe.");
      return;
    }
    console.log(`♻️  reencode (백필 대상 ${LIMIT}개, 용량 큰 순 / 프로필 v${COMMUNITY_PROFILE_VERSION})\n`);
    await reencode();
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
