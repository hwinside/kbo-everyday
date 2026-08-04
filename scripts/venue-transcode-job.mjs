/**
 * venue_stories 영상 1행 처리 단위 — 성공 update + catch 경로 포함.
 * deps={db, storage, runner}를 주입받아 단독 테스트 가능.
 * 실사용: transcode-videos.mjs가 이 함수를 호출.
 */
import { writeFileSync, readFileSync, statSync } from "fs";
import { basename } from "path";

const VENUE_MAX_DURATION_MS = 16000; // 15초 + 여유
const VENUE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 워커 조회 술어 — **실행 경로가 쓰는 값 그자체**를 여기서 만든다.
 * 종전에는 이 문자열이 transcode-videos.mjs 안에 인라인이었고, 스모크가 그걸 regex 로
 * 검색했다 — 그래서 실행 술어에서 archived 를 빼고 주석에만 남겨도 GREEN 이었다
 * (삼순 독립 재현, 2026-08-04). 이젠 생성 함수를 공유해 행동으로 검증한다.
 *
 * 대상:
 *  - pending: 즉시 경로 fault 잔여(staging 원본)
 *  - active + needs_transcode: 공개 트레이 720p 대기
 *  - archived + needs_transcode: 다이어리 전용(이걸 빼놓았던 게 blocker ③의 구멍)
 */
export function venueTranscodeOrFilter() {
  return [
    "and(status.eq.active,needs_transcode.eq.true)",
    "and(status.eq.archived,needs_transcode.eq.true)",
    "status.eq.pending",
  ].join(",");
}

/**
 * venue_stories 최적화 대상 조회 — 주입 가능한 seam.
 * 실제 워커와 스모크가 **같은 함수**를 타서, 조회 조건이 바뀌면 스모크가 즉시 RED 가 된다.
 * @returns {Promise<{data: unknown[]|null, error: unknown}>}
 */
export async function selectVenueTranscodeTargets(db, { maxAttempts, limit }) {
  // query-guard: bounded -- 워커 1회당 고정 limit 영상만 처리
  return db
    .from("venue_stories")
    .select(
      "id, status, media_url, media_bucket, media_path, transcode_attempts, attendance_source",
    )
    .eq("media_type", "video")
    .or(venueTranscodeOrFilter())
    .lt("transcode_attempts", maxAttempts)
    .order("created_at", { ascending: true })
    .limit(limit);
}
// A안 A1: 신규 영상은 private venue-media 로 승격·보관(공개 videos 아님). 서빙은 서버 signed URL.
const VENUE_PRIVATE_MEDIA_BUCKET = "venue-media";
// private venue 버킷: 공개 URL 이 없으므로 media_url 다운로드 대신 storage API 로 받는다.
const PRIVATE_VENUE_BUCKETS = new Set(["venue-media", "venue-staging"]);
const MAX_ATTEMPTS_DEFAULT = 3;

/** 원본 media_path → 같은 폴더의 720p 최적화본 path */
export function venueOptimizedPath(mediaPath) {
  const name = basename(mediaPath).replace(/\.[^.]+$/, "");
  const dir = mediaPath.slice(0, mediaPath.length - basename(mediaPath).length);
  return `${dir}${name}-720p.mp4`;
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + "MB";
}

/**
 * venue_stories 행 1건 처리 — 성공·제거·예외 catch 경로 전체 포함.
 *
 * @param row {{
 *   id: number,
 *   status: string,
 *   media_url: string,
 *   media_bucket: string,
 *   media_path: string,
 *   transcode_attempts: number,
 * }}
 * @param deps {{
 *   db: object,         // .from(table).update(payload).eq(col,val)...select(cols) 체인
 *   storage: object,    // .from(bucket).download(path)/.upload(path,buf,opts)/.getPublicUrl(path)/.remove(paths)
 *   runner: {
 *     probe(filePath: string): { durationMs: number, width: number|null, height: number|null },
 *     transcode(inPath: string, outPath: string): void,
 *     downloadToFile(url: string, destPath: string): Promise<number>,
 *   },
 *   inPath: string,    // 호출자가 제공하는 임시 입력 파일 경로
 *   outPath: string,   // 호출자가 제공하는 임시 출력 파일 경로
 *   maxAttempts?: number,
 * }}
 * @returns {Promise<
 *   | { result: "done",            inBytes: number, outBytes: number, isPending: boolean }
 *   | { result: "removed",         inBytes: number, durationMs: number }
 *   | { result: "claimedElsewhere", isPending: boolean }
 *   | { result: "failed",          error: unknown, attempts: number, catchStatus: string, isPending: boolean }
 *   | { result: "updateError",     error: unknown, dbError: unknown }
 * >}
 */
