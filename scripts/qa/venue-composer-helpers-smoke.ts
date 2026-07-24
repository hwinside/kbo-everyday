/**
 * 직관 라이브 컴포저 헬퍼 계약 스모크.
 * 실행: npm run qa:venue-composer-helpers
 * 배경: PR #839 삼순 NO-GO —
 *   A) 이미지 A→B 재선택 원자성: data URL 읽기 완료 후에만 file·preview 반영.
 *      늦게 온(superseded) 결과는 discard, FileReader 실패는 error(파일 미반영).
 *   B) 영상 pending 목록 미노출: 낙관 '처리중' 카드 + active 승급 시 서버 카드로 교체.
 */
import {
  resolveImagePreview,
  buildProcessingStory,
  completeRequestedUploadStatuses,
  terminalUploadFailureIds,
  mergePendingStories,
  PENDING_POLL_DELAYS_MS,
} from "../../src/lib/venue-stories/composer-helpers";
import { computeScrollLockStyle } from "../../src/lib/venue-stories/scroll-lock";
import type { VenueStory } from "../../src/lib/venue-stories/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

// ── A) resolveImagePreview: 원자성 판정 ──────────────────────────────
console.log("resolveImagePreview (이미지 프리뷰 원자성):");
ok(
  "최신 픽 + 읽기 성공 → apply",
  resolveImagePreview({ pickSeq: 3, currentSeq: 3, read: { ok: true, dataUrl: "data:," } }) ===
    "apply",
);
ok(
  "늦은(superseded) 픽 + 읽기 성공 → discard (A→B 재선택 시 A 결과가 B를 덮지 않음)",
  resolveImagePreview({ pickSeq: 2, currentSeq: 3, read: { ok: true, dataUrl: "data:," } }) ===
    "discard",
);
ok(
  "최신 픽 + 읽기 실패 → error (파일만 활성·프리뷰 없음 상태 방지)",
  resolveImagePreview({ pickSeq: 3, currentSeq: 3, read: { ok: false } }) === "error",
);
ok(
  "늦은 픽 + 읽기 실패 → discard (지나간 픽의 실패는 조용히 무시, 최신 선택 유지)",
  resolveImagePreview({ pickSeq: 1, currentSeq: 3, read: { ok: false } }) === "discard",
);

// ── B) buildProcessingStory: 낙관 처리중 카드 ────────────────────────
console.log("buildProcessingStory (낙관 처리중 카드):");
const proc = buildProcessingStory({
  id: 42,
  gameId: "20260724LGHH0",
  userId: "u-1",
  mediaType: "video",
  thumbUrl: "https://x/thumb.jpg",
  author: { nickname: null, avatarUrl: null, teamId: null },
  nowIso: "2026-07-25T00:00:00.000Z",
});
ok("processing=true 플래그", proc.processing === true);
ok("mediaUrl 은 빈 문자열(공개 객체 미존재, 재생 대신 처리중)", proc.mediaUrl === "");
ok("thumbUrl 은 보존(트레이 썸네일 표시)", proc.thumbUrl === "https://x/thumb.jpg");
ok("id/gameId/mediaType 반영", proc.id === 42 && proc.gameId === "20260724LGHH0" && proc.mediaType === "video");

// ── B) mergePendingStories: 서버 목록 + 낙관 카드 병합 ────────────────
console.log("mergePendingStories (pending 병합/교체):");
function activeStory(id: number): VenueStory {
  return {
    id,
    gameId: "g",
    userId: "u",
    mediaType: "video",
    mediaUrl: `https://x/${id}.mp4`,
    thumbUrl: null,
    durationMs: 1000,
    width: null,
    height: null,
    caption: null,
    venueVerified: true,
    createdAt: "2026-07-25T00:00:00.000Z",
    author: { nickname: null, avatarUrl: null, teamId: null },
  };
}
const optimistic = buildProcessingStory({
  id: 42,
  gameId: "g",
  userId: "u",
  mediaType: "video",
  thumbUrl: null,
  author: { nickname: null, avatarUrl: null, teamId: null },
});

// 아직 pending — 서버에 42 없음 → 낙관 카드 앞에 유지
const m1 = mergePendingStories([optimistic, activeStory(10)], [activeStory(10)], new Set([42]));
ok("서버 미반환 pending → 낙관 카드 유지(맨 앞)", m1.length === 2 && m1[0].id === 42 && m1[0].processing === true);

