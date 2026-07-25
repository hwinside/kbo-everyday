// 직관 스토리 컴포저 순수 헬퍼 — 이미지 프리뷰 원자성 판정 + 영상 pending 낙관 목록 병합.
// UI state 반영은 컴포넌트가 하되, 판정/병합 로직은 여기로 분리해 회귀 테스트로 고정한다.
// (삼순 #839 리뷰: 이미지 A→B 원자성 + delayed/rejected 회귀 + pending 처리중 카드 요구)

import type { VenueStory, VenueStoryMediaType } from "./types";

export interface UploadStatus {
  id: number;
  status: string;
}

/** cleanup 뒤 사라진 요청 id도 missing terminal 상태로 완성한다. */
export function completeRequestedUploadStatuses(
  requestedIds: readonly number[],
  rows: readonly UploadStatus[],
): UploadStatus[] {
  const returnedIds = new Set(rows.map((row) => row.id));
  return [
    ...rows,
    ...requestedIds
      .filter((id) => !returnedIds.has(id))
      .map((id) => ({ id, status: "missing" })),
  ];
}

/** 클라이언트가 pending 추적을 끝내고 재업로드 카드로 전환해야 하는 terminal 상태. */
export function terminalUploadFailureIds(rows: readonly UploadStatus[]): Set<number> {
  return new Set(
    rows
      .filter(
        (row) =>
          row.status === "removed" ||
          row.status === "missing" ||
          row.status === "cleanup_failed",
      )
      .map((row) => row.id),
  );
}

/**
 * 이미지 data URL 읽기 결과를 어떻게 반영할지 판정한다.
 * - apply   : 최신 픽 + 읽기 성공 → file·preview 원자 반영
 * - discard : 읽는 사이 reset/새 픽이 끼어듦(seq 불일치) → 조용히 버림(늦게 온 결과가 최신 선택을 덮지 않게)
 * - error   : 최신 픽인데 FileReader 실패 → 파일 미반영 + 에러 안내(파일만 활성·프리뷰 없음 상태 방지)
 */
export type ImagePreviewOutcome = "apply" | "discard" | "error";

export function resolveImagePreview(opts: {
  pickSeq: number;
  currentSeq: number;
  read: { ok: true; dataUrl: string } | { ok: false };
}): ImagePreviewOutcome {
  const superseded = opts.pickSeq !== opts.currentSeq;
  if (!opts.read.ok) {
    // 읽기 실패라도 이미 지나간(늦은) 픽이면 조용히 버리고, 최신 픽이면 에러 노출.
    return superseded ? "discard" : "error";
  }
  return superseded ? "discard" : "apply";
}

/**
 * 완료된 이미지 read가 현재 preview lock의 소유자인지 판정한다.
 * superseded 결과라도 뒤 픽이 영상/취소라 새 이미지 read가 lock을 인수하지 않았을 수 있으므로,
 * 단순 discard만으로 lock을 방치하지 않고 소유자만 안전하게 해제한다.
 */
export function ownsImagePreviewReadLock(
  completedSeq: number,
  activeReadSeq: number | null,
): boolean {
  return activeReadSeq === completedSeq;
}

/**
 * 영상 업로드 직후(pending) 트레이에 즉시 띄울 낙관 '처리중' 카드를 만든다.
 * 서버 GET 은 active 만 조회하므로, 검증 승급 전까지 이 카드가 "올렸는데 안 뜬다"를 막는다.
 */
export function buildProcessingStory(opts: {
  id: number;
  gameId: string;
  userId: string;
  mediaType: VenueStoryMediaType;
  thumbUrl: string | null;
  author: { nickname: string | null; avatarUrl: string | null; teamId: number | null };
  nowIso?: string;
}): VenueStory {
  return {
    id: opts.id,
    gameId: opts.gameId,
    userId: opts.userId,
    mediaType: opts.mediaType,
    mediaUrl: "", // pending — 공개 객체 아직 없음(재생 대신 처리중 표시)
    thumbUrl: opts.thumbUrl,
    durationMs: null,
    width: null,
    height: null,
    caption: null,
    venueVerified: true,
    createdAt: opts.nowIso ?? new Date().toISOString(),
    author: opts.author,
    processing: true,
  };
}

/**
 * 서버 목록(active)과 로컬 낙관 pending 카드를 병합한다.
 * - 서버가 낙관 id 를 active 로 반환하면 → 낙관 카드 제거하고 서버 카드 사용(중복·stale 방지, 재생 가능).
 * - 아직 반환 안 했으면(여전히 pending) → 낙관 '처리중' 카드를 목록 앞에 유지.
 * pendingIds 에 없는 낙관 카드는 유지하지 않는다(만료·삭제된 낙관 정리).
 */
export function mergePendingStories(
  prev: VenueStory[],
  server: VenueStory[],
  pendingIds: ReadonlySet<number>,
): VenueStory[] {
  const serverIds = new Set(server.map((s) => s.id));
  const keptOptimistic = prev.filter(
    (s) => s.processing === true && pendingIds.has(s.id) && !serverIds.has(s.id),
  );
  return [...keptOptimistic, ...server];
}

/**
 * pending → active 승급을 감지하기 위한 재조회 백오프(ms). 서버 즉시 ffprobe 검증은 보통
 * 수 초, fault 시 최대 30분 복구 워커라 앞은 촘촘히·뒤는 성기게. 마지막까지 안 뜨면 낙관 카드는
 * 다음 자연 새로고침에서 정리된다(데이터는 서버에 안전).
 */
export const PENDING_POLL_DELAYS_MS: readonly number[] = [
  2000, 4000, 7000, 12000, 20000, 30000, 45000, 60000,
];
