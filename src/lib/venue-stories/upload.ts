"use client";

import { supabase } from "@/lib/supabase/client";
import imageCompression from "browser-image-compression";
import {
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
} from "./types";

export interface PreparedMedia {
  mediaType: "video" | "image";
  mediaUrl: string;
  thumbUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export interface PrepareError {
  error: string;
}

const VIDEO_BUCKET = "videos";
const IMAGE_BUCKET = "photos";

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
  contentType: string,
): Promise<string | null> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, data, { contentType, cacheControl: "31536000", upsert: false });
  if (error) return null;
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
  return urlData.publicUrl;
}

/**
 * 직관 스토리 미디어를 검증·압축·업로드하고 생성에 필요한 메타를 반환.
 * 실패 시 { error } 반환(호출부가 토스트로 노출).
 */
export async function prepareVenueStoryMedia(
  file: File,
  gameId: string,
): Promise<PreparedMedia | PrepareError> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "로그인이 필요합니다" };

  if (file.size > VENUE_STORY_MAX_BYTES) {
    return { error: "파일이 너무 큽니다 (최대 60MB)" };
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
    if (
      probe.durationMs >
      VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
    ) {
      return { error: "영상은 15초 이하만 올릴 수 있어요" };
    }
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
    const mediaUrl = await uploadBlob(
      VIDEO_BUCKET,
      randPath(gameId, user.id, ext),
      file,
      file.type || "video/mp4",
    );
    if (!mediaUrl) return { error: "영상 업로드에 실패했어요" };

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
      mediaUrl,
      thumbUrl,
      durationMs: probe.durationMs,
      width: probe.width || null,
      height: probe.height || null,
    };
  }

  // image
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
  );
  if (!mediaUrl) return { error: "사진 업로드에 실패했어요" };
  return {
    mediaType: "image",
    mediaUrl,
    thumbUrl: mediaUrl,
    durationMs: null,
    width: width || null,
    height: height || null,
  };
}