// active 승급 — 서버가 42 반환 → 낙관 제거, 서버 카드(재생 가능) 사용
const m2 = mergePendingStories([optimistic, activeStory(10)], [activeStory(42), activeStory(10)], new Set([42]));
ok(
  "서버 active 반환 → 낙관 제거·서버 카드로 교체(중복 없음, 재생 가능)",
  m2.length === 2 && m2.every((s) => !s.processing) && m2.some((s) => s.id === 42 && s.mediaUrl.includes("42.mp4")),
);

// pendingIds 에서 빠진 낙관 카드는 유지 안 함(만료/삭제된 낙관 정리)
const m3 = mergePendingStories([optimistic, activeStory(10)], [activeStory(10)], new Set());
ok("pendingIds 밖 낙관 카드 → 미유지(stale 낙관 정리)", m3.length === 1 && m3[0].id === 10);

// 중복 방지 — 서버 카드만 남고 낙관 중복 안 생김
const m4 = mergePendingStories([optimistic], [activeStory(42)], new Set([42]));
ok("낙관+서버 동일 id → 서버 1건만(중복 0)", m4.length === 1 && m4[0].id === 42 && !m4[0].processing);

console.log("PENDING_POLL_DELAYS_MS (백오프 재조회):");
ok("증가하는 백오프(앞은 촘촘·뒤는 성기게)", PENDING_POLL_DELAYS_MS.every((d, i, a) => i === 0 || d > a[i - 1]));
ok("첫 재조회 ≤ 3초(빠른 승급 즉시 반영)", PENDING_POLL_DELAYS_MS[0] <= 3000);

// ── C) iOS root scroll lock 순수 스타일 계산(삼순 #839 blocker 3) ────────────────
console.log("\ncomputeScrollLockStyle (iOS root scroll 잠금):");
const sl0 = computeScrollLockStyle(0);
ok("scrollY=0 → position:fixed·top:-0px·width:100%", sl0.position === "fixed" && sl0.top === "-0px" && sl0.width === "100%");
ok("root scroll 차단 — overflow:hidden·overscroll:none", sl0.overflow === "hidden" && sl0.overscrollBehavior === "none");
const sl250 = computeScrollLockStyle(250);
ok("scrollY=250 → top:-250px(시각 점프 방지용 오프셋)", sl250.top === "-250px");
ok("소수 scrollY 반올림(top 정수 px)", computeScrollLockStyle(123.7).top === "-124px");
ok("음수 scrollY 방어(최소 0)", computeScrollLockStyle(-40).top === "-0px");

// ── D) stalled(지연) 카드도 pending 병합 유지 — timeout 후에도 자연 새로고침에 유지되어야 재시도 가능 ─
console.log("\nmergePendingStories (stalled 지연 카드 병합):");
const stalled = { ...optimistic, stalled: true };
const m5 = mergePendingStories([stalled, activeStory(10)], [activeStory(10)], new Set([42]));
ok("stalled(processing:true) 카드 → 서버 미반환이면 유지(재시도 동선 보존)", m5.length === 2 && m5[0].id === 42 && m5[0].stalled === true);
const m6 = mergePendingStories([stalled, activeStory(10)], [activeStory(42), activeStory(10)], new Set([42]));
ok("stalled 이더라도 서버 active 반환면 실제 카드로 교체(지연 해소)", m6.length === 2 && m6.every((s) => !s.processing && !s.stalled));

const failed = { ...optimistic, processing: false, stalled: false, failed: true };
ok("removed/missing 실패 카드는 pending 상태와 구분", failed.failed === true && failed.processing === false);

console.log("\nupload status terminal 계약:");
const completedStatuses = completeRequestedUploadStatuses(
  [41, 42, 43],
  [{ id: 41, status: "pending" }, { id: 42, status: "removed" }],
);
ok(
  "cleanup DELETE로 응답에서 사라진 요청 id → missing 보완",
  completedStatuses.some((row) => row.id === 43 && row.status === "missing"),
);
const terminalIds = terminalUploadFailureIds(completedStatuses);
ok(
  "removed/missing만 실패 종결, pending은 계속 추적",
  terminalIds.has(42) && terminalIds.has(43) && !terminalIds.has(41),
);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
