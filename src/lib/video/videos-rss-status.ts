export type VideosRssStatus = "success" | "warning" | "error";

export interface VideosRssStatusInput {
  /** core 성공(RSS 수집+upsert 성공, fallback recovered 포함) 채널 수 */
  okCount: number;
  /** 실제 core 실패 채널 수 (errorCount - fallbackNoUploads). dead/silent 채널은 제외 */
  coreFailedCount: number;
  /** quota 원장 RPC 장애 여부 */
  ledgerErr: boolean;
}

/**
 * videos-rss cron 의 job status 판정 (순수 함수 — 회귀 테스트 가능).
 *
 * 판정 규칙:
 *   - okCount === 0        → error   : 전 채널 수집 전멸. RSS 전부 실패 + fallback
 *                                       전부 noUploads(dead/silent)여도 성공으로 숨기지 않는다.
 *                                       (호출부에서 channels.length>0 가 보장되므로
 *                                        okCount===0 은 곧 전멸을 의미)
 *   - coreFailedCount>0
 *     OR ledgerErr         → warning : 일부 core 실패(부분실패) 또는 원장 RPC 장애.
 *   - 그 외                → success : bulk 성공(다수 ok) + dead 채널 몇 건은 success 유지.
 */
export function classifyVideosRssStatus({
  okCount,
  coreFailedCount,
  ledgerErr,
}: VideosRssStatusInput): VideosRssStatus {
  if (okCount === 0) return "error";
  if (coreFailedCount > 0 || ledgerErr) return "warning";
  return "success";
}
