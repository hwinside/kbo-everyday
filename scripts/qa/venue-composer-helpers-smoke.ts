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
  mergePendingStories,
  PENDING_POLL_DELAYS_MS,
} from "../../src/lib/venue-stories/composer-helpers";
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

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
