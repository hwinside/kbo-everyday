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
/**
 * 업로드 전 정규화 목표 긴 변 — 720p(1280). 실측(2026-08-04, 업로드본 5건 ffprobe)에서
 * 원본은 1920x1440~3840x2160 / 13~24Mbps 였고 6.8~14.3초에 16.8~38.6MB 였다.
 * 720p 3.5Mbps 로 정규화하면 같은 길이가 3~6MB 로 떨어져 첫 재생 대기가 실질적으로 줄어든다.
 */
export const VENUE_VIDEO_NORMALIZE_MAX_EDGE_PX = 1280;
/** 720p H.264 정규화 목표 비트레이트(bps) — 화질/용량 절충. */
export const VENUE_VIDEO_NORMALIZE_BITRATE_BPS = 3_500_000;
/** faststart 판정에 읽을 파일 선두 바이트 수(상위 박스 순서 판별용). */
export const VENUE_VIDEO_HEAD_PROBE_BYTES = 64 * 1024;
/** 재시도 비트레이트 안전 마진(실측 초과율 보정에 곱해 오버슈트 재발 방지) */
export const VENUE_VIDEO_RETRY_SAFETY = 0.85;
/**
 * 압축 1회 실행 상한 — 초과 시 conversion.cancel() 로 실제 중단(삼순 #814 blocker).
 * 모바일 WebCodecs 가 background/encoder fault 로 settle 하지 않으면 submitting 이
 * 화면을 영구 잠그는 것을 막는다. 초과 → null 반환 → #813 백스톱 문구 fallback.
 */
export const VENUE_VIDEO_COMPRESS_DEADLINE_MS = 90_000;

/**
 * conversion.execute() 를 deadline 안에서만 기다린다(순수 — venue-media-smoke 공유).
 * true = 완료, false = deadline 초과(cancel() 호출로 실제 작업 중단).
 * execute 자체 reject 는 그대로 throw — 호출부 catch 가 fallback 처리.
 * cancel() 은 반드시 호출하되 critical path 밖(fire-and-forget) — mediabunny cancel() 은
 * custom encoder 의 호출 큐 뒤에서 close() 를 기다리므로 encoder fault 시 cancel 자체가
 * settle 하지 않을 수 있다(삼순 라운드2 blocker). settle 여부와 무관하게 즉시 false 를
 * 반환해 호출부 fallback + submitting 해제를 보장한다.
 */
export async function executeWithDeadline(
  conversion: { execute(): Promise<unknown>; cancel(): Promise<unknown> },
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
  });
  try {
    const exec = conversion.execute().then(() => true as const);
    const winner = await Promise.race([exec, timedOut]);
    if (winner === false) {
      exec.catch(() => undefined); // 패배한 execute 의 late reject 무해화(unhandledrejection 방지)
      // 실제 인코더/디코더 중단 시도(백그라운드 좀비 인코딩 방지) — 단, await 금지.
      // Promise.resolve().then 래핑으로 동기 throw 까지 흡수, catch 로 late reject 무해화.
      Promise.resolve()
        .then(() => conversion.cancel())
        .catch(() => undefined); // cancel 실패/미settle 과 무관하게 fallback 은 이미 확정
      return false;
    }
    return true;
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

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
 * 업로드 전 720p 정규화 대상 판정 — **용량과 무관**하게 duration 이 확인된 모든 영상.
 * (기존 shouldAutoCompressVideo 는 50MiB 초과분만 대상이라 실제 업로드본 대부분이
 *  원본 그대로 올라갔고, 그게 첫 재생 지연의 1차 원인이었다. 2026-08-04 실측.)
 * compressSupported=false(WebCodecs 부재) 면 정규화 불가 → 기존 경로 유지.
 */
export function shouldNormalizeVideo(input: {
  durationMs: number | null;
  compressSupported: boolean;
}): boolean {
  return input.compressSupported && input.durationMs != null && input.durationMs > 0;
}

/**
 * 정규화 비트레이트 — 720p 목표치와 duration 기반 cap 예산 중 작은 값.
 * 15초 이하 게이트라 보통 720p 목표치가 선택되지만, 극단적으로 긴 duration 이
 * 통과했을 때도 cap 예산을 넘지 않도록 min 을 취한다.
 */
export function computeNormalizeBitrate(durationMs: number): number {
  return Math.min(VENUE_VIDEO_NORMALIZE_BITRATE_BPS, computeTargetVideoBitrate(durationMs));
}

/**
 * ISO-BMFF 선두 상위 박스 타입을 순서대로 파싱(순수 — 스모크 공유).
 * head 는 파일 앞부분만이므로 끝까지 못 읽는 것이 정상이다. 잘린 박스는 타입까지만 기록하고 종료.
 */
export function parseTopLevelBoxTypes(head: Uint8Array): string[] {
  const types: string[] = [];
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 0;
  while (pos + 8 <= head.length) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      head[pos + 4],
      head[pos + 5],
      head[pos + 6],
      head[pos + 7],
    );
    types.push(type);
    let headerBytes = 8;
    if (size === 1) {
      if (pos + 16 > head.length) break; // 64bit 길이가 잘림 — 더 진행 불가
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      size = hi * 2 ** 32 + lo;
      headerBytes = 16;
    } else if (size === 0) {
      break; // '파일 끝까지' 박스 — 이후 상위 박스 없음
    }
    if (size < headerBytes) break; // 손상
    pos += size;
  }
  return types;
}

