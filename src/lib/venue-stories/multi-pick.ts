// 직관 스토리 네이티브 멀티픽(최대 3개) 순수 헬퍼 — 병합/순서/타입 배지/진행률/완료 요약/재시도 판정.
// UI state 반영은 VenueStoryComposer 가 하되, 판정 로직은 여기로 분리해 회귀로 고정한다.
// (스펙: 선택 스트립 1→2→3 순서 · 사진에 영상 길이 배지 금지 · 실패건만 개별 재시도 —
//  #product 1785211442.603729 목업 비주얼 삼순 GO 2026-07-29)

/** 한 번에 올릴 수 있는 항목 수 상한 (목업 A/B/C/D 전부 3개 기준) */
export const VENUE_STORY_MAX_ITEMS = 3;

export const VENUE_STORY_OVER_MAX_MSG = `한 번에 최대 ${VENUE_STORY_MAX_ITEMS}개까지 올릴 수 있어요`;

/** 하단 sticky CTA 단일 라벨 (상단 공유 버튼 없음 계약) */
export const VENUE_STORY_CTA_LABEL = "전체 팀 공유";

/** fetch 자체가 던진(응답 없는) 실패의 1줄 사유 */
export const VENUE_UPLOAD_NETWORK_FAIL_MSG = "네트워크 오류";

export type MultiItemStatus = "ready" | "uploading" | "done" | "failed";

/**
 * 픽 identity — 같은 파일을 다시 골랐을 때 중복 항목 방지용.
 * File 객체 자체는 픽마다 새 인스턴스라 name+size+lastModified 로 판별한다.
 */
export function pickIdentity(f: {
  name: string;
  size: number;
  lastModified: number;
}): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

/**
 * 기존 선택 + 새 픽 병합 — 선택 순서 보존(기존 먼저, 새 항목 뒤에 append), 중복 제거,
 * 상한 초과분 drop. 반환값의 drop 카운트로 호출부가 안내 문구를 결정한다.
 */
export function mergePickedItems<T>(
  existing: readonly T[],
  incoming: readonly T[],
  identity: (item: T) => string,
  max: number = VENUE_STORY_MAX_ITEMS,
): { merged: T[]; droppedDuplicate: number; droppedOverMax: number } {
  const merged: T[] = [...existing];
  const seen = new Set(existing.map(identity));
  let droppedDuplicate = 0;
  let droppedOverMax = 0;
  for (const item of incoming) {
    const id = identity(item);
    if (seen.has(id)) {
      droppedDuplicate++;
      continue;
    }
    if (merged.length >= max) {
      droppedOverMax++;
      continue;
    }
    seen.add(id);
    merged.push(item);
  }
  return { merged, droppedDuplicate, droppedOverMax };
}

/** durationMs → `0:12` 형식. 0/음수/미상은 null(배지 미표시). */
export function formatDurationBadge(durationMs: number | null | undefined): string | null {
  if (durationMs == null || durationMs <= 0) return null;
  const totalSec = Math.max(1, Math.round(durationMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 미디어 타입 정합 배지 — **사진은 durationMs 가 있어도 길이 배지를 달지 않는다**(스펙 게이트).
 * 영상은 duration 미상(probe 실패)이면 배지 없이 재생 아이콘만 남긴다.
 */
export function mediaDurationBadge(
  kind: "image" | "video",
  durationMs: number | null | undefined,
): string | null {
  if (kind !== "video") return null;
  return formatDurationBadge(durationMs);
}

/**
 * 전체 진행률(0~100). 종결(done/failed) 항목 = 1, 진행 중 항목 = currentRatio(0~1), 대기 = 0.
 * 전 항목 종결 시 100. 진행 중엔 99 를 넘지 않는다(완료 오인 방지).
 */
export function overallUploadProgress(
  statuses: readonly MultiItemStatus[],
  currentRatio: number,
): number {
  const total = statuses.length;
  if (total === 0) return 0;
  const settled = statuses.filter((s) => s === "done" || s === "failed").length;
  if (settled >= total) return 100;
  const active = statuses.some((s) => s === "uploading")
    ? Math.max(0, Math.min(1, currentRatio))
    : 0;
  return Math.min(99, Math.round(((settled + active) / total) * 100));
}

/** 완료 요약 헤더용 집계 — allSettled 일 때만 요약 화면으로 전환한다. */
export function summarizeUploadOutcome(statuses: readonly MultiItemStatus[]): {
  total: number;
  success: number;
  failed: number;
  allSettled: boolean;
} {
  const total = statuses.length;
  const success = statuses.filter((s) => s === "done").length;
  const failed = statuses.filter((s) => s === "failed").length;
  return { total, success, failed, allSettled: total > 0 && success + failed === total };
}

/**
 * 실패 사유 1줄 매핑 — prepare/서버 사유는 그대로 노출(이미 유저 친화 문구),
 * 응답조차 없는 네트워크 실패는 `네트워크 오류`, 빈 사유는 공통 fallback.
 */
export function uploadFailureReason(
  input: { kind: "prepare" | "server"; message?: string | null } | { kind: "network" },
): string {
  if (input.kind === "network") return VENUE_UPLOAD_NETWORK_FAIL_MSG;
  const msg = input.message?.trim();
  return msg ? msg : "업로드에 실패했어요";
}

/** 재시도 대상 판정 — **실패건만** 개별 재시도(성공/진행 중 항목 재전송 금지 계약). */
export function isRetryableItem(status: MultiItemStatus): boolean {
  return status === "failed";
}
