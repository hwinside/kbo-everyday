// 직관 라이브 — 영상 즉시 검증 서버 바인딩(Vercel 서버리스 ffprobe).
//
// ffprobe 실행 방식(B+① 스파이크): @ffprobe-installer/ffprobe 정적 바이너리.
//  - next.config.ts outputFileTracingIncludes 로 linux-x64 바이너리를 함수 번들에 포함.
//  - npm install-scripts 정책/트레이싱으로 실행비트가 빠질 수 있어 spawn 전 defensive chmod.
//  - 실행 불가(fault)면 검증을 약화하지 않고 pending 유지 → 30분 복구 워커(GitHub Actions,
//    ffmpeg 기본 탑재)가 처리한다.

import { execFile } from "child_process";
import { promises as fs, constants as fsConstants } from "fs";
import { isFastStartMp4, MP4_HEAD_PROBE_BYTES } from "./mp4-boxes";
import { join } from "path";
import { tmpdir } from "os";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import {
  parseFfprobeJson,
  validateAndPromoteVideo,
  decideVideoVerdict,
  type FfprobeMeta,
  type ValidateDeps,
  type ValidateOutcome,
  type PendingVideoRow,
} from "./video-validate";
import {
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_PRIVATE_MEDIA_BUCKET,
} from "./types";

const FFPROBE_TIMEOUT_MS = 20_000;

function contentTypeForPath(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "mov" || ext === "qt") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "m4v") return "video/x-m4v";
  return "video/mp4";
}

/** ffprobe 바이너리 실행(chmod defensive). 실행 실패 = "fault"(검증 약화 금지). */
export async function runFfprobe(filePath: string): Promise<FfprobeMeta | null | "fault"> {
  const bin = ffprobeInstaller.path;
  try {
    try {
      await fs.access(bin, fsConstants.X_OK);
    } catch {
      await fs.chmod(bin, 0o755); // install-scripts 차단/트레이싱으로 실행비트 소실 대비
    }
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=codec_type,width,height",
          "-show_entries", "format=duration,format_name",
          "-of", "json",
          filePath,
        ],
        { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, out, stderr) => {
          if (err) {
            // exit code != 0 = 컨테이너 구조 불량(거부 사유) — spawn 자체 실패와 구분
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT" || e.code === "EACCES" || err.killed) {
              reject(err); // 실행 환경 문제 → fault
            } else {
              resolve(JSON.stringify({ __ffprobe_error: String(stderr || err.message) }));
            }
            return;
          }
          resolve(out);
        },
      );
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed.__ffprobe_error != null) return null; // 구조 불량 → 거부
    return parseFfprobeJson(stdout);
  } catch {
    return "fault"; // 바이너리 부재/권한/타임아웃 — pending 유지, 복구 워커로
  }
}

export type VenueVideoPromoteStatus = "active" | "archived";

/**
 * QA seam — **실제 배포되는 deps** 를 그대로 노출한다(복사본 아니임).
 * 스모크가 fake deps 만 검증하면 서버 배선을 바꿔도 GREEN 이 된다(실제로 잡은 false-green).
 * 이 export 로 venue-validate 스모크가 promoteRow 가 서버 실측값을 쓰는지 직접 검증한다.
 */
export function __qaRealDeps(promoteStatus: VenueVideoPromoteStatus): ValidateDeps {
  return realDeps(promoteStatus);
}