/**
 * faststart(moov 가 mdat 앞) 여부. true/false 로 확정하지 못하면 null(미상).
 * 미상은 fail-open 이 아니라 "정규화 결과를 선호"하는 쪽으로 쓰인다(chooseUploadVideo).
 */
export function isFastStartMp4(head: Uint8Array): boolean | null {
  for (const type of parseTopLevelBoxTypes(head)) {
    if (type === "moov") return true;
    if (type === "mdat") return false;
  }
  return null;
}

/**
 * 원본과 정규화본 중 실제 업로드할 쪽 결정(순수 — 스모크 공유).
 *  - 정규화 실패(normalizedBytes=null) → 원본
 *  - 정규화본이 더 작으면 정규화본(첫 재생 대기 감소가 목적)
 *  - 정규화본이 더 커도, 원본이 cap 초과이거나 faststart 가 아니면 정규화본
 *    (moov 가 파일 끝이면 재생 시작에 사실상 전량 전송이 필요하다 — 실측 2/5건)
 *  - 그 외(원본이 이미 작고 faststart) → 원본
 */
export function chooseUploadVideo(input: {
  originalBytes: number;
  normalizedBytes: number | null;
  originalFastStart: boolean | null;
  maxBytes?: number;
}): "original" | "normalized" {
  const { originalBytes, normalizedBytes, originalFastStart } = input;
  const maxBytes = input.maxBytes ?? VENUE_STORY_MAX_BYTES;
  if (normalizedBytes == null) return "original";
  if (normalizedBytes > maxBytes) return "original"; // cap 초과 결과물은 쓸 수 없다
  if (normalizedBytes <= originalBytes) return "normalized";
  if (originalBytes > maxBytes) return "normalized";
  if (originalFastStart !== true) return "normalized";
  return "original";
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

/**
 * 음수 first timestamp 보정 trim(순수 — venue-media-smoke 공유).
 * ffmpeg/iPhone AAC 는 encoder priming 으로 오디오 first timestamp 가 음수(예: -23ms)일 수 있다.
 * mediabunny 기본 start(0) 기준으로는 이게 '트리밍 필요'로 판정돼 오디오가 decode 경로로
 * 빠지고, AudioDecoder 가 없는 iOS(<26)에서는 트랙이 discard 된다(실기기 BrowserStack
 * 진단 2026-07-24: reason=undecodable_source_codec). 최소 ts 로 trim 시작점을 내려
 * 패킷 복사 fast path 를 보장한다(전 트랙 동일 shift — A/V 싱크 보존).
 */
export function computeNegativeStartTrim(
  firstTimestamps: number[],
): { start: number } | null {
  if (firstTimestamps.length === 0) return null;
  const min = Math.min(...firstTimestamps);
  return Number.isFinite(min) && min < 0 ? { start: min } : null;
}

/** WebCodecs 비디오 인터페이스 존재 여부 — 픽 게이트에서 자동압축 가능 환경 판정용(동기) */
export function isVideoCompressSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
}

/**
 * bitrate 무시 버그 환경 판정 — AudioEncoder 부재(WebKit<26, iOS 17~25 세대)와 정확히 겹친다.
 * 실기기 BrowserStack 진단(2026-07-24, iPhone iOS 17.3/17.5): 기본 latencyMode('quality')에서
 * VideoEncoder 가 bitrate(12Mbps)를 완전히 무시해 ~337Mbps 로 출력(10초에 214MB).
 * 'realtime' 모드는 bitrate 를 존중함을 같은 기기에서 확인(동일 설정 → ~8Mbps).
 */
