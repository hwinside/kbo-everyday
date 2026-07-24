// 직관 스토리 미디어 제한 게이트 (순수 모듈 — 픽 게이트/업로드 검증/스모크 공유).
// 하린아빠 스펙(2026-07-24): 유저는 방금 찍은 영상이 몇 MB인지 모른다 —
// 영상은 **시간(15초)이 1차 기준**이고, 50MB 바이트 캡은 내부 백스톱으로만 유지한다.
import {
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
} from "./types";

export const VENUE_VIDEO_TOO_LONG_MSG = "영상은 15초 이하만 올릴 수 있어요";
// 15초 이하인데 50MB를 넘는 극단 케이스 — MB 문구 대신 duration-friendly 안내
export const VENUE_VIDEO_TOO_HEAVY_MSG =
  "영상 화질이 너무 높아 올릴 수 없어요. 카메라 설정을 낮춰 다시 촬영해 주세요";
// 사진은 시간 개념이 없으니 바이트 캡 유지 + 친화 문구
export const VENUE_IMAGE_TOO_HEAVY_MSG = "사진 용량이 너무 커요. 다른 사진을 선택해 주세요";

/**
 * 제한 위반 시 유저 노출 문구, 통과 시 null.
 *
 * 영상 게이트 순서: duration(15초) 먼저 → bytes 백스톱.
 * durationMs === null 은 픽 시점 probe 실패(코덱 미지원 등) — 여기선 차단하지 않고
 * 통과시켜 업로드 단계 probeVideo/서버 검증이 fail-close 한다(정상 파일 이중 차단 방지).
 */
export function checkVenueMediaLimits(input: {
  kind: "video" | "image";
  sizeBytes: number;
  durationMs: number | null;
  /**
   * 바이트 백스톱 초과 영상을 클라이언트 자동압축이 처리할 수 있는 환경(WebCodecs 지원).
   * true 면 픽 게이트에서 heavy 차단 대신 통과시켜 업로드 단계 압축에 맡긴다.
   * 압축 후 최종 안전망 검사는 이 플래그 없이 호출한다(upload.ts).
   */
  videoAutoCompressAvailable?: boolean;
}): string | null {
  if (input.kind === "image") {
    return input.sizeBytes > VENUE_STORY_MAX_BYTES ? VENUE_IMAGE_TOO_HEAVY_MSG : null;
  }
  if (input.durationMs == null) return null;
  if (input.durationMs > VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS) {
    return VENUE_VIDEO_TOO_LONG_MSG;
  }
  if (input.sizeBytes > VENUE_STORY_MAX_BYTES && !input.videoAutoCompressAvailable) {
    return VENUE_VIDEO_TOO_HEAVY_MSG;
  }
  return null;
}
