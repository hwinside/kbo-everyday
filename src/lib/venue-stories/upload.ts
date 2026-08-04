"use client";

import { supabase, getSafeSession } from "@/lib/supabase/client";
import imageCompression from "browser-image-compression";
import { VENUE_STORY_STAGING_BUCKET, VENUE_STORY_PRIVATE_MEDIA_BUCKET } from "./types";
import { checkVenueMediaLimits, VENUE_VIDEO_TOO_HEAVY_MSG } from "./media-limits";
import {
  shouldAutoCompressVideo,
  compressVenueVideo,
  shouldNormalizeVideo,
  normalizeVenueVideo,
  isVideoCompressSupported,
} from "./video-compress";

export interface PreparedMedia {
  mediaType: "video" | "image";
  /** image: 공개 URL. video: null(원본은 private staging — 서버 검증 통과 시에만 공개). */
  mediaUrl: string | null;
  /** video: staging 경로(venue-stories/{gameId}/{userId}/{file}). image: null. */
  mediaPath: string | null;
  thumbUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface PrepareError {
  error: string;
}

// A안 A1: 사진·영상 포스터를 private venue-media 버킷에 저장(처음부터 비공개). 공개 서빙은 서버 signed URL.
// getPublicUrl 형태 URL 을 여전히 반환하면 서버가 소유경로를 파싱(bucket+path 도출)하고 durable 기록한다.
const IMAGE_BUCKET = VENUE_STORY_PRIVATE_MEDIA_BUCKET;

/** 확장자는 서버 strict allowlist([A-Za-z0-9._-]) 통과하도록 영숫자만 남긴다. */
function sanitizeExt(name: string, fallback: string): string {
  const raw = (name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return raw && raw.length <= 8 ? raw : fallback;
}

function randPath(gameId: string, userId: string, ext: string): string {
  const safeGame = gameId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `venue-stories/${safeGame}/${userId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;
}

/** 영상 파일의 duration(ms)/해상도를 읽고 첫 프레임 포스터를 JPEG blob 으로 캡처 */
function probeVideo(
  file: File,
): Promise<{ durationMs: number; width: number; height: number; poster: Blob | null }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error(msg));
    };

    video.onloadedmetadata = () => {
      const durationMs = Math.round((video.duration || 0) * 1000);
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      // 포스터: 0.1초 지점으로 시크 후 캔버스 캡처
      const seekTo = Math.min(0.1, (video.duration || 0) / 2);
      video.onseeked = () => {
        if (settled) return;
        try {
          const canvas = document.createElement("canvas");
          const scale = width > 720 ? 720 / width : 1;
          canvas.width = Math.round(width * scale) || 720;
          canvas.height = Math.round(height * scale) || 1280;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            settled = true;
            URL.revokeObjectURL(url);
            resolve({ durationMs, width, height, poster: null });
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) => {
              settled = true;
              URL.revokeObjectURL(url);
              resolve({ durationMs, width, height, poster: blob });
            },
            "image/jpeg",
            0.7,
          );
        } catch {
          settled = true;
          URL.revokeObjectURL(url);
          resolve({ durationMs, width, height, poster: null });
        }
      };
      try {
        video.currentTime = seekTo;
      } catch {
        settled = true;
        URL.revokeObjectURL(url);
        resolve({ durationMs, width, height, poster: null });
      }
    };
    video.onerror = () => fail("영상을 읽을 수 없습니다");
  });
}

/** 픽 게이트 probe 상한 — metadata/error 미발화 파일(fake/corrupt)에서 무한대기 방지(삼순 #813 blocker) */
export const VENUE_PICK_PROBE_TIMEOUT_MS = 8_000;

/** probeVideoDurationMs 가 쓰는 video element 최소 인터페이스 — 순수 회귀(fake video) 주입용 */
export interface DurationProbeVideoLike {
  preload: string;
  muted: boolean;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  readonly duration: number;
  removeAttribute(name: string): void;
  load?: () => void;
}

/**
 * 픽 게이트용 경량 duration probe(포스터 캡처 없음, metadata만).
 * 실패/timeout 시 null — 픽 게이트는 fail-open 으로 통과시키고 업로드 단계
 * probeVideo/서버 검증이 fail-close 한다(정상 파일 이중 차단 방지).
 * loadedmetadata/error 를 모두 발화하지 않는 파일이면 timeout 으로 settle 하고
 * 핸들러 해제 + src 해제 + objectURL revoke 로 리소스를 회수한다.
 * deps 는 순수 회귀(scripts/qa/venue-media-smoke.ts) 전용 주입 포인트.
 */
export function probeVideoDurationMs(
  file: File,
  deps?: {
    timeoutMs?: number;
    createVideo?: () => DurationProbeVideoLike;
    createObjectURL?: (f: File) => string;
    revokeObjectURL?: (url: string) => void;
  },
): Promise<number | null> {
  const timeoutMs = deps?.timeoutMs ?? VENUE_PICK_PROBE_TIMEOUT_MS;
  const createVideo =
    deps?.createVideo ?? (() => document.createElement("video") as DurationProbeVideoLike);
  const createUrl = deps?.createObjectURL ?? ((f: File) => URL.createObjectURL(f));
  const revokeUrl = deps?.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  return new Promise((resolve) => {
    const url = createUrl(file);
    const video = createVideo();
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      // 이벤트 cleanup — timeout 후 늦게 발화해도 no-op, 미디어 리소스 회수
      video.onloadedmetadata = null;
      video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load?.();
      } catch {
        /* noop — 해제 실패해도 resolve 는 진행 */
      }
      revokeUrl(url);
      resolve(value);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    video.onloadedmetadata = () => done(Math.round((video.duration || 0) * 1000));
    video.onerror = () => done(null);
    video.src = url;
  });
}

/** 이미지 자연 해상도 읽기 */
function probeImage(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    img.src = url;
  });
}

/** XHR 최소 인터페이스 — 순수 로직 회귀 테스트용(scripts/qa/venue-upload-progress-smoke.ts) */
export interface UploadXhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  status: number;
  upload: {
    onprogress:
      | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

/** supabase-js 폴백 판정 — 하나라도 없으면 XHR 경로 불가(진행률 없이 기존 경로) */
export function shouldFallbackToSupabaseJs(env: {
  base: string | undefined;
  anonKey: string | undefined;
  token: string | undefined;
  hasXhr: boolean;
}): boolean {
  return !env.base || !env.anonKey || !env.token || !env.hasXhr;
}

/**
 * XHR 업로드 배선 — **listener 전부를 open() 전에 선등록**한다.
 * (MDN: 일부 구현은 open 이후 등록된 upload progress를 발화하지 않음 —
 *  타깃이 iOS/Android WebView라 선등록 필수, 삼순 #795 blocker)
 */
export function runXhrUpload(
  xhr: UploadXhrLike,
  opts: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    onProgress?: (ratio: number) => void;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.open("POST", opts.url);
    for (const [name, value] of Object.entries(opts.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.send(opts.body);
  });
}

/**
 * XHR 기반 storage 업로드 — supabase-js와 동일한 REST 경로(POST /storage/v1/object)에
 * upload progress 이벤트만 추가. fetch 기반 supabase-js는 업로드 진행률을 못 준다.
 * 토큰/환경 미비 시 supabase-js 폴백(진행률 없이 업로드는 성공).
 */
async function uploadWithProgress(
  bucket: string,
  path: string,
  data: Blob | File,
  contentType: string,
  cacheControlSec: number,
  onProgress?: (ratio: number) => void,
): Promise<boolean> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const session = await getSafeSession();
  const token = session?.access_token;
  if (
    shouldFallbackToSupabaseJs({
      base,
      anonKey,
      token,
      hasXhr: typeof XMLHttpRequest !== "undefined",
    })
  ) {
    const { error } = await supabase.storage.from(bucket).upload(path, data, {
      contentType,
      cacheControl: String(cacheControlSec),
      upsert: false,
    });
    return !error;
  }
  // path 는 randPath/sanitizeExt 로 영숫자·-·_·.·/ 만 포함 — 인코딩 불필요(supabase-js도 raw)
  // DOM XMLHttpRequest 는 UploadXhrLike 상위호환(onprogress 이벤트 타입만 더 넓음)
  return runXhrUpload(new XMLHttpRequest() as unknown as UploadXhrLike, {
    url: `${base}/storage/v1/object/${bucket}/${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      apikey: anonKey!,
      "x-upsert": "false",
      "cache-control": `max-age=${cacheControlSec}`,
      "content-type": contentType,
    },
    body: data,
    onProgress,
  });
}

