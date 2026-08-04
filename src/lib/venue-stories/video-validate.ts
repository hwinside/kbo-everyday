// 직관 라이브 — 영상 즉시 검증 순수 코어(B+①, 삼순 09:44 #1).
//
// 계약:
//  - 원본 영상은 private staging(venue-staging)에 status=pending 으로 들어온다(목록·공개 URL 미노출).
//  - 업로드 요청 안에서(또는 복구 경로에서) 서버 권위 ffprobe 로 구조·duration(≤15s+톨러런스)을 검증.
//  - 통과 → 원본을 공개 videos 버킷으로 승격 + status pending→active **CAS** (즉시 공개, 720p 는 백그라운드).
//  - 실패 → status pending→removed CAS + staging 정리(cleanup cron 백업).
//  - fault(다운로드/ffprobe 실행 불가 등) → pending 유지(검증 약화 금지) — 30분 복구 워커가 처리.
//  - CAS(status='pending' 조건 갱신)라 즉시 경로와 복구 워커가 중복 claim 할 수 없다.
//
// 이 파일은 순수 로직 + 의존성 주입 오케스트레이터만 담아 스모크 테스트가 가능하다.
// 실제 supabase/ffprobe 바인딩은 video-validate-server.ts.

import {
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
} from "./types";

export interface FfprobeMeta {
  durationMs: number;
  width: number | null;
  height: number | null;
  hasVideoStream: boolean;
}

/**
 * 서버가 실측한 "이 영상이 스트리밍에 최적인가" 지표.
 * 클라이언트 보고를 신뢰하지 않는다 — 바이트/ffprobe 실측값만 쓴다.
 */
export interface ServeReadiness {
  /** 상위 박스 순서로 판정한 faststart(null=선두에서 미상). */
  fastStart: boolean | null;
  /** 긴 변 픽셀(알 수 없으면 null). */
  maxEdge: number | null;
}

/** 720p 기준 — 이보다 크면 서버 후속 최적화 대상이다. */
export const SERVE_READY_MAX_EDGE_PX = 1280;
/** 서버 후속 최적화 판정에 쓰는 비트레이트 상한(bps) — 이보다 높으면 재인코딩 가치가 있다. */
export const SERVE_READY_MAX_BITRATE_BPS = 6_000_000;

/**
 * 서버 후속 720p 재인코딩 큐(needs_transcode)에 올려야 하는가.
 *
 * 삼순 NO-GO ③ 반영: 클라이언트 정규화가 실패/미지원이면 느린 원본이 그대로 올라가는데,
 * 그 중 diary_manual 은 archived + needs_transcode=false 로 **종결**되어 원 버그가 영구 보존됐다.
 * 이제 서버가 실측값으로 판정해 "이미 충분히 가벼운 faststart mp4" 가 아니면 경로와 무관하게
 * 큐에 올린다. 미상(null)은 fail-close — 큐에 올려서 워커가 확인하게 한다.
 */
export function needsServerTranscode(input: {
  readiness: ServeReadiness;
  bytes: number;
  durationMs: number;
}): boolean {
  const { readiness, bytes, durationMs } = input;
  if (readiness.fastStart !== true) return true; // 미상도 큐에 올린다(fail-close)
  if (readiness.maxEdge == null || readiness.maxEdge > SERVE_READY_MAX_EDGE_PX) return true;
  if (!(durationMs > 0) || !(bytes > 0)) return true; // 계산 불가 → 큐
  const bitrateBps = (bytes * 8 * 1000) / durationMs;
  return bitrateBps > SERVE_READY_MAX_BITRATE_BPS;
}

/** ffprobe -of json stdout → 메타 파싱. 구조가 아니면 null(bad_structure 로 이어짐). */
export function parseFfprobeJson(stdout: string): FfprobeMeta | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j == null) return null;
  const obj = j as {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string };
  };
  const streams = Array.isArray(obj.streams) ? obj.streams : [];
  const video = streams.find((s) => s?.codec_type === "video") ?? null;
  const durSec = parseFloat(obj.format?.duration ?? "");
  const durationMs = Number.isFinite(durSec) ? Math.round(durSec * 1000) : NaN;
  return {
    durationMs: Number.isFinite(durationMs) ? durationMs : -1,
    width: typeof video?.width === "number" ? video.width : null,
    height: typeof video?.height === "number" ? video.height : null,
    hasVideoStream: video != null,
  };
}

export type VideoVerdict =
  | { ok: true; meta: FfprobeMeta }
  | { ok: false; reason: "bad_structure" | "no_video_stream" | "duration_exceeded" };

/** 서버 권위 판정 — 클라 durationMs 는 힌트일 뿐 신뢰하지 않는다. */
export function decideVideoVerdict(
  meta: FfprobeMeta | null,
  maxDurationMs: number = VENUE_STORY_MAX_DURATION_MS,
  toleranceMs: number = VENUE_STORY_DURATION_TOLERANCE_MS,
): VideoVerdict {
  if (meta == null) return { ok: false, reason: "bad_structure" };
  if (!meta.hasVideoStream) return { ok: false, reason: "no_video_stream" };
  if (meta.durationMs <= 0) return { ok: false, reason: "bad_structure" }; // duration 미상도 거부(권위 검증 불가)
  if (meta.durationMs > maxDurationMs + toleranceMs) {
    return { ok: false, reason: "duration_exceeded" };
  }
  return { ok: true, meta };
}