function shouldForceRealtimeEncoder(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof AudioEncoder === "undefined";
}

let realtimeEncoderRegistered = false;

/**
 * WebKit<26 전용: native VideoEncoder 를 latencyMode 'realtime' 로 강제하는 custom encoder 를
 * mediabunny 에 등록(supports 가 환경 게이트 — Chromium/WebKit26+ 는 기존 quality 경로 유지).
 * 트레이드오프: realtime 모드는 부하/비트예산 초과 시 프레임을 드랍할 수 있다(일부 구간
 * 저프레임 가능) — cap 초과 영상이 아예 차단되는 것보다 업로드 가능이 우선(#814).
 */
function ensureRealtimeEncoderRegistered(mb: typeof import("mediabunny")): void {
  if (realtimeEncoderRegistered || !shouldForceRealtimeEncoder()) return;
  realtimeEncoderRegistered = true;
  const { CustomVideoEncoder, EncodedPacket, registerEncoder } = mb;
  class RealtimeForcedAvcEncoder extends CustomVideoEncoder {
    private encoder: VideoEncoder | null = null;
    static supports(codec: string): boolean {
      return codec === "avc" && shouldForceRealtimeEncoder();
    }
    init(): void {
      this.encoder = new VideoEncoder({
        output: (chunk, meta) =>
          this.onPacket(EncodedPacket.fromEncodedChunk(chunk), meta ?? undefined),
        error: (e) => this.onError(e),
      });
      this.encoder.configure({ ...this.config, latencyMode: "realtime" });
    }
    async encode(
      sample: import("mediabunny").VideoSample,
      options: VideoEncoderEncodeOptions,
    ): Promise<void> {
      if (!this.encoder) return;
      const frame = sample.toVideoFrame();
      this.encoder.encode(frame, options);
      frame.close();
      // 인코더 큐 backpressure — 메모리 폭주 방지. close()(→ encoder null)나 encoder
      // fault(state 'closed') 시 탈출 — 상한 없이 돌면 mediabunny cancel() 이 이 호출 큐
      // 뒤에서 영원히 대기해 취소가 settle 하지 못한다(삼순 라운드2 blocker).
      while (
        this.encoder &&
        this.encoder.state === "configured" &&
        this.encoder.encodeQueueSize > 4
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    async flush(): Promise<void> {
      await this.encoder?.flush();
    }
    close(): void {
      this.encoder?.close();
      this.encoder = null;
    }
  }
  registerEncoder(RealtimeForcedAvcEncoder);
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
    /** 시도당 실행 상한(ms) — 회귀 주입용, 기본 VENUE_VIDEO_COMPRESS_DEADLINE_MS */
    deadlineMs?: number;
  },
): Promise<File | null> {
  if (!isVideoCompressSupported()) return null;
  try {
    // dynamic import — 초기 번들 영향 0, cap 초과 영상에서만 로드
    const mb = await import("mediabunny");
    const { Input, Output, Conversion, Mp4OutputFormat, BufferTarget, BlobSource, ALL_FORMATS, canEncodeVideo } = mb;
    ensureRealtimeEncoderRegistered(mb); // WebKit<26 bitrate 무시 버그 우회(realtime 강제)
    if (!(await canEncodeVideo("avc"))) return null;

    const dims = computeScaledDimensions(opts.width, opts.height);
    const attempt = async (bitrate: number): Promise<File | null> => {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      // 음수 first timestamp(AAC priming) 보정 — 없으면 iOS 에서 오디오 트랙 discard 됨
      const tracks = await input.getTracks();
      const trim = computeNegativeStartTrim(
        await Promise.all(tracks.map((t) => t.getFirstTimestamp())),
      );
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: "avc",
          bitrate,
          forceTranscode: true,
          ...(dims ? { width: dims.width, height: dims.height, fit: "contain" as const } : {}),
        },
        ...(trim ? { trim } : {}),
        // audio 옵션 없음 = 원본 패킷 복사(passthrough) — iOS(AudioEncoder/Decoder 부재) 전제
      });
      // 트랙이 하나라도 드랍되면(예: 오디오 코덱을 mp4 에 못 담음) 무단 무음화 금지 → fallback
      if (!conversion.isValid || conversion.discardedTracks.length > 0) return null;
      conversion.onProgress = (p: number) => opts.onProgress?.(p);
      // 무기한 await 금지 — deadline 초과 시 cancel() 로 중단하고 fallback(삼순 #814 blocker)
      const completed = await executeWithDeadline(
        conversion,
        opts.deadlineMs ?? VENUE_VIDEO_COMPRESS_DEADLINE_MS,
      );
      if (!completed) return null;
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

/** 파일 선두 n바이트를 읽는다(실패 시 null — 판정 미상 취급). */
async function readHeadBytes(file: Blob, n: number): Promise<Uint8Array | null> {
  try {
    const buf = await file.slice(0, n).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** 원본 영상의 faststart 여부 — 미상이면 null. */
export async function probeFastStart(file: Blob): Promise<boolean | null> {
  const head = await readHeadBytes(file, VENUE_VIDEO_HEAD_PROBE_BYTES);
  if (!head || head.length < 8) return null;
  return isFastStartMp4(head);
}

export interface NormalizeResult {
  /** 실제 업로드할 파일 — 정규화 실패하면 입력 원본 그대로. */
  file: File;
  /** 정규화본을 채택했는지 — 호출부가 메타/포스터 재추출 여부를 결정한다. */
  normalized: boolean;
  /** 진단용 — 원본이 faststart 였는지(null=미상). */
  originalFastStart: boolean | null;
  originalBytes: number;
  normalizedBytes: number | null;
}

/**
 * 업로드 전 720p H.264 + faststart 정규화.
 *
 * 기존 compressVenueVideo 가 "cap 초과 구제"였다면 이건 "첫 재생 지연 제거"가 목적이다.
 * mediabunny 는 BufferTarget 사용 시 fastStart='in-memory' 로 moov 를 앞으로 민다(명시 고정).
 *
 * 실패/미지원/역효과(결과가 더 크고 원본이 이미 작고 faststart)면 원본을 그대로 돌려
 * 기존 동작을 깨지 않는다(회귀 위험 최소화).
 */
export async function normalizeVenueVideo(
  file: File,
  opts: {
    durationMs: number;
    width: number;
    height: number;
    onProgress?: (ratio: number) => void;
    deadlineMs?: number;
  },
): Promise<NormalizeResult> {
  const originalFastStart = await probeFastStart(file);
  const fallback: NormalizeResult = {
    file,
    normalized: false,
    originalFastStart,
    originalBytes: file.size,
    normalizedBytes: null,
  };
  if (!isVideoCompressSupported()) return fallback;
  try {
    const mb = await import("mediabunny");
    const {
      Input,
      Output,
      Conversion,
      Mp4OutputFormat,
      BufferTarget,
      BlobSource,
      ALL_FORMATS,
      canEncodeVideo,
    } = mb;
    ensureRealtimeEncoderRegistered(mb);
    if (!(await canEncodeVideo("avc"))) return fallback;

    const dims = computeScaledDimensions(
      opts.width,
      opts.height,
      VENUE_VIDEO_NORMALIZE_MAX_EDGE_PX,
    );
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    // fastStart 'in-memory' 명시 — BufferTarget 기본값과 같지만 이 모듈의 계약이므로 고정한다.
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const tracks = await input.getTracks();
    const trim = computeNegativeStartTrim(
      await Promise.all(tracks.map((t) => t.getFirstTimestamp())),
    );
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: "avc",
        bitrate: computeNormalizeBitrate(opts.durationMs),
        forceTranscode: true,
        ...(dims ? { width: dims.width, height: dims.height, fit: "contain" as const } : {}),
      },
      ...(trim ? { trim } : {}),
      // audio 옵션 없음 = 원본 패킷 복사(iOS AudioEncoder 부재 전제 — compressVenueVideo 와 동일)
    });
    if (!conversion.isValid || conversion.discardedTracks.length > 0) return fallback;
    conversion.onProgress = (p: number) => opts.onProgress?.(p);
    const completed = await executeWithDeadline(
      conversion,
      opts.deadlineMs ?? VENUE_VIDEO_COMPRESS_DEADLINE_MS,
    );
    if (!completed) return fallback;
    const buffer = output.target.buffer;
    if (!buffer) return fallback;
    const out = new File([buffer], "venue-story.mp4", { type: "video/mp4" });
    const choice = chooseUploadVideo({
      originalBytes: file.size,
      normalizedBytes: out.size,
      originalFastStart,
    });
    if (choice === "original") {
      return { ...fallback, normalizedBytes: out.size };
    }
    return {
      file: out,
      normalized: true,
      originalFastStart,
      originalBytes: file.size,
      normalizedBytes: out.size,
    };
  } catch {
    return fallback;
  }
}