async function uploadBlob(
  bucket: string,
  path: string,
  data: Blob | File,
  contentType: string,
  onProgress?: (ratio: number) => void,
): Promise<string | null> {
  const ok = await uploadWithProgress(bucket, path, data, contentType, 31536000, onProgress);
  if (!ok) return null;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return urlData.publicUrl;
}

/** private staging 업로드 — 공개 URL 을 만들지 않는다(B+①: 검증 통과 전 비노출). */
async function uploadToStaging(
  path: string,
  data: Blob | File,
  contentType: string,
  onProgress?: (ratio: number) => void,
): Promise<boolean> {
  return uploadWithProgress(
    VENUE_STORY_STAGING_BUCKET,
    path,
    data,
    contentType,
    3600,
    onProgress,
  );
}

/**
 * 직관 스토리 미디어를 검증·압축·업로드하고 생성에 필요한 메타를 반환.
 * 실패 시 { error } 반환(호출부가 토스트로 노출).
 */
/** 진행 단계 — compress 는 cap 초과 영상 자동압축 구간(0~40%)에서만 온다 */
export type UploadStage = "compress" | "upload";

export async function prepareVenueStoryMedia(
  file: File,
  gameId: string,
  onProgress?: (ratio: number, stage?: UploadStage) => void,
): Promise<PreparedMedia | PrepareError> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다" };

  const isVideo = file.type.startsWith("video/");
  const isImage = file.type.startsWith("image/");
  if (!isVideo && !isImage) return { error: "이미지 또는 영상만 올릴 수 있어요" };

  if (isVideo) {
    let probe;
    try {
      probe = await probeVideo(file);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "영상을 읽을 수 없습니다" };
    }
    // duration(15초) 게이트 먼저 — bytes 백스톱 초과는 아래 자동압축이 흡수하므로 여기선 통과
    const durationError = checkVenueMediaLimits({
      kind: "video",
      sizeBytes: file.size,
      durationMs: probe.durationMs,
      videoAutoCompressAvailable: true,
    });
    if (durationError) return { error: durationError };

    let uploadable: File = file;
    let compressed = false;

    // ① 업로드 전 720p H.264 + faststart 정규화 — **용량과 무관하게 전 영상**.
    // 실측(2026-08-04, 업로드본 5건 ffprobe): 원본이 13~24Mbps·16~38MB 였고 2건은 moov 가
    // 파일 끝(faststart 아님)이라 첫 재생에 사실상 전량 전송이 필요했다. 정규화 실패/미지원/
    // 역효과면 원본 그대로 진행하므로 기존 동작은 유지된다(회귀 위험 최소화).
    if (
      shouldNormalizeVideo({
        durationMs: probe.durationMs,
        compressSupported: isVideoCompressSupported(),
      })
    ) {
      const norm = await normalizeVenueVideo(file, {
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        onProgress: (r) => onProgress?.(r * 0.4, "compress"),
      });
      if (norm.normalized) {
        uploadable = norm.file;
        compressed = true;
        // 메타/포스터는 실제 업로드되는 최종 파일 기준으로 재추출(해상도 변경됨)
        try {
          probe = await probeVideo(uploadable);
        } catch (e) {
          return { error: e instanceof Error ? e.message : "영상을 읽을 수 없습니다" };
        }
        onProgress?.(0.4, "upload");
      }
    }

    // ② 정규화가 불가/실패했는데 여전히 cap 초과라면 기존 자동압축(구제 경로)으로 흡수.
    // 실패/미지원이면 기존 #813 백스톱 문구로 fallback.
    if (shouldAutoCompressVideo({ sizeBytes: uploadable.size, durationMs: probe.durationMs })) {
      const out = await compressVenueVideo(uploadable, {
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        onProgress: (r) => onProgress?.(r * 0.4, "compress"),
      });
      if (!out) return { error: VENUE_VIDEO_TOO_HEAVY_MSG };
      uploadable = out;
      compressed = true;
      // 메타/포스터는 실제 업로드되는 최종 파일 기준으로 재추출(해상도 변경 가능)
      try {
        probe = await probeVideo(out);
      } catch (e) {
        return { error: e instanceof Error ? e.message : "영상을 읽을 수 없습니다" };
      }
      onProgress?.(0.4, "upload");
    }

    // 최종 안전망 — 압축 결과물 기준, 자동압축 플래그 없이(초과 잔존 시 fail-close)
    const limitError = checkVenueMediaLimits({
      kind: "video",
      sizeBytes: uploadable.size,
      durationMs: probe.durationMs,
    });
    if (limitError) return { error: limitError };
    // 원본은 private staging 에만 — 서버 ffprobe 검증 통과 시 서버가 공개 버킷으로 승격(B+①)
    const mediaPath = randPath(gameId, user.id, sanitizeExt(uploadable.name, "mp4"));
    // 본음이 용량 대부분 — 압축 시 40~95%, 미압축 시 0~95% 구간 매핑(썸네일·메타 POST 잔여 5%)
    const base = compressed ? 0.4 : 0;
    const uploaded = await uploadToStaging(
      mediaPath,
      uploadable,
      uploadable.type || "video/mp4",
      (r) => onProgress?.(base + r * (0.95 - base), "upload"),
    );
    if (!uploaded) return { error: "영상 업로드에 실패했어요" };
    onProgress?.(0.95, "upload");

    let thumbUrl: string | null = null;
    if (probe.poster) {
      thumbUrl = await uploadBlob(
        IMAGE_BUCKET,
        randPath(gameId, user.id, "jpg"),
        probe.poster,
        "image/jpeg",
      );
    }
    return {
      mediaType: "video",
      mediaUrl: null,
      mediaPath,
      thumbUrl,
      durationMs: probe.durationMs,
      width: probe.width || null,
      height: probe.height || null,
    };
  }

  // image — 시간 개념이 없으니 바이트 캡 유지(자동압축은 캡 통과분에만 적용)
  const imageLimitError = checkVenueMediaLimits({
    kind: "image",
    sizeBytes: file.size,
    durationMs: null,
  });
  if (imageLimitError) return { error: imageLimitError };
  const { width, height } = await probeImage(file);
  let compressed: File = file;
  try {
    compressed = await imageCompression(file, {
      maxSizeMB: 1.2,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      fileType: "image/jpeg",
    });
  } catch {
    // 압축 실패 시 원본 사용
  }
  const mediaUrl = await uploadBlob(
    IMAGE_BUCKET,
    randPath(gameId, user.id, "jpg"),
    compressed,
    "image/jpeg",
    (r) => onProgress?.(r * 0.95),
  );
  if (!mediaUrl) return { error: "사진 업로드에 실패했어요" };
  onProgress?.(0.95);
  return {
    mediaType: "image",
    mediaUrl,
    mediaPath: null,
    thumbUrl: mediaUrl,
    durationMs: null,
    width: width || null,
    height: height || null,
  };
}
