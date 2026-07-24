"use client";

// 직관 스토리 영상 클라이언트 자동 재인코딩 (2026-07-24 하린아빠 "15초 + 영상 cap 자동압축").
// 15초 이하인데 50MiB 백스톱을 넘는 영상을 차단 문구 대신 WebCodecs 재인코딩으로 cap 안에
// 맞춘다(사진 imageCompression 과 동일 UX). 정책 함수는 순수 — scripts/qa/venue-media-smoke.ts 공유.
//
// 타깃 환경 제약(조사 2026-07-24):
// - iOS Safari/WKWebView 16.4+ 는 VideoEncoder/VideoDecoder 만 지원, AudioEncoder 는 26+ 부터.
//   → 오디오는 **재인코딩 없이 원본 패킷 복사(passthrough)** 가 필수 전제.
// - mediabunny(MPL-2.0) Conversion 은 "copy whenever possible" — video 만 bitrate 로 강제
//   transcode 하고 audio 옵션을 안 주면 AAC 패킷을 그대로 복사한다(AudioEncoder 불필요).
// - 미지원/실패 환경은 null 반환 → 호출부가 기존 #813 백스톱 문구로 fallback.
import { VENUE_STORY_MAX_BYTES } from "./types";

/** 압축 목표 용량 — 50MiB 하드캡(Supabase Storage) 대비 여유 5MiB */
export const VENUE_VIDEO_COMPRESS_TARGET_BYTES = 45 * 1024 * 1024;
/** 오디오 트랙은 복사되지만 용량 예산에서 예약해 둘 대역 (iOS AAC 는 보통 96~160kbps) */
export const VENUE_VIDEO_AUDIO_RESERVE_BPS = 128_000;
/** 1080p H.264 상한 — 이 이상은 화질 이득 대비 용량 낭비 */
export const VENUE_VIDEO_MAX_BITRATE_BPS = 12_000_000;
/** 이 밑으로 내려도 cap 을 못 맞추면 포기(fallback) — 화질 붕괴 방지 */
export const VENUE_VIDEO_MIN_BITRATE_BPS = 1_000_000;
/** 긴 변 상한(세로 영상이면 height 1920 = 1080p) */
export const VENUE_VIDEO_MAX_EDGE_PX = 1920;
/** 재시도 비트레이트 안전 마진(실측 초과율 보정에 곱해 오버슈트 재발 방지) */
export const VENUE_VIDEO_RETRY_SAFETY = 0.85;

/** 자동압축 대상 판정 — duration 이 확인된 15초 게이트 통과 영상 중 바이트 백스톱 초과분만 */
export function shouldAutoCompressVideo(input: {
  sizeBytes: number;
  durationMs: number | null;
}): boolean {
  return (
    input.durationMs != null && input.durationMs > 0 && input.sizeBytes > VENUE_STORY_MAX_BYTES
  );
}

/**
 * duration 기반 목표 비디오 비트레이트(bps).
 * 목표바이트*8/duration 에서 오디오 예약분을 빼고 [MIN, MAX] 로 clamp.
 */
export function computeTargetVideoBitrate(
  durationMs: number,
  targetBytes: number = VENUE_VIDEO_COMPRESS_TARGET_BYTES,
): number {
  const totalBps = (targetBytes * 8 * 1000) / durationMs;
  const videoBps = totalBps - VENUE_VIDEO_AUDIO_RESERVE_BPS;
  return Math.round(
    Math.min(VENUE_VIDEO_MAX_BITRATE_BPS, Math.max(VENUE_VIDEO_MIN_BITRATE_BPS, videoBps)),
  );
}

/**
 * 1차 인코딩 결과가 여전히 초과일 때의 재시도 비트레이트.
 * 실측 초과율(target/actual)에 안전 마진을 곱해 감축. 이미 바닥(MIN)이었다면
 * 더 내려도 의미 없으니 null(재시도 포기 → fallback).
 */
export function computeRetryBitrate(
  prevBps: number,
  actualBytes: number,
  targetBytes: number = VENUE_VIDEO_COMPRESS_TARGET_BYTES,
): number | null {
  if (prevBps <= VENUE_VIDEO_MIN_BITRATE_BPS || actualBytes <= 0) return null;
  const ratio = Math.min(1, targetBytes / actualBytes);
  const scaled = prevBps * ratio * VENUE_VIDEO_RETRY_SAFETY;
  return Math.round(Math.max(VENUE_VIDEO_MIN_BITRATE_BPS, scaled));
}

/**
 * 긴 변 maxEdge 초과 시 축소 치수(짝수 정렬 — 인코더 호환), 리사이즈 불필요/불가면 null.
 */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxEdge: number = VENUE_VIDEO_MAX_EDGE_PX,
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null;
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return null;
  const scale = maxEdge / edge;
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** WebCodecs 비디오 인터페이스 존재 여부 — 픽 게이트에서 자동압축 가능 환경 판정용(동기) */
export function isVideoCompressSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
}

/**
 * cap 초과 영상을 H.264 mp4 로 재인코딩해 cap 이하 File 반환.
 * 실패/미지원/재시도 후에도 초과면 null — 호출부가 기존 백스톱 문구로 fallback.
 * onProgress: 0~1 (재시도 발생 시 0부터 다시 오를 수 있음 — 호출부는 단조 증가 가정 금지).
 */
export async function compressVenueVideo(
  file: File,
  opts: {
    durationMs: number;
    width: number;
    height: number;
    onProgress?: (ratio: number) => void;
  },
): Promise<File | null> {
  if (!isVideoCompressSupported()) return null;
  try {
    // dynamic import — 초기 번들 영향 0, cap 초과 영상에서만 로드
    const { Input, Output, Conversion, Mp4OutputFormat, BufferTarget, BlobSource, ALL_FORMATS, canEncodeVideo } =
      await import("mediabunny");
    if (!(await canEncodeVideo("avc"))) return null;

    const dims = computeScaledDimensions(opts.width, opts.height);
    const attempt = async (bitrate: number): Promise<File | null> => {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: "avc",
          bitrate,
          forceTranscode: true,
          ...(dims ? { width: dims.width, height: dims.height, fit: "contain" as const } : {}),
        },
        // audio 옵션 없음 = 원본 패킷 복사(passthrough) — iOS(AudioEncoder 부재) 전제
      });
      // 트랙이 하나라도 드랍되면(예: 오디오 코덱을 mp4 에 못 담음) 무단 무음화 금지 → fallback
      if (!conversion.isValid || conversion.discardedTracks.length > 0) return null;
      conversion.onProgress = (p: number) => opts.onProgress?.(p);
      await conversion.execute();
      const buffer = output.target.buffer;
      if (!buffer) return null;
      return new File([buffer], "venue-story.mp4", { type: "video/mp4" });
    };

    const firstBitrate = computeTargetVideoBitrate(opts.durationMs);
    let result = await attempt(firstBitrate);
    if (!result) return null;
    if (result.size <= VENUE_STORY_MAX_BYTES) return result;

    const retryBitrate = computeRetryBitrate(firstBitrate, result.size);
    if (retryBitrate == null) return null;
    result = await attempt(retryBitrate);
    if (!result || result.size > VENUE_STORY_MAX_BYTES) return null;
    return result;
  } catch {
    return null; // 어떤 실패든 fallback (기존 게이트 문구가 안전망)
  }
}