export interface PendingVideoRow {
  id: number;
  media_bucket: string;
  media_path: string;
}

export type ValidateOutcome =
  | { outcome: "promoted"; meta: FfprobeMeta }
  | { outcome: "rejected"; reason: "bad_structure" | "no_video_stream" | "duration_exceeded" }
  | { outcome: "already_claimed" } // CAS 패배 — 다른 경로(즉시/복구)가 이미 처리
  | { outcome: "fault"; step: string }; // pending 유지 → 복구 워커 재시도

export interface ValidateDeps {
  /** staging 원본 다운로드(≤maxBytes 강제). null = fault. */
  download(bucket: string, path: string): Promise<{ filePath: string; bytes: number } | null>;
  /** ffprobe 실행+파싱. null = 구조 불량(거부), "fault" = 실행 불가(검증 약화 금지 → pending 유지). */
  probe(filePath: string): Promise<FfprobeMeta | null | "fault">;
  /** 원본을 공개 버킷으로 게시. false = fault. */
  publishOriginal(stagingPath: string, filePath: string): Promise<boolean>;
  /**
   * pending→active CAS. true=승격, false=이미 claim 됨, "fault"=DB 오류.
   * needsTranscode 는 서버 실측 기반 후속 최적화 큐 플래그(경로별 고정값 아님).
   */
  promoteRow(
    id: number,
    meta: FfprobeMeta,
    opts: { needsTranscode: boolean },
  ): Promise<boolean | "fault">;
  /**
   * 다운로드한 원본의 서빙 적합성 실측(박스 순서 등). 읽을 수 없으면 fastStart=null.
   * 주입 가능해야 스모크가 계약을 실행 검증할 수 있다.
   */
  inspectServeReadiness(filePath: string, meta: FfprobeMeta): Promise<ServeReadiness>;
  /** pending→removed CAS. true=거부 확정, false=이미 claim 됨, "fault"=DB 오류. */
  rejectRow(id: number): Promise<boolean | "fault">;
  /** staging/게시 잔여물 정리(베스트에포트 — cleanup cron 이 백업). */
  removeObject(bucket: string, path: string): Promise<void>;
  cleanupTemp(filePath: string): void;
}

/**
 * pending 영상 1건 즉시 검증·승격 오케스트레이션.
 * 노출 불변식: promoteRow CAS 성공 전에는 절대 active 가 되지 않는다.
 */
export async function validateAndPromoteVideo(
  deps: ValidateDeps,
  row: PendingVideoRow,
): Promise<ValidateOutcome> {
  const dl = await deps.download(row.media_bucket, row.media_path);
  if (dl == null) return { outcome: "fault", step: "download" };
  try {
    const meta = await deps.probe(dl.filePath);
    if (meta === "fault") return { outcome: "fault", step: "probe" }; // 검증 약화 금지 — pending 유지
    const verdict = decideVideoVerdict(meta);
    if (!verdict.ok) {
      const rejected = await deps.rejectRow(row.id);
      if (rejected === "fault") return { outcome: "fault", step: "reject" };
      if (rejected === false) return { outcome: "already_claimed" };
      await deps.removeObject(row.media_bucket, row.media_path); // staging 정리(베스트에포트)
      return { outcome: "rejected", reason: verdict.reason };
    }
    // 통과 → 원본 공개 게시 후에만 CAS 승격(승격 전 목록·URL 미노출 유지)
    const published = await deps.publishOriginal(row.media_path, dl.filePath);
    if (!published) return { outcome: "fault", step: "publish" };
    // 서버 실측으로 후속 최적화 필요 여부를 정한다 — 클라이언트가 정규화에 실패해 느린 원본을
    // 올렸으면 경로(active/archived)와 무관하게 큐에 올라간다(삼순 NO-GO ③).
    const readiness = await deps.inspectServeReadiness(dl.filePath, verdict.meta);
    const needsTranscode = needsServerTranscode({
      readiness,
      bytes: dl.bytes,
      durationMs: verdict.meta.durationMs,
    });
    const promoted = await deps.promoteRow(row.id, verdict.meta, { needsTranscode });
    if (promoted === "fault") return { outcome: "fault", step: "promote" };
    if (promoted === false) {
      // CAS 패배 — winner가 동일 key(row.media_path)로 공개 버킷에 이미 게시했으므로 삭제 금지
      // 불변식: status=active → publicExists=true 유지. loser의 publish는 upsert라 동일 객체.
      return { outcome: "already_claimed" };
    }
    await deps.removeObject(row.media_bucket, row.media_path); // staging 원본 제거(베스트에포트)
    return { outcome: "promoted", meta: verdict.meta };
  } finally {
    deps.cleanupTemp(dl.filePath);
  }
}