export async function processVenueJob(row, deps) {
  const { db, storage, runner, inPath, outPath, maxAttempts = MAX_ATTEMPTS_DEFAULT } = deps;
  const isPending = row.status === "pending";
  const pendingTargetStatus =
    row.attendance_source === "diary_manual" ? "archived" : "active";
  // 이미 게시된 행의 최적화 경로는 status 를 절대 바꾸지 않고 그 값을 CAS 조건으로 쓴다.
  // active(공개 트레이)와 archived(다이어리 전용) 둘 다 대상 — 종전에는 active 만 처리해
  // diary_manual 느린 원본이 영구 미최적화로 남았다(삼순 blocker ③, 2026-08-04).
  const publishedStatus = row.status;
  // A안 A1: pending staging 뿐 아니라 active private(venue-media) 원본도 공개 URL 이 없다
  // → storage API 로 다운로드. 레거시 공개 버킷(videos) active 만 media_url 다운로드.
  const usePrivateDownload = isPending || PRIVATE_VENUE_BUCKETS.has(row.media_bucket);

  try {
    let inBytes;
    if (usePrivateDownload) {
      // private 원본(staging/venue-media) — 공개 URL 이 없으므로 storage API 로 다운로드
      const { data: blob, error: dlErr } = await storage.from(row.media_bucket).download(row.media_path);
      if (dlErr || !blob) throw new Error(`private download 실패: ${dlErr?.message || "empty"}`);
      const buf = Buffer.from(await blob.arrayBuffer());
      writeFileSync(inPath, buf);
      inBytes = buf.length;
    } else {
      inBytes = await runner.downloadToFile(row.media_url, inPath);
    }

    const meta = runner.probe(inPath);

    // duration/크기 서버 권위 검증 — 초과 시 노출 없이 removed(정리 cron 이 storage 제거)
    if (meta.durationMs > VENUE_MAX_DURATION_MS || inBytes > VENUE_MAX_BYTES) {
      let rmQuery = db
        .from("venue_stories")
        // 검증실패 removed 도 즉시삭제 금지·30일 격리(스펙 §2.2) — removed_at 으로 격리 시계 시작.
        .update({ status: "removed", removed_at: new Date().toISOString(), transcode_attempts: row.transcode_attempts + 1 })
        .eq("id", row.id);
      if (isPending) rmQuery = rmQuery.eq("status", "pending"); // CAS — 즉시 경로와 중복 claim 방지
      const { data: rmRows, error: rmErr } = await rmQuery.select("id");
      if (rmErr) throw new Error(`removed 갱신 실패: ${rmErr.message}`); // pending 잔류 방지 — catch에서 재시도
      if (isPending && (rmRows ?? []).length === 0) {
        return { result: "claimedElsewhere", isPending };
      }
      console.log(`  🚫 venue ${row.id} 검증실패(dur ${meta.durationMs}ms/${fmtMB(inBytes)}) → removed`);
      return { result: "removed", inBytes, durationMs: meta.durationMs };
    }

    runner.transcode(inPath, outPath);
    const outBytes = statSync(outPath).size;
    // 산출물을 **다시 probe** 해 실제 출력 메타를 기록한다.
    // 종전에는 입력 meta 를 그대로 썼는데, ffmpeg 가 회전을 반영하고 720p 로 축소하므로
    // 회전 영상은 1920x1080 으로 기록되면서 실제 파일은 720x1280 이었다(삼순 지적, 2026-08-04).
    // 뷰어 레이아웃·서버 판정이 어긋나므로 반드시 출력 기준이어야 한다.
    // probe 실패 시에는 입력 meta 로 fallback 하되 조용히 넘어가지 않고 로그를 남긴다.
    let outMeta = meta;
    try {
      const probed = runner.probe(outPath);
      if (probed && probed.durationMs > 0) outMeta = probed;
      else console.log(`  ⚠️ venue ${row.id} 출력 probe 결과 불량 — 입력 메타로 fallback`);
    } catch (probeErr) {
      console.log(`  ⚠️ venue ${row.id} 출력 probe 실패 — 입력 메타로 fallback: ${probeErr?.message || probeErr}`);
    }
    // pending 승격은 private venue-media 로(공개 videos 아님). active 는 기존 버킷 유지(레거시 videos / 신규 venue-media).
    const targetBucket = isPending ? VENUE_PRIVATE_MEDIA_BUCKET : row.media_bucket;
    const newPath = venueOptimizedPath(row.media_path);
    const buf = readFileSync(outPath);
    const { error: upErr } = await storage
      .from(targetBucket)
      .upload(newPath, buf, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`upload 실패: ${upErr.message}`);
    const { data: pub } = storage.from(targetBucket).getPublicUrl(newPath);

    let updQuery = db
      .from("venue_stories")
      .update({
        media_url: pub.publicUrl,
        media_bucket: targetBucket,
        media_path: newPath,
        // 입력이 아니라 **실제 산출물** 기준(위 outMeta 재 probe)
        width: outMeta.width,
        height: outMeta.height,
        duration_ms: outMeta.durationMs,
        // 게시된 경로(active/archived)는 status 재기록 금지 — 처리 중 신고/어드민이
        // removed로 내린 상태 보존(불변식: worker 최적화 update는 removed 를 되살리지 않는다)
        ...(isPending ? {
          status: pendingTargetStatus,
          ...(pendingTargetStatus === "archived"
            ? { archived_at: new Date().toISOString() }
            : {}),
        } : {}),
        needs_transcode: false,
        transcode_attempts: row.transcode_attempts + 1,
      })
      .eq("id", row.id);
    if (isPending) updQuery = updQuery.eq("status", "pending");
    else {
      updQuery = updQuery
        // 자기 status 를 그대로 CAS 조건으로 — archived 는 archived 로 닫는다(삼순 blocker ③).
        .eq("status", publishedStatus)
        .eq("needs_transcode", true); // 최적화 CAS: 이미 완료된 행 재처리 방지
    }
    const { data: updRows, error: updErr } = await updQuery.select("id");
    if (updErr) throw new Error(`row 갱신 실패: ${updErr.message}`);
    if ((updRows ?? []).length === 0) {
      // 0-row: status 변경됨(신고/어드민 내림 등) 또는 이미 처리 완료 → resurrect 금지
      console.log(`  ⏭️  venue ${row.id} 상태 변경됨(skip) — ${isPending ? "즉시경로 선점" : "관리자 내림 등"}`);
      return { result: "claimedElsewhere", isPending };
    }

    // 교체 완료 — 원본 제거(pending 이면 staging 원본, active 면 공개 원본)
    if (row.media_path !== newPath) {
      try { await storage.from(row.media_bucket).remove([row.media_path]); } catch {}
    }
    console.log(`  ✅ venue ${row.id} ${fmtMB(inBytes)}→${fmtMB(outBytes)} ${isPending ? `${pendingTargetStatus}(복구승격)` : publishedStatus}`);
    return { result: "done", inBytes, outBytes, isPending };

  } catch (e) {
    const attempts = row.transcode_attempts + 1;
    let failQuery;
    let catchStatus;
    if (isPending) {
      // pending 경로: 재시도 소진 시 removed, 아니면 pending 유지 — 즉시경로가 승격한 행 건드리지 않음
      catchStatus = attempts >= maxAttempts ? "removed" : "pending";
      failQuery = db
        .from("venue_stories")
        // 재시도 소진로 removed 전이 시에만 removed_at 기록(격리 시계 시작). pending 유지면 건드리지 않음.
        .update({
          transcode_attempts: attempts,
          status: catchStatus,
          ...(catchStatus === "removed" ? { removed_at: new Date().toISOString() } : {}),
        })
        .eq("id", row.id)
        .eq("status", "pending"); // CAS: 즉시경로가 이미 active로 승격했으면 0-row skip
    } else {
      // 게시된 경로(active/archived): status 재기록 절대 금지 — 처리 중 신고/어드민이
      // removed로 내린 상태 보존(불변식: worker catch 도 removed 를 되살리지 않는다).
      // 재시도 소진 시에도 status 는 그대로 두고 needs_transcode 만 내려 무한 재큐를 막는다
      // — 이미 유저에게 보이는 영상이므로 최적화 실패를 이유로 내리면 안 된다.
      catchStatus = publishedStatus; // 로그 출력용(실제 status 기록 아님)
      const exhausted = attempts >= maxAttempts;
      failQuery = db
        .from("venue_stories")
        .update({
          transcode_attempts: attempts, // status 제외 — CAS 미일치 행 보존
          ...(exhausted ? { needs_transcode: false } : {}), // 소진 → 큐에서 내림(원본 노출 유지)
        })
        .eq("id", row.id)
        .eq("status", publishedStatus) // CAS: removed 된 행이면 0-row → skip
        .eq("needs_transcode", true);  // CAS: 다른 worker가 이미 완료했으면 skip
    }
    const { data: failRows, error: updErr } = await failQuery.select("id");
    if (updErr) {
      console.log(`  ⚠️ venue ${row.id} 상태갱신 실패(다음 실행 재시도): ${updErr.message}`);
      return { result: "updateError", error: e, dbError: updErr };
    }
    if ((failRows ?? []).length === 0) {
      // 0-row: 처리 중 removed/완료됨 → skip(resurrect 금지) — 성공 경로와 동일 카운팅
      console.log(`  ⏭️  venue ${row.id} catch-skip — ${isPending ? "즉시경로 선점" : "관리자 내림 등"} (${e?.message || e})`);
      return { result: "claimedElsewhere", isPending };
    }
    console.log(`  ❌ venue ${row.id} ${catchStatus} (${attempts}/${maxAttempts}): ${e?.message || e}`);
    return { result: "failed", error: e, attempts, catchStatus, isPending };
  }
}
