/**
 * 직관 라이브 스토리 댓글 스모크 — 입력 검증 / 삭제 권한(API 계약) / 댓글 수 집계
 * / 최신 100개 정순 반전(101개 회귀) / 수명주기 게이트 / DB 권위 어뷰징 가드
 * / iOS 키보드 인셋(모킹 visualViewport 회귀) / bottom scroll / migration RLS 계약.
 * 실행: npm run qa:venue-story-comments
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateCommentContent,
  canDeleteComment,
  countVisibleComments,
  toChronological,
  evaluateCommentRate,
  evaluateCommentAbuse,
  isStoryOpenForComments,
  scrollToLatest,
  shouldApplyCommentResponse,
  VENUE_STORY_COMMENT_MAX_LENGTH,
  VENUE_STORY_COMMENT_LIST_LIMIT,
  VENUE_STORY_COMMENT_COOLDOWN_MS,
  VENUE_STORY_COMMENT_WINDOW_MS,
  VENUE_STORY_COMMENT_MAX_IN_WINDOW,
  VENUE_STORY_COMMENT_DUP_RECENT,
} from "../../src/lib/venue-stories/comments";
import {
  computeKeyboardInset,
  isVenueStoryKeyboardOpen,
  subscribeKeyboardInset,
  type VisualViewportLike,
} from "../../src/lib/venue-stories/keyboard-inset";
import {
  computeScrollRestore,
} from "../../src/lib/venue-stories/scroll-lock";
import { shouldCloseCommentSheetDrag } from "../../src/lib/venue-stories/comment-sheet-gesture";
import {
  createPressState,
  markPressStart,
  cancelPress,
  shouldSubmitOnPointerUp,
  canBeginCommentSubmit,
} from "../../src/lib/venue-stories/comment-submit-gesture";
import {
  classifyStoryTap,
  isStoryNavTap,
  STORY_NAV_BOTTOM_OFFSET,
  STORY_NAV_TOP_OFFSET,
  STORY_NAV_TAP_MAX_MS,
  STORY_PILL_BOTTOM_OFFSET,
  STORY_PILL_HEIGHT,
} from "../../src/lib/venue-stories/story-tap-zone";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

console.log("[입력 검증]");
ok("정상 댓글 통과 + trim", (() => {
  const r = validateCommentContent("  오늘 직관 최고!  ");
  return r.ok && r.content === "오늘 직관 최고!";
})());
ok("빈 문자열 거부", validateCommentContent("").ok === false);
ok("공백만 거부", validateCommentContent("   \n  ").ok === false);
ok("문자열 아님(undefined) 거부", validateCommentContent(undefined).ok === false);
ok("문자열 아님(숫자) 거부", validateCommentContent(123).ok === false);
ok(`정확히 ${VENUE_STORY_COMMENT_MAX_LENGTH}자 통과`,
  validateCommentContent("가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH)).ok === true);
ok(`${VENUE_STORY_COMMENT_MAX_LENGTH + 1}자 거부`,
  validateCommentContent("가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH + 1)).ok === false);
ok("trim 후 상한 재계산(공백 패딩으로 우회 불가 아님 — trim 후 200자면 통과)", (() => {
  const r = validateCommentContent("  " + "가".repeat(VENUE_STORY_COMMENT_MAX_LENGTH) + "  ");
  return r.ok === true;
})());

console.log("[삭제 권한 계약 (RLS/API 공용)]");
ok("본인 댓글 삭제 허용", canDeleteComment(ME, ME, false) === true);
ok("타인 댓글 삭제 거부", canDeleteComment(ME, OTHER, false) === false);
ok("비로그인 삭제 거부", canDeleteComment(ME, null, false) === false);
ok("관리자는 타인 댓글 삭제 허용", canDeleteComment(ME, OTHER, true) === true);
ok("관리자 + 비로그인 id 조합도 허용(service_role 경로)", canDeleteComment(ME, null, true) === true);

console.log("[댓글 수 집계 — soft delete 제외]");
ok("미삭제만 집계", countVisibleComments([
  { deleted_at: null },
  { deleted_at: "2026-07-23T12:00:00Z" },
  { deleted_at: null },
]) === 2);
ok("빈 목록 0", countVisibleComments([]) === 0);
ok("전부 삭제면 0", countVisibleComments([{ deleted_at: "2026-07-23T12:00:00Z" }]) === 0);

console.log("[최신 100개 정순 반전 — 101개 회귀]");
{
  // DB 동작 모사: 1..101 생성 → created_at DESC 정렬 → LIMIT 100 → 응답에서 정순 반전
  const all = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    created_at: new Date(1700000000000 + (i + 1) * 1000).toISOString(),
  }));
  const descPage = [...all]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, VENUE_STORY_COMMENT_LIST_LIMIT);
  const shown = toChronological(descPage);
  ok("101개 중 100개 노출", shown.length === 100);
  ok("101번째(최신) 댓글 포함", shown.some((r) => r.id === 101));
  ok("가장 오래된 1번 댓글만 밀려남", !shown.some((r) => r.id === 1));
  ok("정순(오래된→최신) 정렬", shown[0].id === 2 && shown[99].id === 101);
  ok("입력 배열 불변(방어적 복사)", descPage[0].id === 101);
  ok("빈 목록 반전 안전", toChronological([]).length === 0);
}

console.log("[어뷰징 가드 — 10초 간격 / 60초 내 3건]");
{
  const t0 = 1_000_000;
  // 순수 판정
  const r1 = evaluateCommentRate([], t0);
  ok("첫 작성 허용", r1.allowed === true);
  const r2 = evaluateCommentRate(r1.timestamps, t0 + 5_000);
  ok("10초 미만 재작성 차단", r2.allowed === false);
  const r3 = evaluateCommentRate(r1.timestamps, t0 + VENUE_STORY_COMMENT_COOLDOWN_MS);
  ok("10초 경과 후 허용", r3.allowed === true);
  const r4 = evaluateCommentRate(r3.timestamps, t0 + 20_000);
  ok("60초 내 3번째 허용", r4.allowed === true);
  const r5 = evaluateCommentRate(r4.timestamps, t0 + 31_000);
  ok("60초 내 4번째 차단(윈도우 초과)", r5.allowed === false);
  const r6 = evaluateCommentRate(r4.timestamps, t0 + VENUE_STORY_COMMENT_WINDOW_MS + 21_000);
  ok("윈도우 만료 후 다시 허용", r6.allowed === true);
  ok("정책 상수 계약(10s/60s/3건) — CommentSheet 클라 가드와 동일",
    VENUE_STORY_COMMENT_COOLDOWN_MS === 10_000 &&
    VENUE_STORY_COMMENT_WINDOW_MS === 60_000 &&
    VENUE_STORY_COMMENT_MAX_IN_WINDOW === 3);
}

console.log("[DB 권위 어뷰징 가드 — 유저 최근 댓글 행 기반(evaluateCommentAbuse)]");
{
  const now = Date.parse("2026-07-23T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  ok("과거 댓글 없음 → 허용", evaluateCommentAbuse([], "컬로가자", now).allowed === true);
  ok("10초 미만 재작성 차단(DB created_at 기준)",
    evaluateCommentAbuse([{ content: "a", created_at: iso(5_000) }], "b", now).allowed === false);
  ok("10초 경과 후 허용",
    evaluateCommentAbuse([{ content: "a", created_at: iso(10_000) }], "b", now).allowed === true);
  ok("60초 내 3건 이상 차단(윈도우)",
    evaluateCommentAbuse([
      { content: "a", created_at: iso(15_000) },
      { content: "b", created_at: iso(30_000) },
      { content: "c", created_at: iso(45_000) },
    ], "d", now).allowed === false);
  ok("윈도우 밖 오래된 행은 rate 무관",
    evaluateCommentAbuse([
      { content: "a", created_at: iso(70_000) },
      { content: "b", created_at: iso(80_000) },
      { content: "c", created_at: iso(90_000) },
    ], "d", now).allowed === true);
  ok("최근 5건 내 동일내용 반복 차단(정규화 — 공백/런 변형 포함)", (() => {
    const r = evaluateCommentAbuse(
      [{ content: "ㄷㄷㄷ", created_at: iso(20_000) }], "ㄷ ㄷ ㄷㄷ", now);
    return r.allowed === false && r.error === "같은 댓글은 반복해서 달 수 없어요";
  })());
  ok("다른 내용은 허용",
    evaluateCommentAbuse([{ content: "ㄷㄷㄷ", created_at: iso(20_000) }], "오늘 직관 최고", now).allowed === true);
  ok("rate 차단 메시지 계약(429)", (() => {
    const r = evaluateCommentAbuse([{ content: "a", created_at: iso(1_000) }], "b", now);
    return r.allowed === false && r.error === "잠시 후 다시 입력해 주세요";
  })());
  ok("dup 비교 상한 상수(최근 5건)", VENUE_STORY_COMMENT_DUP_RECENT === 5);
}

console.log("[수명주기 게이트 — GET/POST 공용(isStoryOpenForComments)]");
{
  const now = Date.parse("2026-07-23T12:00:00Z");
  const future = new Date(now + 3600_000).toISOString();
  const past = new Date(now - 1_000).toISOString();
  ok("active + 미만료 허용",
    isStoryOpenForComments({ status: "active", expires_at: future }, now) === true);
  ok("만료 스토리 차단(GET 도 404)",
    isStoryOpenForComments({ status: "active", expires_at: past }, now) === false);
  ok("비활성(hidden) 스토리 차단",
    isStoryOpenForComments({ status: "hidden", expires_at: future }, now) === false);
  ok("없는 스토리(null) 차단", isStoryOpenForComments(null, now) === false);
  ok("expires_at 비정상 값 fail-closed",
    isStoryOpenForComments({ status: "active", expires_at: "invalid" }, now) === false);
  ok("경계: 정확히 만료 시각은 차단",
    isStoryOpenForComments({ status: "active", expires_at: new Date(now).toISOString() }, now) === false);
}

console.log("[iOS 키보드 인셋 — 모킹 visualViewport 회귀(삼순 #807 blocker 4)]");
{
  ok("순수 계산: idle(키보드 없음) = 0", computeKeyboardInset(800, 800, 0) === 0);
  ok("순수 계산: 키보드 300px 오픈 = 300", computeKeyboardInset(800, 500, 0) === 300);
  ok("순수 계산: visual viewport 상단 오프셋 반영", computeKeyboardInset(800, 500, 100) === 200);
  ok("순수 계산: 음수 방지(clamp 0)", computeKeyboardInset(800, 900, 0) === 0);
  ok("3상태 idle — focus=false + inset=0이면 viewer visible",
    isVenueStoryKeyboardOpen(false, 0) === false);
  ok("3상태 focus — viewport resize 전에도 focus=true면 viewer hidden",
    isVenueStoryKeyboardOpen(true, 0) === true);
  ok("3상태 blur transition — focus=false여도 inset>0이면 viewer hidden 유지",
    isVenueStoryKeyboardOpen(false, 300) === true);
  ok("3상태 blur settled — inset=0 복귀 뒤에만 viewer visible",
    isVenueStoryKeyboardOpen(false, 0) === false);

  // 모킹 visualViewport — focus→키보드 resize→submit 유지→blur(구독 해제) 시나리오
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  let vvHeight = 800;
  let vvOffsetTop = 0;
  const vv: VisualViewportLike = {
    get height() { return vvHeight; },
    get offsetTop() { return vvOffsetTop; },
    addEventListener: (type, l) => listeners[type].add(l),
    removeEventListener: (type, l) => listeners[type].delete(l),
  };
  const fire = (type: "resize" | "scroll") => listeners[type].forEach((l) => l());
  const insets: number[] = [];
  const unsubscribe = subscribeKeyboardInset(vv, () => 800, (i) => insets.push(i));
  ok("구독 즉시 1회 적용(idle=0)", insets.length === 1 && insets[0] === 0);
  vvHeight = 500; // iOS 키보드 오픈 → 시각 뷰포트 축소
  fire("resize");
  ok("키보드 resize 시 인셋 300 반영", insets[insets.length - 1] === 300);
  vvOffsetTop = 50; // 포커스 유지 중 스크롤(시각 뷰포트 이동)
  fire("scroll");
  ok("visualViewport scroll 시 재계산(250)", insets[insets.length - 1] === 250);
  vvHeight = 800; vvOffsetTop = 0; // 키보드 닫힘
  fire("resize");
  ok("키보드 닫혔 시 0 복귀", insets[insets.length - 1] === 0);
  const count = insets.length;
  unsubscribe(); // blur → effect cleanup
  vvHeight = 400;
  fire("resize");
  fire("scroll");
  ok("구독 해제 후 콜백 없음(blur 누수 방지)", insets.length === count);
  ok("해제 후 리스너 잔류 0", listeners.resize.size === 0 && listeners.scroll.size === 0);
}

console.log("[최신 댓글 bottom scroll — 삼순 #807 blocker 5]");
{
  const el = { scrollTop: 0, scrollHeight: 1234 };
  scrollToLatest(el);
  ok("컨테이너를 맨 아래(scrollHeight)로 이동", el.scrollTop === 1234);
  ok("null 안전(ref 미마운트)", (() => { scrollToLatest(null); return true; })());
}

console.log("[전송 중 스토리 전환 오염 가드 — 삼순 #807 라운드3 blocker 3]");
{
  // 시나리오: A(id=10) 에서 submit 시작 → 수동 next 로 B(id=11) 전환 → A 응답 도착
  const requestStoryId = 10; // submit 시작 시점 캡처
  ok("같은 스토리면 반영", shouldApplyCommentResponse(requestStoryId, 10) === true);
  ok("B 로 전환 후 A 응답 도착 → 반영 스킵(B 목록 미오염)",
    shouldApplyCommentResponse(requestStoryId, 11) === false);
  ok("뷰어 닫힘(null) 후 응답 도착 → 반영 스킵",
    shouldApplyCommentResponse(requestStoryId, null) === false);
  ok("undefined 도 반영 스킵(fail-closed)",
    shouldApplyCommentResponse(requestStoryId, undefined) === false);

  // 컴포넌트 배선 계약(텍스트 레벨) — 가드 함수 사용 + 요청 id 캡처 + nav 잠금
  const viewerSrc = readFileSync(
    path.resolve(process.cwd(), "src/components/game/VenueStoryViewer.tsx"),
    "utf8",
  );
  ok("handleCommentSubmit 이 요청 시점 story.id 를 캡처",
    /const submitStoryId = story\.id/.test(viewerSrc));
  ok("응답 반영 전 shouldApplyCommentResponse 가드 통과",
    /shouldApplyCommentResponse\(submitStoryId, storyIdRef\.current\)/.test(viewerSrc));
  ok("좌/우 탭 이동이 전송 중(commentBusy) 잠금을 본다",
    (viewerSrc.match(/if \(commentBusy\) return;/g) ?? []).length === 2);
  ok("인라인 입력바 제거 — 하단은 댓글 모달 오픈 버튼(data-open-comments)",
    viewerSrc.includes("data-open-comments") &&
    !/onFocus=\{\(\) => setInputFocused/.test(viewerSrc));
  ok("댓글 버튼 탭 → 모달 오픈(setCommentsOpen(true))",
    viewerSrc.includes("setCommentsOpen(true)"));
  ok("iOS 실기기 QA 마커 data-composer=\"venue-story\" 는 모달 컴포저에 부여",
    viewerSrc.includes('data-composer="venue-story"'));
  ok("모달 키보드 회피 — bottom=kbInset + height=vvHeight(CommentSheet 패턴)",
    viewerSrc.includes("bottom: kbInset") && viewerSrc.includes("vvHeight"));
  ok("커뮤니티 CommentSheet 동일 부분 높이 60dvh",
    viewerSrc.includes("min(60dvh") && viewerSrc.includes('"60dvh"'));
  ok("커뮤니티 CommentSheet 동일 spring 열림/닫힘 모션",
    viewerSrc.includes('type: "spring"') && viewerSrc.includes('commentsClosing ? "100%" : 0'));
  ok("댓글 목록 스크롤 중에는 sheet drag close와 구분",
    viewerSrc.includes('data-comment-scroll="true"'));
  // ⭐ iOS 키보드 가림/스크롤 UI 깨짐 재발 방지(#877): 댓글 시트가 뷰어 motion.div 서브트리 안에 nested 되면
  // 뷰어 컨테이너가 만드는 containing block 안에 position:fixed 시트가 갇혀 bottom=kbInset 이 시각 뷰포트가
  // 아닌 갇힌 조상 기준으로 잡혀 키보드 뒤로 사라지고 스크롤 시 헤더/배경이 깨진다 — 커뮤니티 CommentSheet처럼
  // 댓글 시트를 document.body 로 포털해 escape 해야 한다. commentsOpen 블록이 createPortal(document.body) 로 감싸였는지 확인.
  ok("댓글 시트가 뷰어 서브트리 밖 document.body 로 포털 escape(containing-block 함정 회피, #877)",
    /commentsOpen &&\s*\n?\s*createPortal\(/.test(viewerSrc));
  ok("뷰어 자체 + 댓글 시트 둘 다 document.body 포털(포털 타겟 2개)",
    (viewerSrc.match(/createPortal\(/g) ?? []).length >= 2 &&
    (viewerSrc.match(/document\.body/g) ?? []).length >= 2);
  ok("body sibling 댓글 overlay가 뷰어 z-120보다 높은 shared overlay tier z-130",
    viewerSrc.includes("data-venue-story-comment-overlay") &&
    viewerSrc.includes("z-[130] bg-black/60"));
  ok("idle-visible → focus/inset-hidden → blur-settled-visible 3상태를 공용 keyboardOpen에 결속",
    viewerSrc.includes("isVenueStoryKeyboardOpen(composerFocused, kbInset)") &&
    /commentsOpen && keyboardOpen \? " hidden" : ""/.test(viewerSrc) &&
    /keyboardOpen && vvHeight != null/.test(viewerSrc));
  ok("댓글 백드롭이 스크롤/오버스크롤 전파 차단(touchAction:none + onTouchMove preventDefault) — 배경 밀림 방지",
    viewerSrc.includes('touchAction: "none"') &&
    /onTouchMove=\{\(e\) => \{\s*\n?\s*if \(e\.cancelable\) e\.preventDefault\(\);/.test(viewerSrc));

  // ⭐ 삼순 #884 왕복1+왕복2 NO-GO 반영: 댓글 열린 중에도 viewer 전용 강제 scroll-restore(visualViewport.scroll →
  // window.scrollTo)가 살아있으면 키보드 열린 상태에서 매 scroll 이벤트마다 반복 복원 → 지터. 기사 CommentSheet 엔
  // 이 루프가 없다. computeScrollRestore 가 suppressed(=댓글 오픈)면 전체 no-op, 아니면 window/html/body 각
  // 이탈을 독립 복원하는지(왕복2 blocker: window.scrollY 하나만 보고 short-circuit 금지) 런타임 검증.
  ok("[런타임] 댓글 오픈(suppressed) 중엔 전체 no-op(window/html/body 모두 이탈해도 복원 안 함)", (() => {
    const p = computeScrollRestore({ suppressed: true, windowScrollY: 999, pageYOffset: 999, htmlScrollTop: 88, bodyScrollTop: 77, savedScrollY: 0 });
    return p.scrollTo === false && p.htmlScrollTop === null && p.bodyScrollTop === null;
  })());
  ok("[런타임] not suppressed · 전체 정상(이탈 0)이면 복원 액션 없음", (() => {
    const p = computeScrollRestore({ suppressed: false, windowScrollY: 0, pageYOffset: 0, htmlScrollTop: 0, bodyScrollTop: 0, savedScrollY: 0 });
    return p.scrollTo === false && p.htmlScrollTop === null && p.bodyScrollTop === null;
  })());
  // 왕복2 핵심: window.scrollY 는 정상이어도 pageYOffset/html/body 중 하나만 이탈한 경로가 독립 복원되는지.
  ok("[런타임] not suppressed · pageYOffset-only 이탈 → scrollTo 복원(window.scrollY 정상이어도)", (() => {
    const p = computeScrollRestore({ suppressed: false, windowScrollY: 0, pageYOffset: 999, htmlScrollTop: 0, bodyScrollTop: 0, savedScrollY: 0 });
    return p.scrollTo === true && p.htmlScrollTop === null && p.bodyScrollTop === null;
  })());
  ok("[런타임] not suppressed · html-only 이탈 → htmlScrollTop 만 독립 복원", (() => {
    const p = computeScrollRestore({ suppressed: false, windowScrollY: 0, pageYOffset: 0, htmlScrollTop: 120, bodyScrollTop: 0, savedScrollY: 0 });
    return p.scrollTo === false && p.htmlScrollTop === 0 && p.bodyScrollTop === null;
  })());
  ok("[런타임] not suppressed · body-only 이탈 → bodyScrollTop 만 독립 복원", (() => {
    const p = computeScrollRestore({ suppressed: false, windowScrollY: 0, pageYOffset: 0, htmlScrollTop: 0, bodyScrollTop: 45, savedScrollY: 0 });
    return p.scrollTo === false && p.htmlScrollTop === null && p.bodyScrollTop === 0;
  })());
  ok("[런타임] lockRootScroll 이 commentsOpen getter 로 강제 복원 억제(commentsOpenRef 배선)",
    viewerSrc.includes("lockRootScroll(() => commentsOpenRef.current)") &&
    viewerSrc.includes("commentsOpenRef.current = commentsOpen"));
  {
    // 실제 scroll-lock.ts 소스가 (1) suppressed 분기를 computeScrollRestore 로 계산해 적용하고
    // (2) scroll/visualViewport.scroll listener 에 restoreLockedScroll 을 실제 배선했는지 확인(가드 살아있음).
    const scrollLockSrc = readFileSync(
      path.join(process.cwd(), "src/lib/venue-stories/scroll-lock.ts"),
      "utf8",
    );
    ok("scroll-lock 가 isCommentModalOpen getter + computeScrollRestore 로 restoreLockedScroll 계산",
      scrollLockSrc.includes("isCommentModalOpen") &&
      scrollLockSrc.includes("computeScrollRestore"));
    ok("scroll-lock 가 window.scroll + visualViewport.scroll 두 listener 에 restoreLockedScroll 배선",
      /window\.addEventListener\("scroll", restoreLockedScroll/.test(scrollLockSrc) &&
      /visualViewport\?\.addEventListener\("scroll", restoreLockedScroll/.test(scrollLockSrc));
  }

  const layoutSrc = readFileSync(path.resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
  ok("전역 viewport meta는 기존 resizes-content 유지(Android 범위 확장 없음)",
    layoutSrc.includes('interactiveWidget: "resizes-content"'));

  ok("80px 초과 세로 drag → 닫기",
    shouldCloseCommentSheetDrag({ armed: true, deltaX: 5, deltaY: 90 }));
  ok("짧은 drag → 유지",
    !shouldCloseCommentSheetDrag({ armed: true, deltaX: 5, deltaY: 60 }));
  ok("가로 drag → 유지",
    !shouldCloseCommentSheetDrag({ armed: true, deltaX: 90, deltaY: 100 }));
  ok("목록 스크롤로 arm 안 됨 → 유지",
    !shouldCloseCommentSheetDrag({ armed: false, deltaX: 0, deltaY: 120 }));
}

console.log("[rate limit 원자화 RPC 계약 — 삼순 #807 라운드3 blocker 1]");
{
  const sql = readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/20260723_venue_story_comments.sql"),
    "utf8",
  );
  const fnMatch = sql.match(
    /CREATE OR REPLACE FUNCTION venue_story_comment_post[\s\S]*?\$\$;\n/,
  );
  const fn = fnMatch?.[0] ?? "";
  ok("RPC 함수 venue_story_comment_post 존재", fn.length > 0);
  ok("유저별 advisory xact lock 으로 직렬화",
    fn.includes("pg_advisory_xact_lock(hashtext(p_user_id::text))"));
  ok("단일 함수 안에서 스토리 active/만료 게이트 수행",
    /status = 'active' AND expires_at > v_now/.test(fn));
  ok("단일 함수 안에서 10초/60초 rate 판정 수행",
    fn.includes("INTERVAL '10 seconds'") && fn.includes("INTERVAL '60 seconds'"));
  ok("단일 함수 안에서 동일내용(content_key 최근 5건) 판정 수행",
    /LIMIT 5[\s\S]*?content_key = p_content_key/.test(fn));
  ok("단일 함수 안에서 INSERT 까지 수행(판정+INSERT 단일 트랜잭션)",
    fn.includes("INSERT INTO venue_story_comments"));
  ok("advisory lock 이 게이트/판정/INSERT 보다 앞서 잡힌다",
    fn.indexOf("pg_advisory_xact_lock") < fn.indexOf("status = 'active'") &&
    fn.indexOf("pg_advisory_xact_lock") < fn.indexOf("INSERT INTO venue_story_comments"));
  ok("유저 최근 댓글 판정용 (user_id, created_at DESC) 인덱스 존재",
    /idx_venue_story_comments_user_recent\s+ON venue_story_comments \(user_id, created_at DESC\)/.test(sql));
  ok("RPC 클라 롤(anon/authenticated) 실행 차단(REVOKE)",
    /REVOKE ALL ON FUNCTION venue_story_comment_post[\s\S]*?FROM anon/.test(sql) &&
    /REVOKE ALL ON FUNCTION venue_story_comment_post[\s\S]*?FROM authenticated/.test(sql));

  // route 계약: POST 가 더 이상 개별 SELECT+INSERT 를 하지 않고 RPC 호출로 단일화
  const routeSrc = readFileSync(
    path.resolve(process.cwd(), "src/app/api/venue-stories/[id]/comments/route.ts"),
    "utf8",
  );
  ok("route POST 가 venue_story_comment_post RPC 를 호출",
    /\.rpc\(\s*"venue_story_comment_post"/.test(routeSrc));
  ok("route 에 개별 INSERT 잔류 0(원자성 우회 경로 없음)", !routeSrc.includes(".insert("));
  ok("route 에 유저 최근 댓글 사전 SELECT 잔류 0", !routeSrc.includes('.eq("user_id"'));
  ok("정규화 키를 route 가 계산해 RPC 로 전달(normalizeForFloodKey)",
    routeSrc.includes("normalizeForFloodKey(check.content)"));
  ok("RPC 오류 매핑: not_found→404 / rate·duplicate→429",
    /not_found[\s\S]*?404/.test(routeSrc) &&
    /duplicate[\s\S]*?429/.test(routeSrc) &&
    /"rate"[\s\S]*?429/.test(routeSrc));
}

console.log("[migration RLS 계약 — service_role 전용(정책 0개)]");
{
  const sql = readFileSync(
    path.resolve(process.cwd(), "supabase/migrations/20260723_venue_story_comments.sql"),
    "utf8",
  );
  const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
  ok("클라 RLS 정책 0개 — direct INSERT/SELECT 우회 경로 없음(venue_stories 동일 계약)",
    policies.length === 0);
  ok("RLS 활성화 유지(정책 없음 + RLS on = 클라 전면 차단)",
    /ALTER TABLE venue_story_comments ENABLE ROW LEVEL SECURITY/.test(sql));
  ok("authenticated 대상 GRANT 없음", !/GRANT[\s\S]*?TO authenticated/i.test(sql));
}

console.log("[상수 계약]");
ok("최대 길이 200", VENUE_STORY_COMMENT_MAX_LENGTH === 200);
ok("목록 조회 상한 유한(안전 limit)", Number.isInteger(VENUE_STORY_COMMENT_LIST_LIMIT) && VENUE_STORY_COMMENT_LIST_LIMIT > 0);

// ── 넘기기 탭 존 ↔ pill 경계 기하(삼순 #948 blocker 2): pill 경계 탭은 모달, goNext 0 ──
console.log("[탭 존 기하 — pill 경계는 모달(넘김 아님)]");
{
  // iPhone13(390×844) / Pixel7(412×915) 안전영역 가정.
  const devices = [
    { name: "iPhone13", w: 390, h: 844, safe: 34 },
    { name: "Pixel7", w: 412, h: 915, safe: 24 },
  ];
  for (const d of devices) {
    const cx = d.w / 2;
    const pillTop = d.h - (d.safe + STORY_PILL_BOTTOM_OFFSET + STORY_PILL_HEIGHT);
    const pillCenterY = d.h - (d.safe + STORY_PILL_BOTTOM_OFFSET + STORY_PILL_HEIGHT / 2);
    const navBottom = d.h - (d.safe + STORY_NAV_BOTTOM_OFFSET);
    // pill 중앙 탭 → 모달
    ok(`${d.name}: pill 중앙 탭 → pill(모달)`,
      classifyStoryTap({ viewportWidth: d.w, viewportHeight: d.h, safeBottom: d.safe, x: cx, y: pillCenterY }) === "pill");
    // pill 상단 경계(+1px) 탭 → 여전히 pill, 넘김 아님
    ok(`${d.name}: pill 상단 경계 탭 → pill(넘김 아님)`,
      classifyStoryTap({ viewportWidth: d.w, viewportHeight: d.h, safeBottom: d.safe, x: cx, y: pillTop + 1 }) === "pill");
    // pill 상단 바로 위 4px(갭) 탭 → none(넘김도 아님 — 예전 inset-y-0 회귀 방지)
    ok(`${d.name}: pill 위 갭 탭 → none(goNext 0)`,
      classifyStoryTap({ viewportWidth: d.w, viewportHeight: d.h, safeBottom: d.safe, x: cx, y: pillTop - 4 }) === "none");
    // 화면 중앙(넘기기 존 내부) 우측 탭 → next 정상
    ok(`${d.name}: 화면 중앙 우측 탭 → next`,
      classifyStoryTap({ viewportWidth: d.w, viewportHeight: d.h, safeBottom: d.safe, x: d.w * 0.8, y: d.h * 0.4 }) === "next");
    ok(`${d.name}: 화면 중앙 좌측 탭 → prev`,
      classifyStoryTap({ viewportWidth: d.w, viewportHeight: d.h, safeBottom: d.safe, x: d.w * 0.1, y: d.h * 0.4 }) === "prev");
    ok(`${d.name}: 넘기기 존 하단컷 위 = pill 상단(8px 갭 존재)`, navBottom < pillTop);
  }
}

// ── 헤더(닫기 X) 아래 넘기기 존 상단컷: X 근처 빗맞은 탭이 next 로 새지 않는다(하린아빠 7/31 iOS) ──
console.log("[탭 존 기하 — 헤더/닫기 X 영역은 넘김 아님]");
{
  // iOS 네이티브 런타임 safe-area-inset-top 최소 44px 폴백 기준 + env()=0 인 웹 기준 둘 다.
  const devices = [
    { name: "iPhone15(safeTop 47)", w: 393, h: 852, safeTop: 47, safe: 34 },
    { name: "웹(safeTop 0)", w: 390, h: 844, safeTop: 0, safe: 0 },
  ];
  for (const d of devices) {
    const at = (x: number, y: number) =>
      classifyStoryTap({
        viewportWidth: d.w,
        viewportHeight: d.h,
        safeBottom: d.safe,
        safeTop: d.safeTop,
        x,
        y,
      });
    // 헤더 컨트롤(닫기 X)은 top = safeTop+28 부터 44px → 그 세로 구간 우측 탭은 넘김 아님
    const headerTop = d.safeTop + 28;
    const xNearClose = d.w - 20; // 우상단 X 자리
    ok(`${d.name}: 닫기 X 중앙 높이 탭 → none(다음 스토리로 새지 않음)`,
      at(xNearClose, headerTop + 22) === "none");
    ok(`${d.name}: X 바로 아래 빗맞음(헤더 하단 경계) → none`,
      at(xNearClose, headerTop + 43) === "none");
    ok(`${d.name}: 헤더 상단(진행바 근처) 탭 → none`, at(xNearClose, d.safeTop + 8) === "none");
    // 컷 아래(헤더+80px 이후)는 정상 넘김 유지 — 넘기기 자체가 죽으면 안 된다
    ok(`${d.name}: 헤더 컷 바로 아래 우측 탭 → next(넘김 유지)`,
      at(xNearClose, d.safeTop + STORY_NAV_TOP_OFFSET + 1) === "next");
    ok(`${d.name}: 화면 중앙 좌측 탭 → prev(넘김 유지)`, at(d.w * 0.1, d.h * 0.5) === "prev");
    ok(`${d.name}: 헤더 컷(${STORY_NAV_TOP_OFFSET}px) ≥ 헤더 터치타깃 하단(28+44)`,
      STORY_NAV_TOP_OFFSET >= 28 + 44);
  }
}

// ── 1탭=1이동(인스타 동일): 짧은 탭은 즉시 이동, 길게 누르기는 일시정지(하린아빠 7/31 iOS) ──
console.log("[넘기기 제스처 — 짧은 탭 즉시 이동 / long-press 는 일시정지]");
{
  ok("정지 상태 짧은 탭(80ms, 0px) → 이동",
    isStoryNavTap({ elapsedMs: 80, deltaX: 0, deltaY: 0 }) === true);
  ok("살짝 흔들린 탭(120ms, 6px) → 이동(손떨림 허용)",
    isStoryNavTap({ elapsedMs: 120, deltaX: 4, deltaY: 4 }) === true);
  ok("long-press(400ms) → 이동 아님(일시정지 경로)",
    isStoryNavTap({ elapsedMs: 400, deltaX: 0, deltaY: 0 }) === false);
  ok(`경계값(${STORY_NAV_TAP_MAX_MS}ms) → 이동 아님(타이머와 동일 임계)`,
    isStoryNavTap({ elapsedMs: STORY_NAV_TAP_MAX_MS, deltaX: 0, deltaY: 0 }) === false);
  ok("스와이프(60ms, 40px) → 이동 아님",
    isStoryNavTap({ elapsedMs: 60, deltaX: 40, deltaY: 0 }) === false);
  ok("세로 스크롤(60ms, 30px) → 이동 아님",
    isStoryNavTap({ elapsedMs: 60, deltaX: 0, deltaY: 30 }) === false);
}

// ── 전송 제스처 상태기계(삼순 #948 blocker 1·2): 1탭=1POST, cancel/drag-out 0, trailing click 0중복, finally 뒤 2번째 ──
console.log("[전송 제스처 — pointerdown/up/cancel + 중복 가드]");
{
  const BTN = { left: 100, top: 700, right: 140, bottom: 740 };
  const inside = { clientX: 120, clientY: 720, bounds: BTN, isPrimary: true, button: 0 };

  // (1) 정상 1탭: down → up(버튼 위) → submit 승인 1회
  {
    const st = createPressState();
    markPressStart(st);
    ok("1탭: 버튼 위 primary pointerup → 제출 승인", shouldSubmitOnPointerUp(st, inside) === true);
    // 같은 press 재-up(중복 pointerup) → press 소비돼 false
    ok("1탭: 중복 pointerup → 미승인(press 소비)", shouldSubmitOnPointerUp(st, inside) === false);
  }
  // (2) pointercancel(스크롤 제스처) → 이후 up 미승인
  {
    const st = createPressState();
    markPressStart(st);
    cancelPress(st);
    ok("pointercancel 후 up → 미승인(0 POST)", shouldSubmitOnPointerUp(st, inside) === false);
  }
  // (3) drag-out: touch implicit-capture 로 버튼에서 up 나지만 좌표가 밖 → 미승인
  {
    const st = createPressState();
    markPressStart(st, { clientX: 120, clientY: 720 });
    ok("drag-out(버튼 밖 릴리즈) → 미승인(0 POST)",
      shouldSubmitOnPointerUp(st, { ...inside, clientX: 300, clientY: 900 }) === false);
  }
  // (3-b) 제자리 탭인데 이모지 키보드 개폐로 bounds 만 밀린 경우 → 승인(하린아빠 7/31 iOS 전송 씨힘).
  //       손가락은 안 움직였으므로 #948 drag-out 보호(위 3)를 깨지 않는다.
  {
    const st = createPressState();
    markPressStart(st, { clientX: 120, clientY: 720 });
    // 키보드가 올라와 버튼이 위로 260px 이동 → 릴리즈 좌표는 새 bounds 밖이지만 손가락은 제자리
    const shiftedBounds = { left: 100, top: 440, right: 140, bottom: 480 };
    ok("제자리 탭 + 레이아웃 shift(버튼 이동) → 승인(이모지 전송 회귀)",
      shouldSubmitOnPointerUp(st, {
        isPrimary: true, button: 0, clientX: 121, clientY: 721, bounds: shiftedBounds,
      }) === true);
  }
  // (3-c) origin 기록이 있어도 실제로 손가락이 많이 이동했으면 여전히 drag-out(회귀 고정)
  {
    const st = createPressState();
    markPressStart(st, { clientX: 120, clientY: 720 });
    ok("origin 기록 + 손가락 40px 이동 → 미승인(drag-out 보호 유지)",
      shouldSubmitOnPointerUp(st, { ...inside, clientX: 160, clientY: 760 }) === false);
  }
  // (4) 비-primary / 보조버튼 → 미승인
  {
    const st1 = createPressState(); markPressStart(st1);
    ok("비-primary 포인터 → 미승인", shouldSubmitOnPointerUp(st1, { ...inside, isPrimary: false }) === false);
    const st2 = createPressState(); markPressStart(st2);
    ok("보조 버튼(button>0) → 미승인", shouldSubmitOnPointerUp(st2, { ...inside, button: 2 }) === false);
  }
  // (5) up 없이 press 없음 상태의 up → 미승인
  {
    const st = createPressState();
    ok("press 없이 pointerup → 미승인", shouldSubmitOnPointerUp(st, inside) === false);
  }

  // 재진입 가드 순수 계약(canBeginCommentSubmit): lock/busy/내용/story 조건만 검증.
  // ⚠️ 실제 1탭=1POST / trailing click 0중복 / finally 뒤 2번째는 lock set/reset 수명이
  //   필요해 여기서 로컬 모사(posts++)하면 lock 제거도 green 인 false-green → 삼순 #948 5차 지적.
  //   실제 VenueStoryViewer 를 렌더해 native pointer→POST spy 로 검증하는 건
  //   scripts/qa/venue-story-comment-submit-render.ts (npm run qa:venue-story-comment-render).
  ok("lock 보유 중 미제출(trailing click/동시탭 차단 전제)",
    canBeginCommentSubmit({ hasStory: true, hasContent: true, busy: false, locked: true }) === false);
  ok("lock 해제 후 제출 가능(finally 뒤 2번째 전제)",
    canBeginCommentSubmit({ hasStory: true, hasContent: true, busy: false, locked: false }) === true);
  ok("내용 없으면 미제출", canBeginCommentSubmit({ hasStory: true, hasContent: false, busy: false, locked: false }) === false);
  ok("story 없으면 미제출", canBeginCommentSubmit({ hasStory: false, hasContent: true, busy: false, locked: false }) === false);
  ok("busy 중 미제출", canBeginCommentSubmit({ hasStory: true, hasContent: true, busy: true, locked: false }) === false);
}

// ── 컴포넌트 배선 가드(정적): 제출은 pointerup, pointerdown 은 preventDefault-only ──
console.log("[컴포넌트 배선 — pointerup 제출/ pointerdown preventDefault-only]");
{
  const viewerSrc2 = readFileSync(
    path.resolve(process.cwd(), "src/components/game/VenueStoryViewer.tsx"),
    "utf8",
  );
  ok("전송 버튼 onPointerUp 에서 shouldSubmitOnPointerUp 게이트",
    /onPointerUp=\{[\s\S]*?shouldSubmitOnPointerUp\(commentPressRef\.current/.test(viewerSrc2));
  ok("전송 버튼 onPointerCancel 로 press 취소",
    /onPointerCancel=\{\(\) => cancelPress\(commentPressRef\.current\)\}/.test(viewerSrc2));
  ok("pointerdown 은 preventDefault + markPressStart(origin 좌표) 만(즉시 handleCommentSubmit 호출 없음)",
    /onPointerDown=\{\(e\) => \{\s*e\.preventDefault\(\);\s*markPressStart\(commentPressRef\.current, \{ clientX: e\.clientX, clientY: e\.clientY \}\);\s*\}\}/.test(viewerSrc2));
  ok("handleCommentSubmit 가 canBeginCommentSubmit 로 재진입 가드",
    /canBeginCommentSubmit\(\{/.test(viewerSrc2));
  ok("넘기기 탭 존 bottom = safeBottomCalc(STORY_NAV_BOTTOM_OFFSET)",
    /bottom: safeBottomCalc\(STORY_NAV_BOTTOM_OFFSET\)/.test(viewerSrc2));
  // 하린아빠 7/31 iOS 3종
  ok("넘기기 탭 존 top = safe-area + STORY_NAV_TOP_OFFSET(헤더 아래에서 시작)",
    /top: `calc\(\$\{safeAreaInsetTop\} \+ \$\{STORY_NAV_TOP_OFFSET\}px\)`/.test(viewerSrc2));
  ok("넘기기 탭 존에 top-0 잔류 없음(헤더 밑으로 깔리지 않음)",
    !/absolute top-0 (left|right)-0 w-(1\/3|2\/3)/.test(viewerSrc2));
  ok("헤더 컨트롤(닫기/더보기/음소거) 44px 터치타깃(w-11 h-11)",
    (viewerSrc2.match(/className="w-11 h-11 flex items-center justify-center text-white\/90"/g) ?? []).length === 3);
  ok("헤더 컨트롤에 36px(w-9 h-9) 잔류 없음",
    !/className="w-9 h-9 flex items-center justify-center text-white\/90"/.test(viewerSrc2));
  ok("넘기기 존 pointerup 이 isStoryNavTap 기반 즉시 이동(1탭=1이동)",
    /onPointerUp=\{handleNavPointerUp\("prev"\)\}/.test(viewerSrc2)
      && /onPointerUp=\{handleNavPointerUp\("next"\)\}/.test(viewerSrc2)
      && /isStoryNavTap\(\{/.test(viewerSrc2));
  ok("long-press 만 일시정지(pointerdown 즉시 setPaused(true) 아님)",
    !/onPointerDown=\{\(\) => setPaused\(true\)\}/.test(viewerSrc2)
      && /navPauseTimerRef\.current = setTimeout\(/.test(viewerSrc2));
  ok("전송 버튼 disabled 는 busy 만(controlled 빈 값으로 잠그지 않음 — 이모지 회귀)",
    /disabled=\{commentBusy\}/.test(viewerSrc2));
  ok("제출 내용은 DOM value 폴백 포함(controlled state 만 신뢰하지 않음)",
    /commentInputRef\.current\?\.value/.test(viewerSrc2));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
