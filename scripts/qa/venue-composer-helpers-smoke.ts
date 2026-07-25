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
  ownsImagePreviewReadLock,
  venueStorySubmitReady,
  buildProcessingStory,
  completeRequestedUploadStatuses,
  terminalUploadFailureIds,
  mergePendingStories,
  PENDING_POLL_DELAYS_MS,
} from "../../src/lib/venue-stories/composer-helpers";
import { computeScrollLockStyle } from "../../src/lib/venue-stories/scroll-lock";
import { readFileAsDataURL, type DataUrlReaderLike } from "../../src/lib/venue-stories/read-file";
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
ok(
  "superseded read도 현재 lock 소유자면 해제(영상/취소로 seq만 바뀐 경우)",
  ownsImagePreviewReadLock(2, 2),
);
ok(
  "새 이미지 read가 lock을 인수했으면 이전 read가 해제하지 않음",
  !ownsImagePreviewReadLock(2, 3),
);
ok(
  "reset으로 lock 소유권이 사라지면 late read는 해제 동작 없음",
  !ownsImagePreviewReadLock(2, null),
);

// ── A2) venueStorySubmitReady: 제출 게이트는 file 기준(readingPreview 분리, #845) ─────
console.log("venueStorySubmitReady (제출 게이트 = file 확정 기준, 프리뷰 read 무관):");
const gateAllOpen = { hasFile: true, submitting: false, gateBlocked: false, agreed: true, precheckReady: true };
ok(
  "① file 확정+동의+게이트오픈 → 제출 가능(프리뷰 read 지연/중복 change 로 lock stuck 이더라도)",
  venueStorySubmitReady(gateAllOpen) === true,
);
ok(
  "① file 없으면 제출 불가(확정된 파일이 제출 게이트)",
  venueStorySubmitReady({ ...gateAllOpen, hasFile: false }) === false,
);
ok(
  "③ 영상 경로도 동일 — file 확정만으로 즉시 게이트 오픈(read 단계 없음, 무변경)",
  venueStorySubmitReady(gateAllOpen) === true,
);
ok(
  "④ read 실패로 file 미확정(hasFile=false) → 제출 불가",
  venueStorySubmitReady({ ...gateAllOpen, hasFile: false }) === false,
);
ok(
  "시간창/구장 차단(gateBlocked) → 제출 불가(게이트 로직 무변경 #847/#849)",
  venueStorySubmitReady({ ...gateAllOpen, gateBlocked: true }) === false,
);
ok(
  "동의 안 하면 제출 불가",
  venueStorySubmitReady({ ...gateAllOpen, agreed: false }) === false,
);
ok(
  "precheck 미통과(GPS 선체크) → 제출 불가",
  venueStorySubmitReady({ ...gateAllOpen, precheckReady: false }) === false,
);
ok(
  "업로드 중(submitting) → 제출 불가(이중 제출 방지)",
  venueStorySubmitReady({ ...gateAllOpen, submitting: true }) === false,
);

// ② A→B 재선택: 늦게 온 A read 는 discard(최신 B file 유지) — resolveImagePreview 가 거버
console.log("A→B 재선택 최신 file 기준(#845/#839):");
ok(
  "② A(seq2) read 완료 시 이미 B(seq3)가 최신 → A preview 반영 안함(discard), 제출은 최신 B file 기준",
  resolveImagePreview({ pickSeq: 2, currentSeq: 3, read: { ok: true, dataUrl: "data:B" } }) === "discard",
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
  [41, 42, 43, 44],
  [
    { id: 41, status: "pending" },
    { id: 42, status: "removed" },
    { id: 44, status: "cleanup_failed" },
  ],
);
ok(
  "cleanup DELETE로 응답에서 사라진 요청 id → missing 보완",
  completedStatuses.some((row) => row.id === 43 && row.status === "missing"),
);
const terminalIds = terminalUploadFailureIds(completedStatuses);
ok(
  "removed/missing/cleanup_failed는 실패 종결, pending은 계속 추적",
  terminalIds.has(42) && terminalIds.has(43) && terminalIds.has(44) && !terminalIds.has(41),
);

// ── E) readFileAsDataURL: 안드로이드 content:// hang → timeout 종결(하린아빠 A17) ────
// 배경: onload/onerror 를 끝내 안 쏘는 File 이면 read await 가 영원히 멈춰 컴포저
// readingPreview lock 이 영구 stuck → 프리뷰는 떠도 '올리기' 회색(영상은 무영향).
// probeVideoDurationMs(삼순 #813)처럼 timeout 으로 반드시 settle 시켜야 lock 이 풀린다.
async function runReadFileTests() {
  console.log("\nreadFileAsDataURL (이미지 read timeout 종결):");

  // 제어 가능한 fake FileReader + fake timer
  function makeFakeReader() {
    let onTimeout: (() => void) | null = null;
    const r: DataUrlReaderLike & { _fire: (kind: "load" | "error", value?: string) => void; aborted: boolean } = {
      onload: null,
      onerror: null,
      result: null,
      error: null,
      aborted: false,
      readAsDataURL() {
        /* 아무 것도 안 함 — 시나리오별로 _fire 로 수동 발화 */
      },
      abort() {
        this.aborted = true;
      },
      _fire(kind, value) {
        if (kind === "load") {
          (this as { result: string | ArrayBuffer | null }).result = value ?? "";
          this.onload?.();
        } else {
          (this as { error: DOMException | null }).error = new Error("boom") as unknown as DOMException;
          this.onerror?.();
        }
      },
    };
    const timerBox: { fire: (() => void) | null } = { fire: null };
    const deps = {
      timeoutMs: 12_000,
      createReader: () => r,
      setTimer: (cb: () => void) => {
        onTimeout = cb;
        timerBox.fire = () => onTimeout?.();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        timerBox.fire = null;
      },
    };
    return { r, deps, timerBox };
  }

  // 1) onload 발화 → resolve
  {
    const { r, deps } = makeFakeReader();
    const p = readFileAsDataURL(new Blob(["x"]), deps);
    r._fire("load", "data:image/jpeg;base64,AAA");
    const out = await p.then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
    ok("onload → data URL resolve", out.ok && out.v === "data:image/jpeg;base64,AAA");
  }

  // 2) onerror 발화 → reject
  {
    const { r, deps } = makeFakeReader();
    const p = readFileAsDataURL(new Blob(["x"]), deps);
    r._fire("error");
    const rejected = await p.then(() => false, () => true);
    ok("onerror → reject", rejected);
  }

  // 3) onload/onerror 둘 다 미발화 + timeout → reject + abort (hang 종결)
  {
    const { r, deps, timerBox } = makeFakeReader();
    const p = readFileAsDataURL(new Blob(["x"]), deps);
    timerBox.fire?.(); // 타임아웃 발화
    const rejected = await p.then(() => false, () => true);
    ok("onload/onerror 미발화 + timeout → reject (lock stuck 방지)", rejected);
    ok("timeout 시 reader.abort() 호출(리소스 회수)", r.aborted === true);
  }

  // 4) timeout 후 늦게 onload 발화 → 이중 settle 없음(handler 해제)
  {
    const { r, deps, timerBox } = makeFakeReader();
    const p = readFileAsDataURL(new Blob(["x"]), deps);
    timerBox.fire?.();
    await p.catch(() => {});
    ok("timeout 후 onload/onerror handler 해제(늦은 발화 no-op)", r.onload === null && r.onerror === null);
  }
}

void runReadFileTests().then(() => {
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
});
