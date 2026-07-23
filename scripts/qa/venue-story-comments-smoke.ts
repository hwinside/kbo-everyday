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
  VENUE_STORY_COMMENT_MAX_LENGTH,
  VENUE_STORY_COMMENT_LIST_LIMIT,
  VENUE_STORY_COMMENT_COOLDOWN_MS,
  VENUE_STORY_COMMENT_WINDOW_MS,
  VENUE_STORY_COMMENT_MAX_IN_WINDOW,
  VENUE_STORY_COMMENT_DUP_RECENT,
} from "../../src/lib/venue-stories/comments";
import {
  computeKeyboardInset,
  subscribeKeyboardInset,
  type VisualViewportLike,
} from "../../src/lib/venue-stories/keyboard-inset";

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

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
