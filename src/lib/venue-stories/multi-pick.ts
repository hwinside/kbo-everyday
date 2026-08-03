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

/** 그리드 첫 페이지 크기 — 웜 진입을 첫 화면 분량으로 묶는 점진 pagination(삼순 라운드2 #3). */
export const VENUE_LIBRARY_FIRST_PAGE_SIZE = 24;
/** '더 불러오기' 페이지 크기 */
export const VENUE_LIBRARY_PAGE_SIZE = 60;

/**
 * 프리뷰 렌더 모드 판정 — 선택 확정 즉시 네이티브 썸네일(img)로 프리뷰를 열고,
 * 영상 <video> 는 원본 blob 이 준비된 뒤에만 붙인다(선택→즉시 프리뷰 P95 ≤0.3초,
 * 원본 export 는 백그라운드 비동기 — 삼순 라운드2 #2).
 */
export function previewMediaMode(input: {
  kind: "image" | "video";
  previewUrl: string | null;
  originalReady: boolean;
}): "video" | "image" | "placeholder" {
  if (!input.previewUrl) return "placeholder";
  if (input.kind === "video") {
    return input.originalReady && input.previewUrl.startsWith("blob:") ? "video" : "image";
  }
  return "image";
}

/**
 * 앱 복귀(기기 설정/Limited 시트에서 돌아옴) 시 사진첩 재조회 판정 — 그리드가 열려 있고
 * 문서가 다시 보일 때만 권한+목록을 다시 읽는다(설정에서 허용해도 denied/stale 화면이
 * 남는 회귀 방지 — 삼순 라운드2 #1).
 */
export function shouldRefreshLibraryOnResume(input: {
  libraryOpen: boolean;
  documentVisible: boolean;
}): boolean {
  return input.libraryOpen && input.documentVisible;
}

/**
 * 픽커 모드 판정 — version gate.
 * 설치 앱(native runtime) + 네이티브 `VenueMediaLibrary` 브릿지 가용일 때만 커스텀 그리드.
 * 플러그인 없는 구설치본(원격 WebView 만 최신)·웹/PWA 는 기존 file input 픽커로 폴백해
 * 업로드 동선이 끊기지 않는다(삼순 NO-GO 라운드1 #2 구버전 호환 계약).
 */
export function resolveVenuePickerMode(input: {
  nativeRuntime: boolean;
  pluginAvailable: boolean;
}): "grid" | "fileInput" {
  return input.nativeRuntime && input.pluginAvailable ? "grid" : "fileInput";
}

/**
 * 그리드 한 화면 멀티셀렉트 토글 — 선택 순서(1→2→3) 보존.
 * 이미 선택된 id 는 해제(뒤 항목 번호가 한 칸씩 당겨진다), 상한 도달 시 무변경+overMax 플래그.
 */
export function toggleAssetSelection(
  selected: readonly string[],
  assetId: string,
  max: number = VENUE_STORY_MAX_ITEMS,
): { next: string[]; overMax: boolean } {
  if (selected.includes(assetId)) {
    return { next: selected.filter((id) => id !== assetId), overMax: false };
  }
  if (selected.length >= max) return { next: [...selected], overMax: true };
  return { next: [...selected, assetId], overMax: false };
}

/** 그리드 상단 미디어 타입 토글 — 전체 / 사진 / 영상. */
export type VenueLibraryFilter = "all" | "image" | "video";

/** 토글 탭 정의(라벨 포함) — UI 와 회귀가 같은 소스를 쓴다. */
export const VENUE_LIBRARY_FILTERS: ReadonlyArray<{
  value: VenueLibraryFilter;
  label: string;
}> = [
  { value: "all", label: "전체" },
  { value: "image", label: "사진" },
  { value: "video", label: "영상" },
];

/**
 * 타입 필터 적용 — 네이티브 열거는 사진+영상을 한 페이지에 섞어 내려주므로(iOS/Android 공통
 * 하드코딩) 화면단에서 kind 로 걸러 낸다. 원본 배열의 최근순은 그대로 보존한다.
 */
export function filterLibraryAssets<T extends { kind: "image" | "video" }>(
  assets: readonly T[],
  filter: VenueLibraryFilter,
): T[] {
  if (filter === "all") return [...assets];
  return assets.filter((a) => a.kind === filter);
}

/**
 * 필터 탭에서 한 화면을 채우기 위한 최소 노출 개수.
 * 영상만 보기에서 첫 페이지(24)에 영상이 1~2개뿐이면 빈 화면처럼 보이므로,
 * 이 수치에 못 미치면 다음 페이지를 자동으로 이어 받는다.
 */
export const VENUE_LIBRARY_FILTER_MIN_VISIBLE = 12;

/**
 * 필터 탭 자동 추가 로드 상한(페이지 수). 영상이 아예 없는 사진첩에서 커서를 끝까지
 * 따라가며 브릿지를 무한 호출하지 않도록 bounded 로 묶는다. 상한 도달 후에는
 * 기존 '더 불러오기' 수동 동선만 남는다.
 */
export const VENUE_LIBRARY_FILTER_MAX_AUTO_PAGES = 6;

/**
 * 필터 적용 상태에서 다음 페이지를 자동으로 더 읽어야 하는지 판정(순수).
 * - 전체 탭은 자동 추가 로드를 하지 않는다(기존 동작 보존).
 * - 커서가 없으면(사진첩 끝) 더 읽을 것이 없다.
 * - 로딩 중이면 중복 호출 금지.
 * - 자동 로드는 MAX_AUTO_PAGES 회로 bounded.
 */
export function shouldAutoLoadMoreForFilter(input: {
  filter: VenueLibraryFilter;
  visibleCount: number;
  hasCursor: boolean;
  loading: boolean;
  autoPages: number;
  minVisible?: number;
  maxAutoPages?: number;
}): boolean {
  if (input.filter === "all") return false;
  if (!input.hasCursor || input.loading) return false;
  const minVisible = input.minVisible ?? VENUE_LIBRARY_FILTER_MIN_VISIBLE;
  const maxAutoPages = input.maxAutoPages ?? VENUE_LIBRARY_FILTER_MAX_AUTO_PAGES;
  if (input.autoPages >= maxAutoPages) return false;
  return input.visibleCount < minVisible;
}

/**
 * 필터 탭이 비었을 때의 안내 문구. '사진첩에 아무것도 없음'과
 * '이 타입만 없음'을 구분해 유저가 토글을 되돌릴 수 있게 한다.
 */
export function libraryEmptyMessage(input: {
  filter: VenueLibraryFilter;
  totalLoaded: number;
  hasAnyMedia?: boolean;
}): string {
  const hasAnyMedia = input.hasAnyMedia ?? input.totalLoaded > 0;
  if (input.filter === "video") {
    return hasAnyMedia ? "최근 영상이 없어요" : "최근 사진·영상이 없어요";
  }
  if (input.filter === "image") {
    return hasAnyMedia ? "최근 사진이 없어요" : "최근 사진·영상이 없어요";
  }
  return "최근 사진·영상이 없어요";
}

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
