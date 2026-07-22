"use client";

import { supabase } from "@/lib/supabase/client";
import imageCompression from "browser-image-compression";
import { uploadStorageObjectWithProgress } from "./upload-progress";
import {
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
  VENUE_STORY_STAGING_BUCKET,
} from "./types";

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

export interface VenueStoryUploadProgress {
  percent: number;
  label: string;
}

interface PrepareOptions {
  userId: string;
  accessToken: string;
  onProgress?: (progress: VenueStoryUploadProgress) => void;
}

const IMAGE_BUCKET = "photos";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function reportProgress(
  onProgress: PrepareOptions["onProgress"],
  percent: number,
  label: string,
): void {
  onProgress?.({ percent: Math.min(100, Math.max(0, Math.round(percent))), label });
}

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

async function uploadBlob(
  bucket: string,
  path: string,
  data: Blob | File,
  accessToken: string,
  onProgress?: (percent: number) => void,
): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const uploaded = await uploadStorageObjectWithProgress({
    bucket,
    path,
    data,
    accessToken,
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    cacheControl: "31536000",
    onProgress: (progress) => onProgress?.(progress.percent),
  });
  if (!uploaded) return null;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return urlData.publicUrl;
}

/** private staging 업로드 — 공개 URL 을 만들지 않는다(B+①: 검증 통과 전 비노출). */
async function uploadToStaging(
  path: string,
  data: Blob | File,
  accessToken: string,
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  return uploadStorageObjectWithProgress({
    bucket: VENUE_STORY_STAGING_BUCKET,
    path,
    data,
    accessToken,
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    cacheControl: "3600",
    onProgress: (progress) => onProgress?.(progress.percent),
  });
}

/**
 * 직관 스토리 미디어를 검증·압축·업로드하고 생성에 필요한 메타를 반환.
 * 실패 시 { error } 반환(호출부가 토스트로 노출).
 */
export async function prepareVenueStoryMedia(
  file: File,
  gameId: string,
  options: PrepareOptions,
): Promise<PreparedMedia | PrepareError> {
  const { userId, accessToken, onProgress } = options;
  if (!userId || !accessToken) return { error: "로그인이 필요합니다" };

  reportProgress(onProgress, 3, "파일 확인 중…");

  if (file.size > VENUE_STORY_MAX_BYTES) {
    return { error: "파일이 너무 큽니다 (최대 50MB)" };
  }

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
    reportProgress(onProgress, 12, "영상 정보 확인 완료");
    if (
      probe.durationMs >
      VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
    ) {
      return { error: "영상은 15초 이하만 올릴 수 있어요" };
    }
    // 원본은 private staging 에만 — 서버 ffprobe 검증 통과 시 서버가 공개 버킷으로 승격(B+①)
    const mediaPath = randPath(gameId, userId, sanitizeExt(file.name, "mp4"));
    const uploaded = await uploadToStaging(mediaPath, file, accessToken, (percent) => {
      reportProgress(onProgress, 12 + percent * 0.73, "영상 전송 중…");
    });
    if (!uploaded) return { error: "영상 업로드에 실패했어요" };

    let thumbUrl: string | null = null;
    if (probe.poster) {
      thumbUrl = await uploadBlob(
        IMAGE_BUCKET,
        randPath(gameId, userId, "jpg"),
        probe.poster,
        accessToken,
        (percent) => reportProgress(onProgress, 85 + percent * 0.05, "미리보기 준비 중…"),
      );
    }
    reportProgress(onProgress, 90, "영상 전송 완료");
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

  // image
  reportProgress(onProgress, 8, "사진 정보 확인 중…");
  const { width, height } = await probeImage(file);
  let compressed: File = file;
  try {
    reportProgress(onProgress, 15, "사진 최적화 중…");
    compressed = await imageCompression(file, {
      maxSizeMB: 1.2,
      maxWidthOrHeight: 1600,
      useWebWorker: true,
      fileType: "image/jpeg",
    });
  } catch {
    // 압축 실패 시 원본 사용
  }
  reportProgress(onProgress, 25, "사진 전송 준비 완료");
  const mediaUrl = await uploadBlob(
    IMAGE_BUCKET,
    randPath(gameId, userId, "jpg"),
    compressed,
    accessToken,
    (percent) => reportProgress(onProgress, 25 + percent * 0.65, "사진 전송 중…"),
  );
  if (!mediaUrl) return { error: "사진 업로드에 실패했어요" };
  reportProgress(onProgress, 90, "사진 전송 완료");
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