function realDeps(promoteStatus: VenueVideoPromoteStatus): ValidateDeps {
  return {
    async download(bucket, path) {
      try {
        const { data, error } = await supabase.storage.from(bucket).download(path);
        if (error || !data) return null;
        if (data.size <= 0 || data.size > VENUE_STORY_MAX_BYTES) return null;
        const filePath = join(
          tmpdir(),
          `venue-validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        await fs.writeFile(filePath, Buffer.from(await data.arrayBuffer()));
        return { filePath, bytes: data.size };
      } catch {
        return null;
      }
    },
    probe: runFfprobe,
    async publishOriginal(stagingPath, filePath) {
      try {
        const buf = await fs.readFile(filePath);
        // A안 A1: 검증 통과 원본을 공개 videos 대신 private venue-media 로 승격(서빙은 signed URL).
        const { error } = await supabase.storage
          .from(VENUE_STORY_PRIVATE_MEDIA_BUCKET)
          .upload(stagingPath, buf, {
            contentType: contentTypeForPath(stagingPath),
            cacheControl: "31536000",
            upsert: true, // fault 재시도/복구 경로 재실행 멱등
          });
        return !error;
      } catch {
        return false;
      }
    },
    async inspectServeReadiness(filePath, meta) {
      // 선두 바이트를 직접 읽어 moov/mdat 순서를 본다 — ffprobe 는 이 값을 안 준다.
      let fastStart: boolean | null = null;
      let handle: fs.FileHandle | null = null;
      try {
        handle = await fs.open(filePath, "r");
        const buf = Buffer.alloc(MP4_HEAD_PROBE_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MP4_HEAD_PROBE_BYTES, 0);
        fastStart = isFastStartMp4(new Uint8Array(buf.subarray(0, bytesRead)));
      } catch {
        fastStart = null; // 읽기 실패 = 미상 → needsServerTranscode 가 fail-close
      } finally {
        await handle?.close().catch(() => {});
      }
      const maxEdge =
        meta.width != null && meta.height != null && meta.width > 0 && meta.height > 0
          ? Math.max(meta.width, meta.height)
          : null;
      return { fastStart, maxEdge };
    },
    async promoteRow(id, meta, { needsTranscode }) {
      const { data, error } = await supabase
        .from("venue_stories")
        .update({
          status: promoteStatus,
          media_bucket: VENUE_STORY_PRIVATE_MEDIA_BUCKET,
          duration_ms: meta.durationMs,
          width: meta.width,
          height: meta.height,
          // 서버 실측 기반 후속 최적화 큐 — 경로별 고정값이 아니다.
          // (종전: promoteStatus === "active" 로 고정 → diary_manual 은 느린 원본이어도 영구 미최적화)
          needs_transcode: needsTranscode,
          ...(promoteStatus === "archived"
            ? { archived_at: new Date().toISOString() }
            : {}),
        })
        .eq("id", id)
        .eq("status", "pending") // CAS — 복구 워커와 중복 claim 방지
        .select("id");
      if (error) return "fault";
      return (data ?? []).length > 0;
    },
    async rejectRow(id) {
      const { data, error } = await supabase
        .from("venue_stories")
        // 검증실패 removed 도 즉시삭제 금지·30일 격리(스펙 §2.2) — removed_at 으로 격리 시계 시작.
        .update({ status: "removed", removed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending") // CAS
        .select("id");
      if (error) return "fault";
      return (data ?? []).length > 0;
    },
    async removeObject(bucket, path) {
      try {
        await supabase.storage.from(bucket).remove([path]);
      } catch {
        /* cleanup cron 이 백업 */
      }
    },
    cleanupTemp(filePath) {
      fs.rm(filePath, { force: true }).catch(() => {});
    },
  };
}

/** pending 영상 행 1건 즉시 검증(업로드 요청 내 인라인 + 복구 경로 공용). */
export async function validateVenueVideoRow(
  row: PendingVideoRow,
  options: { promoteStatus?: VenueVideoPromoteStatus } = {},
): Promise<ValidateOutcome> {
  return validateAndPromoteVideo(realDeps(options.promoteStatus ?? "active"), row);
}

/**
 * 진단 dry-run: storage 객체를 다운로드해 ffprobe 판정만 반환(DB 무변경).
 * Vercel 런타임에서 ffprobe 실행 가능 여부를 실호출로 검증하는 용도(CRON_SECRET 게이트 뒤).
 */
export async function dryRunProbeObject(
  bucket: string,
  path: string,
): Promise<
  | { ok: boolean; engine: "ffprobe"; bytes: number; meta: FfprobeMeta | null; reason?: string }
  | { error: string }
> {
  const deps = realDeps("active");
  const dl = await deps.download(bucket, path);
  if (dl == null) return { error: "download_failed" };
  try {
    const meta = await deps.probe(dl.filePath);
    if (meta === "fault") return { error: "ffprobe_unavailable" };
    const verdict = decideVideoVerdict(meta);
    return {
      ok: verdict.ok,
      engine: "ffprobe",
      bytes: dl.bytes,
      meta,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
    };
  } finally {
    deps.cleanupTemp(dl.filePath);
  }
}
